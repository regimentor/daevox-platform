import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabase } from '@daevox/db/testing';
import { SecretaryService } from '../src/domain/secretary/service.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters, turn } from './support/controlled-telegram.ts';

const message = (id: number) => ({
  id,
  chat_id: 7,
  date: Math.floor(Date.now() / 1000),
  is_outgoing: false,
  can_be_saved: true,
  sender_id: { '@type': 'messageSenderUser', user_id: 9 },
  content: { '@type': 'messageText', text: { text: `Message ${id}` } },
});
const chat = (id = 7, archived = false) => ({
  '@type': 'chat',
  id,
  title: `Chat ${id}`,
  type: { '@type': 'chatTypePrivate', user_id: id },
  positions: archived ? [{ list: { '@type': 'chatListArchive' }, order: '1' }] : [],
});

async function setup() {
  const fixture = testDatabase();
  const archive = fixture.open();
  const mock = new ControlledTelegram({ '@type': 'authorizationStateReady' });
  const telegram = new TelegramConnection({ parameters, createClient: () => mock.client() });
  await telegram.start();
  await turn();
  const secretary = new SecretaryService(telegram, fixture.url);
  const emit = (payload: object) =>
    mock.handlers!.onMessage({
      kind: 'update',
      clientId: mock.clientId,
      payload,
    });
  const pending = (type: string) => {
    const request = mock.requests.findLast((entry) => entry.request['@type'] === type);
    assert.ok(request, `Missing ${type}`);
    return request.requestId;
  };
  const observe = (enabled: boolean) =>
    secretary.setObservation('42', '7', enabled, {
      ...secretary.snapshot().context,
      observationVersion: archive.getObservation('42', '7')!.observationVersion,
    });
  const cleanup = async () => {
    await secretary.close();
    await telegram.close();
    archive.close();
    fixture.cleanup();
  };
  return { archive, mock, secretary, emit, pending, observe, cleanup };
}

test('account epochs isolate late catalog, history and profile responses, including returning to the same account', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.secretary.start();
  await turn();
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  f.observe(true);
  f.emit({ '@type': 'updateNewMessage', message: message(100) });
  await turn();
  // Advance the catalog to a pending getChat, independently of author requests.
  f.mock.result('loadChats', { '@type': 'error', code: 404, message: 'End' });
  await turn();
  f.mock.result('getChats', { chat_ids: [99] });
  await turn();
  const oldCatalog = f.pending('getChat');
  const oldHistory = f.pending('getChatHistory');
  const oldAuthor = f.pending('getUser');
  const epoch = f.secretary.snapshot().context.accountEpoch;
  f.mock.auth({ '@type': 'authorizationStateWaitPhoneNumber' });
  assert.equal(f.secretary.snapshot().context.accountId, null);
  assert.equal(f.secretary.snapshot().catalog.knownCount, 0);
  f.mock.auth({ '@type': 'authorizationStateReady' });
  await turn();
  assert.equal(f.secretary.snapshot().context.accountId, '42');
  assert.equal(f.secretary.snapshot().context.accountEpoch, epoch + 2);
  assert.notEqual(f.pending('getChatHistory'), oldHistory);
  assert.notEqual(f.pending('getUser'), oldAuthor);
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  const revision = f.secretary.snapshot().context.revision;
  f.mock.respond(oldCatalog, chat(99, true));
  f.mock.respond(oldHistory, { messages: [message(200)] });
  f.mock.respond(oldAuthor, {
    first_name: 'Stale',
    last_name: '',
    usernames: { active_usernames: [] },
  });
  await turn();
  assert.equal(f.secretary.snapshot().context.revision, revision);
  assert.equal(f.secretary.snapshot().error, null);
  assert.equal(f.archive.getObservation('42', '99'), null);
  assert.equal(f.archive.historyImport('42', '7')!.cursor, 0);
  assert.equal(f.archive.unresolvedAuthors('42').length, 1);
  // The old finally blocks must not clear the new operations' busy state.
  const historyCount = f.mock.count('getChatHistory');
  const authorCount = f.mock.count('getUser');
  f.mock.network('connectionStateReady');
  assert.equal(f.mock.count('getChatHistory'), historyCount);
  assert.equal(f.mock.count('getUser'), authorCount);
  f.mock.result('getUser', {
    first_name: 'Current',
    last_name: '',
    usernames: { active_usernames: [] },
  });
  f.mock.result('getChatHistory', { messages: [] });
  await turn();
  assert.equal(f.archive.unresolvedAuthors('42').length, 0);
  assert.equal(f.archive.historyImport('42', '7')!.status, 'ready');
  assert.ok(f.archive.dailySummaries('42', '7').length > 0);
});

test('close cancels pending requests without awaiting Telegram and is idempotent', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.secretary.start();
  await turn();
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  f.observe(true);
  f.emit({ '@type': 'updateNewMessage', message: message(100) });
  await turn();
  const history = f.pending('getChatHistory');
  const author = f.pending('getUser');
  const catalog = f.pending('loadChats');
  const closing = f.secretary.close();
  assert.equal(f.secretary.close(), closing);
  await closing;
  assert.equal(f.secretary.summaryDatabaseUrl, null);
  f.mock.respond(history, { messages: [message(200)] });
  f.mock.respond(author, { '@type': 'error', code: 500, message: 'Late failure' });
  f.mock.respond(catalog, { '@type': 'error', code: 500, message: 'Late failure' });
  await turn();
  assert.equal(f.archive.history('42', '7', null, null).messages.length, 1);
  assert.equal(f.archive.historyImport('42', '7')!.status, 'loading');
  assert.equal(f.archive.unresolvedAuthors('42').length, 1);
});

test('history deduplicates, rejects a stationary cursor, and resume bypasses cooldown', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.secretary.start();
  await turn();
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  f.observe(true);
  f.mock.network('connectionStateReady');
  f.observe(true);
  assert.equal(f.mock.count('getChatHistory'), 1);
  f.mock.result('getChatHistory', { messages: [message(500)] });
  await turn();
  f.mock.result('getChatHistory', { messages: [message(500)] });
  await turn();
  assert.equal(f.archive.historyImport('42', '7')!.status, 'error');
  const count = f.mock.count('getChatHistory');
  f.mock.network('connectionStateReady');
  assert.equal(f.mock.count('getChatHistory'), count);
  f.secretary.resume('42', '7', {
    ...f.secretary.snapshot().context,
    observationVersion: f.archive.getObservation('42', '7')!.observationVersion,
  });
  assert.equal(f.mock.count('getChatHistory'), count + 1);
  const cancelled = f.pending('getChatHistory');
  f.observe(false);
  f.observe(true);
  const current = f.pending('getChatHistory');
  assert.notEqual(current, cancelled);
  f.mock.respond(cancelled, { messages: [message(600)] });
  await turn();
  assert.deepEqual(
    f.archive.history('42', '7', null, null).messages.map((m) => m.id),
    ['500'],
  );
  f.mock.respond(current, { messages: [] });
  await turn();
  assert.equal(f.archive.historyImport('42', '7')!.status, 'ready');
});

test('scheduled refresh cancellation leaves history and author resolution running', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.archive.upsertChat('42', { id: '7', title: 'Chat 7', type: 'private' });
  f.archive.setObservation('42', '7', true, 0);
  f.archive.saveMessages([
    {
      accountId: '42',
      chatId: '7',
      messageId: '100',
      date: Math.floor(Date.now() / 1000),
      editDate: null,
      isOutgoing: false,
      authorKind: 'user',
      authorId: '9',
      authorName: null,
      authorUsername: null,
      text: 'Message 100',
      caption: null,
      mediaType: null,
      mediaId: null,
      replyChatId: null,
      replyMessageId: null,
      canBeSaved: true,
    },
  ]);
  // Start refresh directly so its catalog operation belongs to this signal.
  const abort = new AbortController();
  const refresh = f.secretary.refresh(abort.signal);
  const oldCatalog = f.pending('loadChats');
  const author = f.pending('getUser');
  abort.abort();
  await refresh;
  f.secretary.start();
  await turn();
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  assert.equal(f.mock.count('getChatHistory'), 1);
  assert.equal(f.mock.count('getUser'), 1);
  assert.notEqual(f.pending('loadChats'), oldCatalog);
  f.mock.respond(oldCatalog, { '@type': 'ok' });
  f.mock.result('getChatHistory', { messages: [] });
  f.mock.respond(author, { first_name: 'Author', last_name: '' });
  await turn();
  assert.equal(f.archive.historyImport('42', '7')!.status, 'ready');
  assert.equal(f.archive.unresolvedAuthors('42').length, 0);
});

test('catalog preserves archive filtering and live messages preserve captions and deletions', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.secretary.start();
  f.mock.result('loadChats', { '@type': 'error', code: 404, message: 'End' });
  await turn();
  f.mock.result('getChats', { chat_ids: [7] });
  await turn();
  f.mock.result('getChat', chat(7, true));
  await turn();
  assert.equal(f.secretary.chatsPage('', 'archived').chats[0].id, '7');
  f.observe(true);
  f.emit({
    '@type': 'updateNewMessage',
    message: {
      ...message(100),
      content: { '@type': 'messagePhoto', caption: { text: 'Caption' } },
    },
  });
  assert.equal(f.secretary.history('42', '7', false, null).messages[0].caption, 'Caption');
  f.emit({ '@type': 'updateNewMessage', message: { ...message(101), can_be_saved: false } });
  await turn();
  const protectedMessage = f.secretary
    .history('42', '7', false, null)
    .messages.find((m) => m.id === '101')!;
  assert.equal(protectedMessage.text, null);
  assert.equal(protectedMessage.skipped, true);
  f.emit({ '@type': 'updateDeleteMessages', chat_id: 7, message_ids: [100], is_permanent: true });
  await turn();
  assert.equal(f.secretary.history('42', '7', true, null).lastUpdate!.deleted, 1);
});

test('a different account starts importing while the previous account request is pending', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  f.archive.upsertChat('43', { id: '7', title: 'Other account', type: 'private' });
  f.archive.setObservation('43', '7', true, 0);
  f.secretary.start();
  f.emit({ '@type': 'updateNewChat', chat: chat() });
  f.observe(true);
  const previous = f.pending('getChatHistory');
  const send = f.mock.send.bind(f.mock);
  t.mock.method(
    f.mock,
    'send',
    (id: string, requestId: string, request: Record<string, unknown>) => {
      if (request['@type'] === 'getMe') {
        f.mock.respond(requestId, { '@type': 'user', id: 43, first_name: 'Other', last_name: '' });
      } else send(id, requestId, request);
    },
  );
  f.mock.auth({ '@type': 'authorizationStateWaitPhoneNumber' });
  f.mock.auth({ '@type': 'authorizationStateReady' });
  await turn();
  assert.equal(f.secretary.snapshot().context.accountId, '43');
  const current = f.pending('getChatHistory');
  assert.notEqual(current, previous);
  const revision = f.secretary.snapshot().context.revision;
  f.mock.respond(previous, { messages: [message(200)] });
  await turn();
  assert.equal(f.secretary.snapshot().context.revision, revision);
  assert.equal(f.archive.history('42', '7', null, null).messages.length, 0);
  assert.equal(f.archive.history('43', '7', null, null).messages.length, 0);
  f.mock.respond(current, { messages: [message(300)] });
  await turn();
  assert.deepEqual(
    f.archive.history('43', '7', null, null).messages.map((m) => m.id),
    ['300'],
  );
});

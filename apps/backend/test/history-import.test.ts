import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabase } from '@daevox/db/testing';
import { SecretaryService } from '../src/domain/secretary/service.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters, turn } from './support/controlled-telegram.ts';
const msg = (id: number, date: number) => ({
  id,
  chat_id: 7,
  date,
  is_outgoing: false,
  can_be_saved: true,
  content: { '@type': 'messageText', text: { text: `Message ${id}` } },
});

test('30-day history pages resume from the saved cursor and stop accepting writes after disabling', async () => {
  const fixture = testDatabase();
  const archive = fixture.open();
  archive.upsertChat('42', { id: '7', title: 'History', type: 'private' });
  const mock = new ControlledTelegram({ '@type': 'authorizationStateReady' });
  const telegram = new TelegramConnection({ parameters, createClient: () => mock.client() });
  await telegram.start();
  await turn();
  let secretary = new SecretaryService(telegram, fixture.url);
  secretary.start();
  const emitChat = () =>
    mock.handlers!.onMessage({
      kind: 'update',
      clientId: mock.clientId,
      payload: {
        '@type': 'updateNewChat',
        chat: {
          '@type': 'chat',
          id: 7,
          title: 'History',
          type: { '@type': 'chatTypePrivate', user_id: 7 },
          positions: [],
        },
      },
    });
  emitChat();
  await turn();
  try {
    secretary.setObservation('42', '7', true, {
      ...secretary.snapshot().context,
      observationVersion: 0,
    });
    await turn();
    const since = archive.historyImport('42', '7')!.since;
    mock.result('getChatHistory', { messages: [msg(500, since + 1000)] });
    await turn();
    assert.equal(archive.historyImport('42', '7')!.cursor, 500);
    assert.equal(archive.historyImport('42', '7')!.status, 'loading');
    const pending = mock.requests.findLast((r) => r.request['@type'] === 'getChatHistory')!;
    await secretary.close();
    mock.respond(pending.requestId, { messages: [msg(400, since + 100)] });
    await turn();
    assert.equal(archive.history('42', '7', null, null).messages.length, 1);
    secretary = new SecretaryService(telegram, fixture.url);
    secretary.start();
    emitChat();
    await turn();
    assert.equal(
      mock.requests.findLast((r) => r.request['@type'] === 'getChatHistory')!.request
        .from_message_id,
      500,
    );
    mock.result('getChatHistory', {
      messages: [msg(500, since + 1000), msg(300, since), msg(100, since - 1)],
    });
    await turn();
    assert.equal(archive.historyImport('42', '7')!.status, 'ready');
    assert.ok(archive.dailySummaries('42', '7').length > 0);
    assert.ok(archive.dailySummaries('42', '7').every((job) => job.status === 'queued'));
    assert.deepEqual(
      archive.history('42', '7', null, null).messages.map((m) => m.id),
      ['500', '300'],
    );
    secretary.setObservation('42', '7', false, {
      ...secretary.snapshot().context,
      observationVersion: 1,
    });
    secretary.setObservation('42', '7', true, {
      ...secretary.snapshot().context,
      observationVersion: 2,
    });
    await turn();
    secretary.setObservation('42', '7', false, {
      ...secretary.snapshot().context,
      observationVersion: 3,
    });
    mock.result('getChatHistory', { messages: [msg(700, since + 2000)] });
    await turn();
    assert.equal(archive.history('42', '7', null, null).messages.length, 2);
  } finally {
    await secretary.close();
    await telegram.close();
    archive.close();
    fixture.cleanup();
  }
});

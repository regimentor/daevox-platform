import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretaryService } from '../src/domain/secretary/service.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters, turn } from './support/controlled-telegram.ts';
import { testDatabase } from '@daevox/db/testing';

test('observed chats are independent of search and page limits, including observation command responses', async () => {
  const mock = new ControlledTelegram({ '@type': 'authorizationStateReady' });
  const telegram = new TelegramConnection({ parameters, createClient: () => mock.client() });
  await telegram.start();
  await turn();
  const database = testDatabase();
  const secretary = new SecretaryService(telegram, database.url);
  secretary.start();
  try {
    for (let id = 1; id <= 120; id++) {
      mock.handlers!.onMessage({
        kind: 'update',
        clientId: mock.clientId,
        payload: {
          '@type': 'updateNewChat',
          chat: {
            '@type': 'chat',
            id,
            title: `Chat ${String(id).padStart(3, '0')}`,
            type: { '@type': 'chatTypePrivate', user_id: id },
            positions: [],
          },
        },
      });
    }
    await turn();
    const context = secretary.snapshot().context;
    const enabled = secretary.setObservation('42', '120', true, {
      ...context,
      observationVersion: 0,
    });
    assert.equal(enabled.id, '120');
    assert.equal(enabled.enabled, true);
    for (const query of ['', 'Chat 120', 'no matches', '']) {
      const page = secretary.chatsPage(query);
      assert.deepEqual(
        page.observedChats.map((chat) => chat.id),
        ['120'],
      );
    }
    assert.equal(secretary.chatsPage().chats.length, 50);
    assert.ok(!secretary.chatsPage().chats.some((chat) => chat.id === '120'));
    assert.equal(secretary.history('42', '120', true, null).lastUpdate, null);
    mock.handlers!.onMessage({
      kind: 'update',
      clientId: mock.clientId,
      payload: {
        '@type': 'updateNewMessage',
        message: {
          id: 501,
          chat_id: 120,
          date: 123,
          is_outgoing: false,
          can_be_saved: true,
          sender_id: { '@type': 'messageSenderUser', user_id: 9 },
          content: { '@type': 'messageText', text: { text: 'Processed message' } },
        },
      },
    });
    await turn();
    const history = secretary.history('42', '120', true, null);
    assert.equal(history.lastUpdate!.saved, 1);
    assert.equal(history.messages[0].text, 'Processed message');
    assert.equal(secretary.chatsPage().observedChats[0].lastUpdate!.id, history.lastUpdate!.id);
    assert.throws(() => secretary.history('43', '120', true, null));
    secretary.setObservation('42', '120', false, {
      ...context,
      observationVersion: enabled.observationVersion,
    });
    assert.deepEqual(secretary.chatsPage().observedChats, []);
  } finally {
    await secretary.close();
    await telegram.close();
    database.cleanup();
  }
});

test('auto-reply enables observation once, has independent version, survives observation off and requires re-enable after logout', async () => {
  const mock = new ControlledTelegram({ '@type': 'authorizationStateReady' });
  const telegram = new TelegramConnection({ parameters, createClient: () => mock.client() });
  await telegram.start();
  await turn();
  const database = testDatabase();
  const secretary = new SecretaryService(telegram, database.url);
  secretary.start();
  try {
    mock.handlers!.onMessage({
      kind: 'update',
      clientId: mock.clientId,
      payload: {
        '@type': 'updateNewChat',
        chat: {
          '@type': 'chat',
          id: 10,
          title: 'Test',
          type: { '@type': 'chatTypePrivate', user_id: 7 },
          positions: [],
        },
      },
    });
    await turn();
    const context = secretary.snapshot().context;
    const enabled = secretary.setAutoReply('42', '10', true, { ...context, autoReplyVersion: 0 });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.autoReply.enabled, true);
    assert.throws(() =>
      secretary.setAutoReply('42', '10', false, { ...context, autoReplyVersion: 0 }),
    );
    const off = secretary.setObservation('42', '10', false, {
      ...context,
      observationVersion: enabled.observationVersion,
    });
    assert.equal(off.autoReply.enabled, true);
    assert.equal(off.enabled, false);
    const disabled = secretary.setAutoReply('42', '10', false, { ...context, autoReplyVersion: 1 });
    assert.equal(disabled.enabled, false);
    secretary.setAutoReply('42', '10', true, { ...context, autoReplyVersion: 2 });
    mock.auth({ '@type': 'authorizationStateLoggingOut' });
    await turn();
    const db = database.open();
    assert.equal(
      db.client
        .prepare('SELECT enabled FROM auto_reply_settings WHERE account_id=42 AND chat_id=10')
        .get()!.enabled,
      0,
    );
    db.close();
  } finally {
    await secretary.close();
    await telegram.close();
    database.cleanup();
  }
});

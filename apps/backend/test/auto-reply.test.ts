import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabase } from '@daevox/db/testing';
import { AutoReplyStore } from '@daevox/db';
import { TdlibError, type TdMessage } from '@daevox/tdlib';
import { AutoReplyService } from '../src/domain/auto-reply/service.ts';
import {
  eligible,
  signed,
  signature,
  phrases,
  type ReplyModelInput,
} from '../src/domain/auto-reply/content.ts';
import type { ReplyTelegram } from '../src/domain/auto-reply/telegram.ts';
import type { TelegramUpdate } from '../src/domain/telegram/connection.ts';
import { ModelScheduler } from '../src/domain/secretary/model-scheduler.ts';
import { archiveMessage } from '../src/domain/secretary/archive-message.ts';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await turn();
  }
  throw new Error('Controlled action did not start');
}
const message = (id = 1, text = 'Когда встреча?', chat = 10): TdMessage =>
  ({
    '@type': 'message',
    id,
    chat_id: chat,
    date: 1800000002,
    edit_date: 0,
    is_outgoing: false,
    sending_state: null,
    scheduling_state: null,
    import_info: null,
    is_channel_post: false,
    sender_id: { '@type': 'messageSenderUser', user_id: 7 },
    topic_id: null,
    can_be_saved: true,
    content: { '@type': 'messageText', text: { '@type': 'formattedText', text, entities: [] } },
  }) as unknown as TdMessage;
function fixture(
  generate: (input: ReplyModelInput, signal: AbortSignal) => Promise<string> = async () =>
    'Встреча в 12:00',
) {
  const database = testDatabase(),
    db = database.open();
  let now = 1800000000000,
    live: number | null = now,
    account = '42';
  let current: TdMessage = message();
  const updates = new Set<(update: TelegramUpdate) => void>(),
    states = new Set<() => void>();
  const requests: Array<Record<string, unknown>> = [];
  let sending: (request: Record<string, unknown>) => Promise<TdMessage> = async () => ({
    ...current,
    id: 1001,
    is_outgoing: true,
    sending_state: null,
  });
  let blocked = false,
    replyable = true,
    topicClosed = false;
  const telegram = {
    get replyLiveSince() {
      return live;
    },
    snapshot: () => ({ authorization: { kind: 'connected', account: { id: account } } }),
    onState: (listener: () => void) => {
      states.add(listener);
      return () => {
        states.delete(listener);
      };
    },
    onSecretaryUpdate: (listener: (update: TelegramUpdate) => void) => {
      updates.add(listener);
      return () => {
        updates.delete(listener);
      };
    },
    invokeRead: async (request: Record<string, unknown>) => {
      requests.push(request);
      switch (request['@type']) {
        case 'getChat':
          return {
            '@type': 'chat',
            id: request.chat_id,
            title: 'Тест',
            type: { '@type': 'chatTypePrivate', user_id: 7 },
            message_sender_id: null,
          };
        case 'canSendMessageToUser':
          return {
            '@type': blocked
              ? 'canSendMessageToUserResultUserHasPaidMessages'
              : 'canSendMessageToUserResultOk',
          };
        case 'getMessage':
          return { ...current, id: request.message_id, chat_id: request.chat_id };
        case 'getMessageProperties':
          return { can_be_replied: replyable };
        case 'getUser':
          return {
            first_name: 'Анна',
            last_name: 'Тест',
            usernames: { active_usernames: ['anna'] },
          };
        case 'getOption':
          return { value: '4096' };
        case 'getForumTopic':
          return { info: { is_closed: topicClosed, is_hidden: false } };
        case 'getMessageThread':
          return {};
        case 'sendMessage':
          return sending(request);
        case 'resendMessages':
          return { messages: [await sending(request)] };
        default:
          throw new Error(`Unexpected ${request['@type']}`);
      }
    },
  } as unknown as ReplyTelegram;
  for (const chat of ['10', '20'])
    db.upsertChat('42', { id: chat, title: 'Тест', type: 'private' });
  const scheduler = new ModelScheduler();
  const service = new AutoReplyService(db, telegram, scheduler, {
    now: () => now,
    generate,
    automaticTick: false,
  });
  service.store.configure('42', '10', true, 0, now);
  service.store.configure('42', '20', true, 0, now);
  const emit = (event: object) => {
    for (const listener of updates) listener(event as TelegramUpdate);
  };
  return {
    db,
    service,
    scheduler,
    requests,
    database,
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    set blocked(value: boolean) {
      blocked = value;
    },
    set replyable(value: boolean) {
      replyable = value;
    },
    set topicClosed(value: boolean) {
      topicClosed = value;
    },
    set sending(value: typeof sending) {
      sending = value;
    },
    emit,
    incoming: (value = current) => emit({ '@type': 'updateNewMessage', message: value }),
    network(value: number | null) {
      live = value;
      for (const listener of states) listener();
    },
    account(value: string) {
      account = value;
      for (const listener of states) listener();
    },
    summary(chat = '10', day = '2027-01-14', text = 'Встреча в 12:00') {
      db.client
        .prepare(`INSERT INTO daily_summaries (account_id,chat_id,day,utc_offset_minutes,status,text,message_count,source_hash)
        VALUES (42, ?, ?, 300, 'ready', ?, 1, 'hash')`)
        .run(Number(chat), day, text);
    },
    sent() {
      return requests.filter(
        (r) =>
          (r['@type'] === 'sendMessage' && r.reply_to !== null) || r['@type'] === 'resendMessages',
      );
    },
    row(id = 1, chat = '10') {
      return service.store.get('42', chat, id)!;
    },
    async close() {
      await service.close();
      db.close();
      database.cleanup();
    },
  };
}

test('signed reply uses latest day, account/chat isolation, exact Reply and forum; duplicate and own input ignored', async () => {
  const inputs: ReplyModelInput[] = [];
  const f = fixture(async (input) => {
    inputs.push(input);
    return 'Встреча в 12:00';
  });
  try {
    f.summary('10', '2027-01-14', 'Последняя сводка');
    f.summary('10', '2027-01-12', 'Старая сводка завершена позднее');
    f.summary('20', '2027-01-15', 'Другая переписка');
    f.current = { ...message(), topic_id: { '@type': 'messageTopicForum', forum_topic_id: 88 } };
    f.incoming();
    await f.service.tick();
    assert.equal(inputs[0].summary, 'Последняя сводка');
    assert.equal(f.sent().length, 1);
    const sent = f.sent()[0];
    assert.deepEqual(sent.topic_id, f.current.topic_id);
    assert.equal((sent.reply_to as { message_id: number }).message_id, 1);
    assert.match(
      JSON.stringify(sent.input_message_content),
      /Ответ от ИИ-секретаря для уважаемого @anna/,
    );
    assert.equal(f.row().state, 'succeeded');
    assert.equal(f.row().final_id, 1001);
    f.incoming();
    f.incoming({ ...message(2), is_outgoing: true });
    f.incoming(message(3, `${signature} @anna`));
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    assert.equal(f.db.history('42', '10', null, null).messages.length, 0);
  } finally {
    await f.close();
  }
});

test('empty archive and nontext input produce fixed replies without invoking model', async () => {
  const f = fixture(async () => {
    throw new Error('model must not run');
  });
  try {
    f.incoming();
    await f.service.tick();
    assert.match(JSON.stringify(f.sent()[0]), /Пока недостаточно данных/);
    f.current = { ...message(2), content: { '@type': 'messageSticker' } as TdMessage['content'] };
    f.incoming();
    await f.service.tick();
    assert.match(JSON.stringify(f.sent()[1]), /Пока могу обработать только текст/);
    assert.equal(f.db.dailySummaries('42', '10').length, 0);
  } finally {
    await f.close();
  }
});

test('one preparation serves multiple questions and completing or failing it never sends a second response', async () => {
  const f = fixture();
  try {
    f.db.saveMessages([archiveMessage('42', message(99, 'Встреча завтра'))]);
    f.incoming();
    await f.service.tick();
    f.current = message(2);
    f.incoming();
    await f.service.tick();
    assert.equal(f.db.dailySummaries('42', '10').length, 1);
    assert.match(JSON.stringify(f.sent()), /Саммари подготавливается/);
    const day = f.db.dailySummaries('42', '10')[0].day;
    f.db.updateDailySummary('42', '10', day, { status: 'error', error: 'test' });
    await f.service.tick();
    assert.equal(f.sent().length, 2);
    f.current = message(3);
    f.incoming();
    await f.service.tick();
    assert.match(JSON.stringify(f.sent()[2]), /Сейчас не удалось подготовить ответ/);
  } finally {
    await f.close();
  }
});

test('known source edit invalidates daily summary even if a newer old-day summary completes later', async () => {
  const f = fixture();
  try {
    const source = message(99, 'Старый факт');
    f.db.saveMessages([archiveMessage('42', source)]);
    f.db.enqueueDailySummaries('42', '10', 0);
    const day = f.db.dailySummaries('42', '10')[0].day;
    f.db.updateDailySummary('42', '10', day, {
      status: 'ready',
      source_hash: 'hash',
      text: 'Старый факт',
      message_count: 1,
    });
    f.db.saveMessages([
      archiveMessage('42', { ...source, content: message(99, 'Новый факт').content }),
    ]);
    f.incoming();
    await f.service.tick();
    assert.match(JSON.stringify(f.sent()[0]), /Саммари подготавливается/);
    assert.equal(f.db.dailySummaries('42', '10')[0].status, 'queued');
  } finally {
    await f.close();
  }
});

test('edit during generation replaces stale output without extending original deadline', async () => {
  let release!: (value: string) => void,
    calls = 0;
  const f = fixture(async () =>
    ++calls === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : 'Новый ответ',
  );
  try {
    f.summary();
    f.incoming();
    await until(() => !!release);
    const deadline = f.row().deadline;
    f.now += 10000;
    f.current = message(1, 'Изменённый вопрос');
    f.emit({
      '@type': 'updateMessageContent',
      chat_id: 10,
      message_id: 1,
      new_content: f.current.content,
    });
    release('Устаревший ответ');
    await f.service.tick();
    assert.equal(calls, 2);
    assert.equal(f.row().deadline, deadline);
    assert.equal(f.sent().length, 1);
    assert.match(JSON.stringify(f.sent()), /Новый ответ/);
    assert.doesNotMatch(JSON.stringify(f.sent()), /Устаревший ответ/);
  } finally {
    await f.close();
  }
});

for (const action of ['delete', 'disable', 'disconnect', 'account', 'deadline'] as const)
  test(`${action} during generation prevents transmission`, async () => {
    let release!: (value: string) => void;
    const f = fixture(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    try {
      f.summary();
      f.incoming();
      await until(() => !!release);
      if (action === 'delete')
        f.emit({
          '@type': 'updateDeleteMessages',
          chat_id: 10,
          message_ids: [1],
          is_permanent: true,
        });
      if (action === 'disable') f.service.configure('42', '10', false, 1);
      if (action === 'disconnect') f.network(null);
      if (action === 'account') f.account('43');
      if (action === 'deadline') f.now = f.row().deadline;
      release('Не отправлять');
      await f.service.tick();
      assert.equal(f.sent().length, 0);
    } finally {
      await f.close();
    }
  });

test('pending send correlates temporary/final IDs; late success after disconnect does not retry', async () => {
  const f = fixture();
  try {
    f.sending = async () => ({
      ...message(),
      id: -10,
      sending_state: { '@type': 'messageSendingStatePending', sending_id: 11 },
    });
    f.incoming();
    await f.service.tick();
    assert.equal(f.row().state, 'pending');
    assert.equal(f.row().temporary_id, -10);
    f.network(null);
    f.emit({
      '@type': 'updateMessageSendSucceeded',
      old_message_id: -10,
      message: { ...message(), id: 888, sending_state: null },
    });
    assert.equal(f.row().state, 'succeeded');
    assert.equal(f.row().final_id, 888);
    f.network(f.now + 1000);
    f.incoming();
    await f.service.tick();
    assert.equal(f.sent().length, 1);
  } finally {
    await f.close();
  }
});

test('unknown transport outcome is never retried and newer inputs continue', async () => {
  const f = fixture();
  try {
    f.sending = async () => {
      throw new Error('transport timeout');
    };
    f.incoming();
    await f.service.tick();
    assert.equal(f.row().state, 'unknown');
    f.incoming();
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    f.current = message(2);
    f.incoming();
    await f.service.tick();
    assert.equal(f.sent().length, 2);
  } finally {
    await f.close();
  }
});

test('definitive flood refusal waits requested delay and original deadline', async () => {
  const f = fixture();
  try {
    let count = 0;
    f.sending = async () => {
      if (!count++) throw new TdlibError(429, 'FLOOD_WAIT_10');
      return { ...message(), id: 1002 };
    };
    f.incoming();
    await f.service.tick();
    assert.equal(f.row().state, 'retry');
    f.now += 9999;
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    f.now++;
    await f.service.tick();
    assert.equal(f.sent().length, 2);
    assert.equal(f.row().state, 'succeeded');
  } finally {
    await f.close();
  }
});

test('backlog and boundary timestamps are skipped after reconnect', async () => {
  const f = fixture();
  try {
    f.incoming({ ...message(), date: f.now / 1000 });
    await f.service.tick();
    assert.equal(f.sent().length, 0);
    f.network(null);
    f.incoming(message(2));
    await f.service.tick();
    assert.equal(f.sent().length, 0);
    f.now += 10000;
    f.network(f.now);
    f.incoming(message(3));
    await f.service.tick();
    assert.equal(f.sent().length, 0);
    f.current = { ...message(4), date: f.now / 1000 + 1 };
    f.incoming();
    await f.service.tick();
    assert.equal(f.sent().length, 1);
  } finally {
    await f.close();
  }
});

for (const obstacle of ['payment', 'reply', 'topic'] as const)
  test(`${obstacle} prevents sending with no fallback to ordinary chat`, async () => {
    const f = fixture();
    try {
      if (obstacle === 'payment') f.blocked = true;
      if (obstacle === 'reply') f.replyable = false;
      if (obstacle === 'topic') {
        f.current = { ...message(), topic_id: { '@type': 'messageTopicForum', forum_topic_id: 9 } };
        f.topicClosed = true;
      }
      f.incoming();
      await f.service.tick();
      assert.equal(f.sent().length, 0);
      assert.ok(f.row().reason);
    } finally {
      await f.close();
    }
  });

test('persistent recovery cancels queued replies and marks handed-off delivery unknown', async () => {
  const f = fixture();
  try {
    const value = {
      account_id: 42,
      chat_id: 10,
      epoch: 'old',
      received_at: f.now,
      deadline: f.now + 300000,
      incoming: JSON.stringify(message()),
    };
    for (const [index, state] of ['queued', 'generating', 'retry', 'sending', 'pending'].entries())
      f.service.store.admit({ ...value, message_id: index + 1, state });
    const other = f.database.open();
    new AutoReplyStore(other).recover();
    other.close();
    assert.deepEqual(
      f.service.store.all('42').map((row) => row.state),
      ['cancelled', 'cancelled', 'cancelled', 'unknown', 'unknown'],
    );
    await f.service.tick();
    assert.equal(f.sent().length, 0);
    assert.equal(f.service.store.setting('43', '10').enabled, 0);
    f.service.store.logout('42');
    assert.equal(f.service.store.setting('42', '10').enabled, 0);
  } finally {
    await f.close();
  }
});

test('model scheduler completes running summary then prioritizes replies', async () => {
  const scheduler = new ModelScheduler(),
    signal = new AbortController().signal,
    order: string[] = [];
  let release!: () => void;
  const first = scheduler.run('summary', signal, async () => {
    order.push('summary1');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const second = scheduler.run('summary', signal, async () => {
    order.push('summary2');
  });
  const reply = scheduler.run('reply', signal, async () => {
    order.push('reply');
  });
  release();
  await Promise.all([first, second, reply]);
  assert.deepEqual(order, ['summary1', 'reply', 'summary2']);
});

test('signature includes fallback author, obeys UTF16 limit and does not split emojis; service events ignored', () => {
  const value = signed('😀'.repeat(4000), 'Анна', 3000);
  assert.ok(value.length <= 3000);
  assert.ok(value.endsWith(`${signature} Анна`));
  assert.ok(!value.includes('\ud83d\n'));
  assert.equal(
    eligible({ ...message(), content: { '@type': 'messageChatJoinByLink' } }, '42'),
    false,
  );
  assert.equal(
    phrases.text,
    'Пока могу обработать только текст. Пожалуйста, напишите вопрос сообщением',
  );
});

test('round-robin serves a third chat before returning to busy earlier chats', async () => {
  let release!: (value: string) => void,
    count = 0;
  const f = fixture(async () =>
    ++count === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : 'Ответ',
  );
  try {
    f.db.upsertChat('42', { id: '30', title: 'Третий чат', type: 'private' });
    f.service.store.configure('42', '30', true, 0, f.now);
    for (const chat of ['10', '20', '30']) f.summary(chat);
    f.incoming(message(1));
    await until(() => !!release);
    for (const [chat, id] of [
      [10, 2],
      [10, 3],
      [20, 1],
      [20, 2],
      [30, 1],
    ])
      f.incoming(message(id, 'Когда встреча?', chat));
    release('Ответ');
    await f.service.tick();
    assert.deepEqual(
      f
        .sent()
        .slice(0, 3)
        .map((request) => request.chat_id),
      [10, 20, 30],
    );
    assert.deepEqual(
      f
        .sent()
        .filter((request) => request.chat_id === 10)
        .map((request) => (request.reply_to as { message_id: number }).message_id),
      [1, 2, 3],
    );
  } finally {
    await f.close();
  }
});

test('failed pending send cannot retry after disable and re-enable', async () => {
  const f = fixture();
  try {
    f.sending = async () => ({
      ...message(),
      id: -10,
      sending_state: { '@type': 'messageSendingStatePending', sending_id: 11 },
    });
    f.incoming();
    await f.service.tick();
    f.service.configure('42', '10', false, 1);
    f.service.configure('42', '10', true, 2);
    f.emit({
      '@type': 'updateMessageSendFailed',
      old_message_id: -10,
      message: {
        ...message(),
        id: -11,
        sending_state: {
          '@type': 'messageSendingStateFailed',
          can_retry: true,
          retry_after: 0,
          required_paid_message_star_count: 0,
        },
      },
    });
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    assert.equal(f.row().state, 'failed');
  } finally {
    await f.close();
  }
});

test('source edit during model generation prevents use of stale facts', async () => {
  let release!: (value: string) => void;
  const f = fixture(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    const source = message(99, 'Старый факт');
    f.db.saveMessages([archiveMessage('42', source)]);
    f.db.enqueueDailySummaries('42', '10', 0);
    const day = f.db.dailySummaries('42', '10')[0].day;
    f.db.updateDailySummary('42', '10', day, {
      status: 'ready',
      source_hash: 'hash',
      text: 'Старый факт',
      message_count: 1,
    });
    f.incoming();
    await until(() => !!release);
    f.emit({
      '@type': 'updateMessageContent',
      chat_id: 10,
      message_id: 99,
      new_content: message(99, 'Новый факт').content,
    });
    release('Устаревшие факты');
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    assert.match(JSON.stringify(f.sent()), /Саммари подготавливается/);
  } finally {
    await f.close();
  }
});

test('crashed process leaves a durable journal; reopen never revives queued or ambiguous sends', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture();
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {ArchiveDatabase, AutoReplyStore} from '@daevox/db';
      const db = new ArchiveDatabase(process.env.AUTO_REPLY_TEST_DATABASE);
      const store = new AutoReplyStore(db);
      for (const [index, state] of ['queued', 'generating', 'retry', 'sending', 'pending'].entries()) {
        store.admit({account_id: 42, chat_id: 10, message_id: index + 1, epoch: 'crashed',
          received_at: 1, deadline: 9999999999999, incoming: '{}', state, temporary_id: state === 'pending' ? -77 : null});
      }
      process.exit(17);
    `,
      ],
      { env: { ...process.env, AUTO_REPLY_TEST_DATABASE: f.database.url }, encoding: 'utf8' },
    );
    assert.equal(child.status, 17, child.stderr);
    const reopened = f.database.open(),
      store = new AutoReplyStore(reopened);
    store.recover();
    assert.deepEqual(
      store.all('42').map((row) => row.state),
      ['cancelled', 'cancelled', 'cancelled', 'unknown', 'unknown'],
    );
    assert.equal(store.get('42', '10', 5)!.temporary_id, -77);
    assert.equal(store.setting('42', '10').enabled, 1);
    reopened.close();
    await f.service.tick();
    assert.equal(f.sent().length, 0);
  } finally {
    await f.close();
  }
});

test('TDLib failed delivery uses resend only after retry_after and never changes Reply or pays', async () => {
  const f = fixture();
  try {
    f.sending = async () => ({
      ...message(),
      id: -10,
      sending_state: { '@type': 'messageSendingStatePending', sending_id: 11 },
    });
    f.incoming();
    await f.service.tick();
    f.emit({
      '@type': 'updateMessageSendFailed',
      old_message_id: -10,
      message: {
        ...message(),
        id: -11,
        sending_state: {
          '@type': 'messageSendingStateFailed',
          can_retry: true,
          retry_after: 5,
          required_paid_message_star_count: 0,
          need_another_sender: false,
          need_another_reply_quote: false,
          need_drop_reply: false,
        },
      },
    });
    await f.service.tick();
    assert.equal(f.sent().length, 1);
    f.now += 5000;
    f.sending = async () => ({ ...message(), id: 2000 });
    await f.service.tick();
    assert.equal(f.sent()[1]['@type'], 'resendMessages');
    assert.deepEqual(f.sent()[1].message_ids, [-11]);
    assert.equal(f.sent()[1].paid_message_star_count, 0);
    assert.equal(f.row().state, 'succeeded');
  } finally {
    await f.close();
  }
});

test('model failure preserves localized service meaning and external signature', async () => {
  const f = fixture(async () => {
    throw new Error('model unavailable');
  });
  try {
    f.summary();
    f.current = message(1, 'Quand est la réunion ?');
    f.incoming();
    await f.service.tick();
    assert.match(JSON.stringify(f.sent()), /Impossible de préparer une réponse/);
    assert.match(JSON.stringify(f.sent()), /Ответ от ИИ-секретаря для уважаемого @anna/);
    assert.equal(f.service.status('42', '10').state, 'error');
  } finally {
    await f.close();
  }
});

test('setting transitions announce connection and disconnection in order without duplicating unchanged settings', async () => {
  const f = fixture();
  try {
    f.service.store.configure('42', '10', false, 1, f.now);
    f.service.configure('42', '10', true, 2);
    f.service.configure('42', '10', true, 3);
    f.service.configure('42', '10', false, 3);
    await f.service.noticesSettled();
    const notices = f.requests.filter(
      (request) => request['@type'] === 'sendMessage' && request.reply_to === null,
    );
    assert.equal(notices.length, 2);
    assert.match(JSON.stringify(notices[0]), /автоответчик подключён к этому чату/);
    assert.match(JSON.stringify(notices[1]), /автоответчик отключён от этого чата/);
    assert.equal(notices[1].chat_id, 10);
    assert.equal(
      (notices[1].options as { paid_message_star_count: number }).paid_message_star_count,
      0,
    );
    assert.equal(f.service.status('42', '10').enabled, false);
  } finally {
    await f.close();
  }
});

test('failed notification does not undo the setting, repeat a send, or cross accounts', async () => {
  const f = fixture();
  try {
    f.sending = async () => {
      throw new Error('uncertain transport');
    };
    f.service.configure('42', '10', false, 1);
    await f.service.noticesSettled();
    assert.equal(f.service.status('42', '10').enabled, false);
    assert.match(f.service.status('42', '10').reason!, /уведомления неизвестен/);
    f.service.configure('42', '10', false, 2);
    await f.service.noticesSettled();
    assert.equal(f.requests.filter((request) => request['@type'] === 'sendMessage').length, 1);
    f.service.configure('42', '10', true, 2);
    f.account('43');
    await f.service.noticesSettled();
    assert.equal(f.requests.filter((request) => request['@type'] === 'sendMessage').length, 1);
  } finally {
    await f.close();
  }
});

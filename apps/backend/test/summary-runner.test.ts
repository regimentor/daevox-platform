import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { testDatabase } from '@daevox/db/testing';
import { AppState } from '../src/app-state.ts';
import { createApplication } from '../src/application.ts';
import { TelegramConnection } from '../src/domain/telegram/connection.ts';
import { ControlledTelegram, parameters } from './support/controlled-telegram.ts';

test('worker resumes persisted daily jobs, respects local day boundaries and summarizes all chunks beyond 200 messages', async () => {
  const fixture = testDatabase();
  const db = fixture.open();
  let completions = 0;
  let held = Promise.withResolvers<void>();
  let hold = true;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'worker-test' }] }));
      return;
    }
    let raw = '';
    for await (const data of request) raw += data;
    const body = JSON.parse(raw);
    assert.ok(body.messages[0].content.includes('на русском'));
    completions++;
    if (hold) await held.promise;
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'Дневная сводка [№ 1].' } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previous = process.env.LLAMA_BASE_URL;
  process.env.LLAMA_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  const mock = new ControlledTelegram();
  class State extends AppState {
    constructor() {
      super(
        new TelegramConnection({ parameters, createClient: () => mock.client() }),
        undefined,
        fixture.url,
      );
    }
  }
  const app = createApplication(State);
  try {
    const date = Date.parse('2026-09-08T18:00:00Z') / 1000;
    const message = {
      accountId: '42',
      chatId: '7',
      messageId: '1',
      date,
      editDate: null,
      isOutgoing: false,
      authorKind: 'user' as const,
      authorId: '9',
      authorName: null,
      authorUsername: null,
      text: 'Подготовить отчёт. '.repeat(30),
      caption: null,
      mediaType: null,
      mediaId: null,
      replyChatId: null,
      replyMessageId: null,
      canBeSaved: true,
    };
    db.saveMessages([
      ...Array.from({ length: 205 }, (_, i) => ({ ...message, messageId: String(i + 1) })),
      { ...message, messageId: '206', date: Date.parse('2026-09-08T19:00:00Z') / 1000 },
    ]);
    db.enqueueDailySummaries('42', '7', date - 1);
    assert.equal(db.nextDailySummary(), null, 'wait for Telegram author profiles');
    assert.equal(db.unresolvedAuthors('42').length, 1);
    db.saveAuthor('42', 'user', 9, 'Test User', 'test_user');
    assert.equal(db.dailySummaryMessages('42', '7', '2026-09-08', 300)[0].author, '@test_user');
    assert.equal(db.history('42', '7', null, null).messages[0].author, '@test_user');
    assert.ok(db.summaryInput('42', '7', 'all').source.includes('@test_user'));
    assert.deepEqual(
      db.dailySummaries('42', '7').map((j) => j.day),
      ['2026-09-09', '2026-09-08'],
    );
    db.updateDailySummary('42', '7', '2026-09-08', { status: 'running' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    for (let i = 0; i < 300; i++) {
      if (completions > 0) break;
      await setTimeout(20);
    }
    assert.equal(completions, 1);
    await setTimeout(1200);
    assert.equal(completions, 1, 'scheduled ticks must not overlap a running summary job');
    hold = false;
    held.resolve();
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (db.dailySummaries('42', '7').every((j) => j.status === 'ready')) {
        ready = true;
        break;
      }
      await setTimeout(20);
    }
    assert.ok(ready, JSON.stringify(db.dailySummaries('42', '7')));
    const job = db.dailySummaries('42', '7').find((j) => j.day === '2026-09-08')!;
    assert.equal(job.message_count, 205);
    assert.ok(job.total_chunks > 1);
    assert.equal(job.completed_chunks, job.total_chunks);
    assert.ok(completions > 2);
    db.enqueueDailySummaries('42', '7', date - 1);
    assert.equal(db.nextDailySummary(), null);

    // A later tick must pick up new work even after the previous worker run drained the queue.
    held = Promise.withResolvers<void>();
    hold = true;
    const beforeRetry = completions;
    db.updateDailySummary('42', '7', '2026-09-08', { status: 'queued', text: null });
    for (let i = 0; i < 300; i++) {
      if (completions > beforeRetry) break;
      await setTimeout(20);
    }
    assert.equal(completions, beforeRetry + 1);
    await app.close();
    assert.equal(
      db.dailySummaries('42', '7').find((row) => row.day === '2026-09-08')!.status,
      'queued',
      'shutdown cancels the model request and returns unfinished work to the queue',
    );
    const afterClose = completions;
    await setTimeout(1200);
    assert.equal(completions, afterClose, 'closed application must not schedule more jobs');
  } finally {
    held.resolve();
    await app.close();
    db.close();
    fixture.cleanup();
    if (previous === undefined) delete process.env.LLAMA_BASE_URL;
    else process.env.LLAMA_BASE_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

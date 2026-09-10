import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { testDatabase } from '@daevox/db/testing';
import { ChatSummarizer } from '../src/domain/secretary/summarizer.ts';

test('OpenAI-compatible summaries persist, exclude protected content, detect changes and report incomplete output', async () => {
  const fixture = testDatabase();
  const db = fixture.open();
  let requests = 0;
  let finishReason = 'stop';
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'local-test' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    assert.equal(body.model, 'local-test');
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.ok(body.messages[1].content.includes('Встреча завтра'));
    assert.ok(!raw.includes('PROTECTED_SECRET'));
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: finishReason,
            message: { role: 'assistant', content: 'Встреча завтра [№ 1].' },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const summarizer = new ChatSummarizer(db, { baseURL: `http://127.0.0.1:${address.port}/v1` });
  const message = {
    accountId: '42',
    chatId: '7',
    messageId: '1',
    date: 123,
    editDate: null,
    isOutgoing: true,
    authorKind: 'user' as const,
    authorId: '42',
    authorName: 'Test',
    authorUsername: null,
    text: 'Встреча завтра',
    caption: null,
    mediaType: null,
    mediaId: null,
    replyChatId: null,
    replyMessageId: null,
    canBeSaved: true,
  };
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (summarizer.get('42', '7', 'all')?.status !== 'running') return;
      await setTimeout(10);
    }
    throw new Error('Summary did not finish');
  };
  try {
    assert.throws(() => summarizer.start('42', '7', 'all'), /NO_MESSAGES/);
    db.saveMessages([
      message,
      { ...message, messageId: '2', canBeSaved: false, text: 'PROTECTED_SECRET' },
    ]);
    assert.equal(summarizer.start('42', '7', 'all').status, 'running');
    assert.equal(summarizer.start('42', '7', 'all').status, 'running');
    await wait();
    assert.equal(requests, 1);
    assert.equal(summarizer.get('42', '7', 'all')!.text, 'Встреча завтра [№ 1].');
    const other = fixture.open();
    assert.equal(other.getSummary('42', '7', 'all')!.status, 'ready');
    other.close();
    db.saveMessages([{ ...message, messageId: '3' }]);
    assert.equal(summarizer.get('42', '7', 'all')!.stale, true);
    assert.equal(summarizer.get('42', '7', 'all')!.text, null);
    finishReason = 'length';
    summarizer.start('42', '7', 'all');
    await wait();
    assert.equal(summarizer.get('42', '7', 'all')!.status, 'error');
  } finally {
    await summarizer.close();
    db.close();
    fixture.cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

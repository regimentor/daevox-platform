import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArchiveDatabase } from '../src/index.ts';
import { pathToFileURL } from 'node:url';
import { pushTestDatabase, testDatabase } from '../test-support.ts';

test('observation changes and message writes survive reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daevox-db-'));
  const path = pathToFileURL(join(directory, 'archive.sqlite')).href;
  try {
    pushTestDatabase(path);
    const db = new ArchiveDatabase(path);
    db.upsertChat('42', { id: '-7', title: 'Notes', type: 'private' });
    const initial = db.getObservation('42', '-7')!;
    assert.equal(initial.enabled, false);
    db.setObservation('42', '-7', true, initial.observationVersion);
    db.saveMessages([
      {
        accountId: '42',
        chatId: '-7',
        messageId: '1',
        date: 10,
        editDate: null,
        isOutgoing: true,
        authorKind: 'user',
        authorId: '42',
        authorName: 'Test',
        authorUsername: null,
        text: 'hello',
        caption: null,
        mediaType: null,
        mediaId: null,
        replyChatId: null,
        replyMessageId: null,
        canBeSaved: true,
      },
    ]);
    db.close();
    const reopened = new ArchiveDatabase(path);
    assert.equal(reopened.listChats('42')[0].enabled, 1);
    const update = reopened.lastUpdate('42', '-7')!;
    assert.equal(update.saved, 1);
    assert.equal(update.status, 'processed');
    assert.ok(Number.isFinite(Date.parse(update.processedAt)));
    assert.equal(reopened.history('42', '-7', update.id, null).messages[0].text, 'hello');
    assert.equal(reopened.lastUpdate('43', '-7'), null);
    assert.deepEqual(reopened.history('43', '-7', null, null).messages, []);
    // Recreate the previous schema to verify upgrading a populated archive.
    reopened.client.exec(
      'DROP TABLE chat_updates; ALTER TABLE messages DROP COLUMN update_id; DELETE FROM schema_migrations WHERE version=2;',
    );
    reopened.close();
    pushTestDatabase(path);
    const migrated = new ArchiveDatabase(path);
    assert.equal(migrated.history('42', '-7', null, null).messages[0].text, 'hello');
    assert.equal(migrated.lastUpdate('42', '-7'), null);
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('history separates the latest update, paginates the archive, and redacts protected and deleted messages', () => {
  const fixture = testDatabase();
  const db = fixture.open();
  try {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      accountId: '42',
      chatId: '7',
      messageId: String(i + 1),
      date: 10,
      editDate: null,
      isOutgoing: false,
      authorKind: 'user' as const,
      authorId: '9',
      authorName: 'Test',
      authorUsername: null,
      text: 'message',
      caption: null,
      mediaType: null,
      mediaId: null,
      replyChatId: null,
      replyMessageId: null,
      canBeSaved: true,
    }));
    db.saveMessages(messages);
    const first = db.history('42', '7', null, null);
    assert.equal(first.messages.length, 50);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = db.history('42', '7', null, cursor, 10);
      assert.equal(page.messages.length, 10);
      ids.push(...page.messages.map((message) => message.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(
      ids,
      Array.from({ length: 60 }, (_, i) => String(60 - i)),
    );

    assert.equal(db.history('42', '7', null, first.nextCursor).messages.length, 10);
    db.saveMessages([
      { ...messages[0], canBeSaved: false },
      { ...messages[1], deleted: true },
    ]);
    const update = db.lastUpdate('42', '7')!;
    assert.equal(update.skipped, 1);
    assert.equal(update.deleted, 1);
    const latest = db.history('42', '7', update.id, null).messages;
    assert.equal(latest.length, 2);
    assert.ok(latest.every((m) => m.text === null));
    assert.equal(latest[0].deleted, true);
    assert.equal(latest[1].skipped, true);
    assert.throws(() => db.saveMessages([{ ...messages[0], messageId: 'invalid' }]));
    assert.equal(db.lastUpdate('42', '7')!.id, update.id);
  } finally {
    db.close();
    fixture.cleanup();
  }
});

test('daily summaries paginate by day in groups of ten within the selected chat and account', () => {
  const fixture = testDatabase();
  const db = fixture.open();
  try {
    const insert = db.client.prepare(
      'INSERT INTO daily_summaries(account_id, chat_id, day, utc_offset_minutes) VALUES(?, ?, ?, 300)',
    );
    for (let day = 1; day <= 23; day++)
      insert.run(42, 7, `2026-08-${String(day).padStart(2, '0')}`);
    insert.run(43, 7, '2026-09-01');
    insert.run(42, 8, '2026-09-01');
    const first = db.dailySummariesPage('42', '7', null, 10);
    const second = db.dailySummariesPage('42', '7', first.nextCursor, 10);
    const last = db.dailySummariesPage('42', '7', second.nextCursor, 10);
    assert.deepEqual(
      [first.summaries.length, second.summaries.length, last.summaries.length],
      [10, 10, 3],
    );
    assert.equal(last.nextCursor, null);
    assert.deepEqual(
      [...first.summaries, ...second.summaries, ...last.summaries].map((row) => row.day),
      Array.from({ length: 23 }, (_, i) => `2026-08-${String(23 - i).padStart(2, '0')}`),
    );
  } finally {
    db.close();
    fixture.cleanup();
  }
});

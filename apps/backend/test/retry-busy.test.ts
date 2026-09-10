import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testDatabase } from '@daevox/db/testing';
import { retryBusy } from '../src/domain/secretary/retry-busy.ts';

test('busy retry yields to the event loop and retries the real queue write', async () => {
  const fixture = testDatabase();
  const db = fixture.open(),
    writer = fixture.open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    db.client
      .exec(`INSERT INTO messages(account_id,chat_id,message_id,date,is_outgoing,can_be_saved,text)
      VALUES(1,1,1,1788912000,0,1,'hello')`);
    writer.client.exec('BEGIN IMMEDIATE');
    let released = false,
      attempts = 0;
    timer = setTimeout(() => {
      writer.client.exec('COMMIT');
      released = true;
    }, 150);
    await retryBusy(() => {
      attempts++;
      db.enqueueDailySummaries('1', '1', 0);
    });
    assert.equal(released, true);
    assert.ok(attempts > 1);
    assert.equal(db.dailySummaries('1', '1').length, 1);
    let failures = 0;
    await assert.rejects(
      retryBusy(() => {
        failures++;
        throw new Error('not a lock');
      }),
    );
    assert.equal(failures, 1);
    let cancelled = 0;
    await retryBusy(
      () => {
        cancelled++;
      },
      () => false,
    );
    assert.equal(cancelled, 0);
  } finally {
    clearTimeout(timer);
    writer.close();
    db.close();
    fixture.cleanup();
  }
});

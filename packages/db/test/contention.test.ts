import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { testDatabase } from '../test-support.ts';

test('daily queue insert survives a concurrent worker write', async () => {
  const fixture = testDatabase();
  const db = fixture.open();
  let worker: Worker | undefined;
  try {
    db.client
      .exec(`INSERT INTO messages(account_id,chat_id,message_id,date,is_outgoing,can_be_saved,text)
      VALUES(1,1,1,1788912000,0,1,'hello')`);
    worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const { fileURLToPath } = require('node:url');
      const db = new DatabaseSync(fileURLToPath(workerData));
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 40);
    `,
      { eval: true, workerData: fixture.url },
    );
    await once(worker, 'message');
    db.enqueueDailySummaries('1', '1', 0);
    assert.equal(db.dailySummaries('1', '1').length, 1);
  } finally {
    await worker?.terminate();
    db.close();
    fixture.cleanup();
  }
});

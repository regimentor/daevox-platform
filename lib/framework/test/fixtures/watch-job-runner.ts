import assert from 'node:assert/strict';
import { JobRunner } from '../../src/JobRunner.ts';
import EchoJob from './jobs/echo-job.ts';
import ProtocolJob from './jobs/protocol-job.ts';
import { WorkerTerminatedError } from '../../src/errors.ts';

const runner = new JobRunner({ poolSize: 1 });
try {
  for (let value = 0; value < 2; value++) {
    assert.deepEqual(await runner.run(EchoJob, { value }), { value });
  }
  await assert.rejects(
    runner.run(ProtocolJob, { id: -1, status: 'success' }),
    WorkerTerminatedError,
  );
  assert.equal(await runner.run(EchoJob, 3), 3);
  console.log('WATCH_JOB_PASS');
} finally {
  await runner.close();
}

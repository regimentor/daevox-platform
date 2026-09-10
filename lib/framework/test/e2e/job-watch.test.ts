import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Job Runner accepts Node watch dependency reports and reuses the worker', async () => {
  const child = spawn(
    process.execPath,
    ['--watch', fileURLToPath(new URL('../fixtures/watch-job-runner.ts', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Watch job timeout: ${output}`)), 10000);
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Worker violated the job protocol')) {
          clearTimeout(timeout);
          reject(new Error(output));
        } else if (output.includes('WATCH_JOB_PASS')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`Watch exited before success: ${output}`));
      });
    });
    assert.ok(output.includes('WATCH_JOB_PASS'), output);
  } finally {
    child.kill();
    await exited;
  }
});

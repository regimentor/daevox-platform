import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

function runHarness(outputDir, injectLeak) {
  const childArguments = [
    '--expose-gc',
    'test/soak/run.js',
    '--mode',
    'short',
    '--duration-ms',
    '1200',
    '--warmup-ms',
    '250',
    '--sample-interval-ms',
    '100',
    '--output-dir',
    outputDir,
    '--event-error-every',
    '17',
  ];
  if (injectLeak) childArguments.push('--inject-leak', injectLeak);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArguments, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      }),
    );
  });
}

async function artifactFrom(result) {
  const match = result.stdout.match(/^artifact: (.+)$/m);
  assert.ok(match, result.stdout || result.stderr);
  return JSON.parse(await readFile(match[1], 'utf8'));
}

test(
  'short soak harness records mixed load and returns all resources',
  { timeout: 15_000 },
  async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'daevox-soak-pass-'));
    const result = await runHarness(outputDir);
    const artifact = await artifactFrom(result);

    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(artifact.analysis.passed, true);
    assert.equal(artifact.schemaVersion, 2);
    assert.ok(artifact.samples.length >= 5);
    assert.ok(artifact.summary.operations.http.successes > 0);
    assert.ok(artifact.summary.operations.websocket.successes > 0);
    assert.ok(artifact.summary.operations.jobSuccess.successes > 0);
    assert.ok(artifact.summary.operations.jobCancelled.successes > 0);
    assert.ok(artifact.summary.operations.jobTimeout.successes > 0);
    assert.equal(artifact.lifecycle.connected, artifact.lifecycle.disconnected);
    assert.equal(
      artifact.summary.applicationEvents.accepted,
      artifact.summary.applicationEvents.handled,
    );
    assert.ok(artifact.summary.applicationEvents.expectedErrors > 0);
    assert.equal(
      artifact.summary.applicationEvents.expectedErrors,
      artifact.summary.applicationEvents.observedErrors,
    );
    assert.equal(artifact.summary.applicationEvents.duplicates, 0);
    assert.equal(artifact.summary.applicationEvents.fifoViolations, 0);
    assert.equal(artifact.analysis.thresholds.applicationEvents.status, 'passed');
    assert.deepEqual(artifact.analysis.thresholds.resourcesReturned.excess, {
      activeHandles: 0,
      connections: 0,
      listeners: 0,
      timers: 0,
      workers: 0,
    });
  },
);

for (const resource of ['listener', 'timer', 'socket']) {
  test(`soak harness control detects a retained ${resource}`, { timeout: 15_000 }, async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), `daevox-soak-${resource}-`));
    const result = await runHarness(outputDir, resource);
    const artifact = await artifactFrom(result);

    assert.equal(result.code, 1, result.stderr);
    assert.equal(artifact.analysis.thresholds.resourcesReturned.status, 'failed');
    const field = resource === 'socket' ? 'connections' : `${resource}s`;
    assert.ok(artifact.analysis.thresholds.resourcesReturned.excess[field] > 0);
    assert.ok(artifact.diagnosticsPath);
  });
}

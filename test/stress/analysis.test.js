import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { classifySteps } from './analysis.js';
import { createShutdownChaosPlan, createStressConfig } from './config.js';

const execFileAsync = promisify(execFile);

test('stress profile enforces explicit safety limits', () => {
  const config = createStressConfig({
    maxConcurrency: 8,
    maxConnections: 12,
    maxDurationMs: 10_000,
    maxMemoryBytes: 128 * 1024 * 1024,
    maxWorkers: 4,
    stepConcurrency: [1, 4, 8],
    stepDurationMs: 250,
  });

  assert.deepEqual(config.steps, [
    { concurrency: 1, durationMs: 250 },
    { concurrency: 4, durationMs: 250 },
    { concurrency: 8, durationMs: 250 },
  ]);
  assert.equal(config.limits.maxConnections, 12);
  assert.equal(config.limits.maxWorkers, 4);
  assert.equal(config.eventShutdownIterations, 20);
  assert.equal(config.eventChaosSeed, 0x0dae_2026);
  assert.throws(
    () => createStressConfig({ maxConcurrency: 4, stepConcurrency: [1, 5] }),
    /maxConcurrency/,
  );
  assert.throws(
    () => createStressConfig({ maxDurationMs: 100, stepDurationMs: 101 }),
    /maxDurationMs/,
  );
  assert.throws(() => createStressConfig({ eventChaosSeed: 0 }), /eventChaosSeed/);
  assert.throws(
    () => createStressConfig({ eventShutdownIterations: 0 }),
    /eventShutdownIterations/,
  );
});

test('stress analysis identifies sustained degradation and recovery', () => {
  const result = classifySteps(
    [
      { errorRate: 0, latencyMs: { p95: 10 }, queueWaitMs: { p95: 1 } },
      { errorRate: 0, latencyMs: { p95: 12 }, queueWaitMs: { p95: 2 } },
      { errorRate: 0.2, latencyMs: { p95: 35 }, queueWaitMs: { p95: 8 } },
    ],
    {
      maxErrorRate: 0.05,
      maxLatencyRatio: 2,
      maxQueueWaitRatio: 4,
      recovery: {
        errorRate: 0,
        latencyMs: { p95: 13 },
        queueWaitMs: { p95: 2 },
      },
    },
  );

  assert.deepEqual(result, {
    firstDegradedStep: 2,
    lastStableStep: 1,
    recovery: 'recovered',
  });
});

test('shutdown chaos seed reproduces producer decisions', () => {
  const first = createShutdownChaosPlan(1234, 4);
  const replay = createShutdownChaosPlan(1234, 4);

  assert.deepEqual(replay, first);
  assert.notDeepEqual(createShutdownChaosPlan(1235, 4), first);
  assert.equal(first.length, 4);
  assert.ok(first.every(({ closeDelayMs }) => closeDelayMs >= 0 && closeDelayMs <= 2));
});

test('stress recovery accounts for Worker threads retained by the pool', () => {
  const mib = 1024 * 1024;
  const result = classifySteps(
    [
      {
        errorRate: 0,
        heapUsedBytes: { end: 10 * mib },
        latencyMs: { p95: 2 },
        queueWaitMs: { p95: 0.1 },
        rssBytes: { end: 100 * mib },
        workers: 1,
      },
      {
        errorRate: 0,
        heapUsedBytes: { end: 12 * mib },
        latencyMs: { p95: 3 },
        queueWaitMs: { p95: 0.2 },
        rssBytes: { end: 300 * mib },
        workers: 14,
      },
    ],
    {
      maxErrorRate: 0.05,
      maxLatencyRatio: 3,
      maxQueueWaitRatio: 4,
      maxRecoveryHeapGrowthBytes: 32 * mib,
      maxRecoveryRssGrowthBytes: 64 * mib,
      recovery: {
        errorRate: 0,
        heapUsedBytes: { end: 12 * mib },
        latencyMs: { p95: 2 },
        queueWaitMs: { p95: 0.1 },
        rssBytes: { end: 300 * mib },
        settledMemory: { heapUsedBytes: 11 * mib, rssBytes: 300 * mib },
      },
      recoveryLatencyRatio: 2,
      recoveryQueueWaitRatio: 2,
      recoveryRssPerWorkerBytes: 16 * mib,
    },
  );

  assert.equal(result.recovery, 'recovered');
});

test('stress harness records exact application-event throughput accounting', async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'daevox-stress-events-'));
  const outputPath = path.join(outputDirectory, 'artifact.json');
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      'test/stress/run.js',
      '--mode',
      'smoke',
      '--steps',
      '1',
      '--step-ms',
      '150',
      '--event-chaos-seed',
      '1234',
      '--output',
      outputPath,
    ],
    { timeout: 20_000 },
  );
  const artifactPath = /^Stress artifact: (.+)$/m.exec(stdout)?.[1];
  assert.ok(artifactPath, `stress runner did not report an artifact path:\n${stdout}`);
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const profile = artifact.profiles['application-event-throughput'];

  assert.equal(profile.accounting.accepted, profile.accounting.handled);
  assert.equal(profile.accounting.duplicates, 0);
  assert.equal(profile.accounting.fifoViolations, 0);
  assert.equal(profile.accounting.expectedErrors, profile.accounting.observedErrors);
  assert.ok(profile.accounting.accepted > 0);
  assert.ok(profile.steps[0].metrics.eventQueueWaitMs.p95 >= 0);

  const chaos = artifact.profiles['application-event-shutdown-chaos'];
  assert.equal(chaos.iterations.length, 4);
  assert.equal(chaos.seed, 1234);
  assert.deepEqual(chaos.decisions, createShutdownChaosPlan(artifact.config.eventChaosSeed, 4));
  assert.equal(chaos.seed, artifact.config.eventChaosSeed);
  for (const iteration of chaos.iterations) {
    assert.equal(
      iteration.accepted,
      iteration.handled + iteration.dropped + iteration.abortedActive,
    );
    assert.equal(iteration.duplicates, 0);
    assert.equal(iteration.unhandledRejections, 0);
  }
});

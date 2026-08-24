import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySteps } from './analysis.js';
import { createStressConfig } from './config.js';

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
  assert.throws(
    () => createStressConfig({ maxConcurrency: 4, stepConcurrency: [1, 5] }),
    /maxConcurrency/,
  );
  assert.throws(
    () => createStressConfig({ maxDurationMs: 100, stepDurationMs: 101 }),
    /maxDurationMs/,
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSoak, linearSlopePerMinute } from './analysis.js';
import { createSoakConfig } from './config.js';

const MIB = 1024 * 1024;

function sample(index, overrides = {}) {
  return {
    activeHandles: 6,
    connections: 2,
    elapsedMs: index * 60_000,
    heapUsedBytes: 20 * MIB,
    latencyMs: { p95: 10, p99: 15 },
    listeners: 0,
    rssBytes: 100 * MIB,
    timers: 0,
    workers: 2,
    ...overrides,
  };
}

test('soak profiles bound local and scheduled execution explicitly', () => {
  const short = createSoakConfig('short');
  const scheduled = createSoakConfig('scheduled');

  assert.ok(short.durationMs <= 10_000);
  assert.ok(short.timeoutMs > short.durationMs);
  assert.ok(scheduled.durationMs >= 3 * 60 * 60 * 1_000);
  assert.ok(scheduled.timeoutMs > scheduled.durationMs);
  assert.ok(scheduled.sampleIntervalMs > short.sampleIntervalMs);
  assert.equal(short.eventErrorEvery, 257);
  assert.equal(scheduled.eventErrorEvery, 257);
  assert.equal(scheduled.thresholds.maxHeapSlopeBytesPerMinute, 256 * 1024);
  assert.equal(scheduled.thresholds.maxRssSlopeBytesPerMinute, 512 * 1024);
  assert.throws(() => createSoakConfig('short', { eventErrorEvery: 0 }), /eventErrorEvery/);
});

test('memory slope excludes warm-up and reports bytes per minute', () => {
  const samples = [
    sample(0, { rssBytes: 80 * MIB }),
    sample(1, { rssBytes: 120 * MIB }),
    sample(2, { rssBytes: 120 * MIB }),
    sample(3, { rssBytes: 121 * MIB }),
    sample(4, { rssBytes: 122 * MIB }),
  ];

  assert.equal(linearSlopePerMinute(samples.slice(2), 'rssBytes'), MIB);
});

test('soak analysis tolerates a heap step but detects sustained memory and latency degradation', () => {
  const samples = [
    sample(0),
    sample(1, { heapUsedBytes: 30 * MIB }),
    sample(2, { heapUsedBytes: 30 * MIB }),
    sample(3, { heapUsedBytes: 31 * MIB, latencyMs: { p95: 14, p99: 24 } }),
    sample(4, { heapUsedBytes: 32 * MIB, latencyMs: { p95: 16, p99: 27 } }),
    sample(5, { heapUsedBytes: 33 * MIB, latencyMs: { p95: 18, p99: 30 } }),
  ];
  const thresholds = {
    maxHeapSlopeBytesPerMinute: 512 * 1024,
    maxLatencyP95Ratio: 1.35,
    maxLatencyP99Ratio: 1.5,
    maxRssSlopeBytesPerMinute: MIB,
    minMonotonicGrowthRatio: 0.75,
  };

  const analysis = analyzeSoak(samples, {
    baselineResources: sample(0),
    finalResources: sample(6),
    thresholds,
    warmupMs: 2 * 60_000,
  });

  assert.equal(analysis.thresholds.heapSlope.status, 'failed');
  assert.equal(analysis.thresholds.rssSlope.status, 'passed');
  assert.equal(analysis.thresholds.latencyP95.status, 'failed');
  assert.equal(analysis.thresholds.latencyP99.status, 'failed');
  assert.equal(analysis.thresholds.resourcesReturned.status, 'passed');
  assert.equal(analysis.passed, false);
});

test('final resource audit detects retained listener, timer, socket or Worker', () => {
  const baseline = sample(0);

  for (const field of ['listeners', 'timers', 'connections', 'workers']) {
    const finalResources = { ...baseline, [field]: baseline[field] + 1 };
    const result = analyzeSoak([sample(0), sample(1)], {
      baselineResources: baseline,
      finalResources,
      thresholds: createSoakConfig('short').thresholds,
      warmupMs: 0,
    });
    assert.equal(result.thresholds.resourcesReturned.status, 'failed', field);
    assert.ok(result.thresholds.resourcesReturned.excess[field] > 0, field);
  }
});

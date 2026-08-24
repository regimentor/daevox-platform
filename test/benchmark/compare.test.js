import assert from 'node:assert/strict';
import test from 'node:test';

import { compareBenchmark } from './compare.js';

function artifact({ fingerprint = 'same', latency = 10, throughput = 100 } = {}) {
  return {
    environment: { fingerprint },
    mode: 'full',
    profiles: {
      job: {
        metrics: {
          errorRate: 0,
          executionLatencyMs: { p95: latency },
          latencyMs: { p95: latency },
          queueLatencyMs: { p95: latency },
          throughputPerSecond: throughput,
        },
      },
    },
  };
}

test('benchmark regression gate пропускает только сопоставимую среду', () => {
  const result = compareBenchmark(artifact({ fingerprint: 'current' }), artifact());

  assert.deepEqual(result, {
    status: 'skipped',
    reasons: ['environment fingerprint differs from baseline'],
  });
});

test('сопоставимый benchmark в пределах порогов проходит regression gate', () => {
  const result = compareBenchmark(
    artifact({ latency: 12, throughput: 80 }),
    artifact({ latency: 10, throughput: 100 }),
  );

  assert.deepEqual(result, { status: 'passed', reasons: [] });
});

test('искусственная задержка проваливает относительный regression gate', () => {
  const baseline = artifact();
  const delayed = artifact({ latency: 20, throughput: 50 });

  const result = compareBenchmark(delayed, baseline);

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.reasons, [
    'job: throughput dropped by 50.0%',
    'job: p95 latency increased by 100.0%',
    'job: queueLatencyMs p95 increased by 100.0%',
    'job: executionLatencyMs p95 increased by 100.0%',
  ]);
});

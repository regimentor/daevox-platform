import { availableParallelism } from 'node:os';

const MIB = 1024 * 1024;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

export function createShutdownChaosPlan(seed, iterations) {
  positiveInteger(seed, 'eventChaosSeed');
  positiveInteger(iterations, 'eventShutdownIterations');
  const random = seededRandom(seed);
  return Array.from({ length: iterations }, () => {
    const operationCount = 3 + (random() % 6);
    const producers = Array.from({ length: operationCount }, () =>
      random() % 2 === 0 ? 'http' : 'websocket',
    );
    return { closeDelayMs: random() % 3, producers };
  });
}

export function createStressConfig(overrides = {}) {
  const cpuCount = availableParallelism();
  const limits = {
    maxConcurrency: overrides.maxConcurrency ?? 24,
    maxConnections: overrides.maxConnections ?? 128,
    maxDurationMs: overrides.maxDurationMs ?? 120_000,
    maxMemoryBytes: overrides.maxMemoryBytes ?? 768 * MIB,
    maxWorkers: overrides.maxWorkers ?? cpuCount + 1,
  };
  for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);

  const stepDurationMs = positiveInteger(overrides.stepDurationMs ?? 1_000, 'stepDurationMs');
  const stepConcurrency = overrides.stepConcurrency ?? [1, 4, 8, 16, 24];
  if (!Array.isArray(stepConcurrency) || stepConcurrency.length === 0) {
    throw new TypeError('stepConcurrency must be a non-empty array');
  }
  const normalizedConcurrency = stepConcurrency.map((value) =>
    positiveInteger(value, 'step concurrency'),
  );
  if (normalizedConcurrency.some((value) => value > limits.maxConcurrency)) {
    throw new RangeError('step concurrency exceeds maxConcurrency');
  }
  if (stepDurationMs * normalizedConcurrency.length > limits.maxDurationMs) {
    throw new RangeError('steps exceed maxDurationMs');
  }

  const nearCpu = Math.min(cpuCount, limits.maxWorkers);
  const aboveCpu = Math.min(cpuCount + 1, limits.maxWorkers);
  const poolSizes = [...new Set([1, nearCpu, aboveCpu])];
  const queueSize = positiveInteger(overrides.queueSize ?? 32, 'queueSize');
  const eventChaosSeed = positiveInteger(overrides.eventChaosSeed ?? 0x0dae_2026, 'eventChaosSeed');
  const eventShutdownIterations = positiveInteger(
    overrides.eventShutdownIterations ?? 20,
    'eventShutdownIterations',
  );

  return {
    cpuCount,
    eventChaosSeed,
    eventShutdownIterations,
    jobDurationsMs: { long: 40, short: 2 },
    limits,
    poolSizes,
    queueSize,
    recoveryDurationMs: overrides.recoveryDurationMs ?? stepDurationMs,
    steps: normalizedConcurrency.map((concurrency) => ({
      concurrency,
      durationMs: stepDurationMs,
    })),
    thresholds: {
      maxErrorRate: 0.05,
      maxLatencyRatio: 2.5,
      maxQueueWaitRatio: 4,
      maxRecoveryHeapGrowthBytes: 32 * MIB,
      maxRecoveryRssGrowthBytes: 128 * MIB,
      recoveryRssPerWorkerBytes: 16 * MIB,
      latencyFloorMs: 1,
      queueWaitFloorMs: 0.5,
      recoveryLatencyRatio: 1.5,
      recoveryQueueWaitRatio: 2,
    },
  };
}

export function smokeStressConfig() {
  return createStressConfig({
    maxConcurrency: 4,
    maxConnections: 12,
    maxDurationMs: 20_000,
    maxMemoryBytes: 512 * MIB,
    maxWorkers: 2,
    queueSize: 4,
    eventShutdownIterations: 4,
    recoveryDurationMs: 150,
    stepConcurrency: [1, 2, 4],
    stepDurationMs: 150,
  });
}

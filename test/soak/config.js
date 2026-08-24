const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SCHEDULED_THRESHOLDS = Object.freeze({
  maxActiveHandleGrowth: 0,
  maxHeapSlopeBytesPerMinute: 256 * KIB,
  maxLatencyP95Ratio: 1.35,
  maxLatencyP99Ratio: 1.5,
  maxRssSlopeBytesPerMinute: 512 * KIB,
  minMonotonicGrowthRatio: 0.75,
});

const MODES = Object.freeze({
  short: {
    durationMs: 4_000,
    jobTimeoutMs: 15,
    operationConcurrency: 4,
    sampleIntervalMs: 250,
    timeoutMs: 30_000,
    warmupMs: 1_000,
    websocketSessions: 2,
  },
  scheduled: {
    durationMs: 4 * HOUR,
    jobTimeoutMs: 100,
    operationConcurrency: 16,
    sampleIntervalMs: 30_000,
    timeoutMs: 4 * HOUR + 5 * MINUTE,
    warmupMs: 15 * MINUTE,
    websocketSessions: 8,
  },
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

export function createSoakConfig(mode, overrides = {}) {
  const defaults = MODES[mode];
  if (!defaults) throw new TypeError(`Unknown soak mode: ${mode}`);
  const config = {
    ...defaults,
    ...overrides,
    mode,
    thresholds: {
      ...SCHEDULED_THRESHOLDS,
      ...(mode === 'short'
        ? {
            maxHeapSlopeBytesPerMinute: 1024 * MIB,
            maxRssSlopeBytesPerMinute: 4096 * MIB,
          }
        : {}),
      ...overrides.thresholds,
    },
  };
  for (const name of [
    'durationMs',
    'jobTimeoutMs',
    'operationConcurrency',
    'sampleIntervalMs',
    'timeoutMs',
    'websocketSessions',
  ]) {
    positiveInteger(config[name], name);
  }
  if (!Number.isSafeInteger(config.warmupMs) || config.warmupMs < 0) {
    throw new TypeError('warmupMs must be a non-negative integer');
  }
  if (config.warmupMs >= config.durationMs)
    throw new RangeError('warmupMs must precede durationMs');
  if (config.timeoutMs <= config.durationMs)
    throw new RangeError('timeoutMs must exceed durationMs');
  return config;
}

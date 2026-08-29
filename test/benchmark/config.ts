export const SCHEMA_VERSION = 1;

export const REGRESSION_THRESHOLDS = Object.freeze({
  errorRateIncrease: 0.01,
  latencyIncrease: 0.35,
  throughputDrop: 0.25,
});

const PROFILES = Object.freeze({
  'http-json': Object.freeze({ concurrency: 8, messageBytes: 128 }),
  'http-body-limit': Object.freeze({ concurrency: 4, messageBytes: 65_520 }),
  websocket: Object.freeze({ concurrency: 8, messageBytes: 256 }),
  job: Object.freeze({ concurrency: 8, cpuIterations: 25_000, poolSize: 2 }),
});

const MODES: Record<string, any> = Object.freeze({
  smoke: Object.freeze({ cooldownMs: 50, measureMs: 300, warmupMs: 150 }),
  full: Object.freeze({ cooldownMs: 250, measureMs: 3_000, warmupMs: 1_000 }),
});

export function benchmarkConfig(mode: any) {
  const phases = MODES[mode];
  if (!phases) throw new TypeError(`Unknown benchmark mode: ${mode}`);
  return {
    mode,
    phases: { ...phases },
    profiles: Object.fromEntries(
      Object.entries(PROFILES).map(([name, profile]: any) => [
        name,
        {
          ...profile,
          concurrency:
            mode === 'smoke'
              ? Math.max(2, Math.floor(profile.concurrency / 2))
              : profile.concurrency,
        },
      ]),
    ),
  };
}

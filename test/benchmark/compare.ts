import { REGRESSION_THRESHOLDS } from './config.ts';

function increase(current: any, baseline: any) {
  if (baseline === 0) return current === 0 ? 0 : Infinity;
  return (current - baseline) / baseline;
}

function drop(current: any, baseline: any) {
  if (baseline === 0) return 0;
  return (baseline - current) / baseline;
}

export function compareBenchmark(
  current: any,
  baseline: any,
  thresholds: any = REGRESSION_THRESHOLDS,
) {
  if (!baseline) return { status: 'skipped', reasons: ['baseline is unavailable'] };
  if (current.mode !== baseline.mode) {
    return { status: 'skipped', reasons: ['benchmark mode differs from baseline'] };
  }
  if (current.environment.fingerprint !== baseline.environment.fingerprint) {
    return { status: 'skipped', reasons: ['environment fingerprint differs from baseline'] };
  }

  const reasons: any[] = [];
  for (const [name, profile] of Object.entries(current.profiles) as [string, any][]) {
    const reference = baseline.profiles[name];
    if (!reference) {
      reasons.push(`${name}: profile is absent from baseline`);
      continue;
    }
    const throughputDrop = drop(
      profile.metrics.throughputPerSecond,
      reference.metrics.throughputPerSecond,
    );
    if (throughputDrop > thresholds.throughputDrop) {
      reasons.push(`${name}: throughput dropped by ${(throughputDrop * 100).toFixed(1)}%`);
    }
    const latencyIncrease = increase(
      profile.metrics.latencyMs.p95,
      reference.metrics.latencyMs.p95,
    );
    if (latencyIncrease > thresholds.latencyIncrease) {
      reasons.push(`${name}: p95 latency increased by ${(latencyIncrease * 100).toFixed(1)}%`);
    }
    const errorRateIncrease = profile.metrics.errorRate - reference.metrics.errorRate;
    if (errorRateIncrease > thresholds.errorRateIncrease) {
      reasons.push(`${name}: error rate increased by ${(errorRateIncrease * 100).toFixed(2)}pp`);
    }
    if (name === 'job') {
      for (const metric of ['queueLatencyMs', 'executionLatencyMs']) {
        const metricIncrease = increase(profile.metrics[metric].p95, reference.metrics[metric].p95);
        if (metricIncrease > thresholds.latencyIncrease) {
          reasons.push(`${name}: ${metric} p95 increased by ${(metricIncrease * 100).toFixed(1)}%`);
        }
      }
    }
  }
  return { status: reasons.length === 0 ? 'passed' : 'failed', reasons };
}

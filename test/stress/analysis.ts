function exceedsRatio(value: any, baseline: any, ratio: any, floor: any = 0) {
  return value > Math.max(baseline, floor) * ratio;
}

function degraded(step: any, baseline: any, thresholds: any) {
  return (
    step.errorRate > thresholds.maxErrorRate ||
    exceedsRatio(
      step.latencyMs.p95,
      baseline.latencyMs.p95,
      thresholds.maxLatencyRatio,
      thresholds.latencyFloorMs,
    ) ||
    exceedsRatio(
      step.queueWaitMs?.p95 ?? 0,
      baseline.queueWaitMs?.p95 ?? 0,
      thresholds.maxQueueWaitRatio,
      thresholds.queueWaitFloorMs,
    )
  );
}

export function classifySteps(steps: any, { recovery, ...thresholds }: any) {
  if (steps.length === 0) {
    return { firstDegradedStep: null, lastStableStep: null, recovery: 'not-measured' };
  }
  const baseline = steps[0];
  const observedWorkers = Math.max(0, ...steps.map((step: any) => step.workers ?? 0));
  const firstDegradedStep = steps.findIndex((step: any) => degraded(step, baseline, thresholds));
  const recovered =
    recovery.errorRate <= thresholds.maxErrorRate &&
    !exceedsRatio(
      recovery.latencyMs.p95,
      baseline.latencyMs.p95,
      thresholds.recoveryLatencyRatio ?? thresholds.maxLatencyRatio,
      thresholds.latencyFloorMs,
    ) &&
    !exceedsRatio(
      recovery.queueWaitMs?.p95 ?? 0,
      baseline.queueWaitMs?.p95 ?? 0,
      thresholds.recoveryQueueWaitRatio ?? thresholds.maxQueueWaitRatio,
      thresholds.queueWaitFloorMs,
    ) &&
    (recovery.rssBytes === undefined ||
      (recovery.settledMemory?.rssBytes ?? recovery.rssBytes.end) <=
        baseline.rssBytes.end +
          (thresholds.maxRecoveryRssGrowthBytes ?? Infinity) +
          observedWorkers * (thresholds.recoveryRssPerWorkerBytes ?? 0)) &&
    (recovery.heapUsedBytes === undefined ||
      (recovery.settledMemory?.heapUsedBytes ?? recovery.heapUsedBytes.end) <=
        baseline.heapUsedBytes.end + (thresholds.maxRecoveryHeapGrowthBytes ?? Infinity));
  return {
    firstDegradedStep: firstDegradedStep === -1 ? null : firstDegradedStep,
    lastStableStep:
      firstDegradedStep === -1
        ? steps.length - 1
        : firstDegradedStep === 0
          ? null
          : firstDegradedStep - 1,
    recovery: recovered ? 'recovered' : 'not-recovered',
  };
}

export function distribution(values: any) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = values.toSorted((left: any, right: any) => left - right);
  const percentile = (fraction: any) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

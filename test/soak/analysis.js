function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

export function linearSlopePerMinute(samples, field) {
  if (samples.length < 2) return 0;
  const origin = samples[0].elapsedMs;
  const points = samples.map((sample) => ({
    x: (sample.elapsedMs - origin) / 60_000,
    y: sample[field],
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function monotonicGrowthRatio(samples, field) {
  if (samples.length < 2) return 0;
  let growth = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index][field] > samples[index - 1][field]) growth += 1;
  }
  return growth / (samples.length - 1);
}

function trendThreshold(samples, field, maximum, minimumRatio) {
  const value = linearSlopePerMinute(samples, field);
  const monotonicRatio = monotonicGrowthRatio(samples, field);
  return {
    limit: maximum,
    monotonicRatio,
    status: value > maximum && monotonicRatio >= minimumRatio ? 'failed' : 'passed',
    unit: 'bytes/minute',
    value,
  };
}

function latencyThreshold(samples, percentileName, maximumRatio) {
  const baselineCount = Math.max(1, Math.floor(samples.length / 3));
  const baseline = percentile(
    samples.slice(0, baselineCount).map((sample) => sample.latencyMs[percentileName]),
    0.5,
  );
  const current = percentile(
    samples.slice(-baselineCount).map((sample) => sample.latencyMs[percentileName]),
    0.5,
  );
  const ratio = baseline === 0 ? (current === 0 ? 1 : Infinity) : current / baseline;
  return {
    baselineMs: baseline,
    currentMs: current,
    limit: maximumRatio,
    status: ratio > maximumRatio ? 'failed' : 'passed',
    unit: 'ratio',
    value: ratio,
  };
}

function resourceThreshold(baseline, finalResources, maxActiveHandleGrowth) {
  const limits = {
    activeHandles: maxActiveHandleGrowth,
    connections: 0,
    listeners: 0,
    timers: 0,
    workers: 0,
  };
  const excess = Object.fromEntries(
    Object.entries(limits).map(([field, allowance]) => [
      field,
      Math.max(0, finalResources[field] - baseline[field] - allowance),
    ]),
  );
  return {
    excess,
    status: Object.values(excess).some((value) => value > 0) ? 'failed' : 'passed',
  };
}

export function analyzeSoak(samples, { baselineResources, finalResources, thresholds, warmupMs }) {
  const steady = samples.filter((sample) => sample.elapsedMs >= warmupMs);
  const analyzed = steady.length >= 2 ? steady : samples;
  const results = {
    heapSlope: trendThreshold(
      analyzed,
      'heapUsedBytes',
      thresholds.maxHeapSlopeBytesPerMinute,
      thresholds.minMonotonicGrowthRatio,
    ),
    latencyP95: latencyThreshold(analyzed, 'p95', thresholds.maxLatencyP95Ratio),
    latencyP99: latencyThreshold(analyzed, 'p99', thresholds.maxLatencyP99Ratio),
    resourcesReturned: resourceThreshold(
      baselineResources,
      finalResources,
      thresholds.maxActiveHandleGrowth,
    ),
    rssSlope: trendThreshold(
      analyzed,
      'rssBytes',
      thresholds.maxRssSlopeBytesPerMinute,
      thresholds.minMonotonicGrowthRatio,
    ),
  };
  return {
    passed: Object.values(results).every((result) => result.status === 'passed'),
    sampleCount: samples.length,
    steadySampleCount: analyzed.length,
    thresholds: results,
  };
}

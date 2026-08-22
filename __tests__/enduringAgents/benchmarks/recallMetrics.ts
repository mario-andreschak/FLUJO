export interface LatencySummary {
  readonly sampleCount: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** Nearest-rank percentile: rank = ceil(sampleCount * percentile). */
export function nearestRankPercentile(
  samples: readonly number[],
  percentile: number,
): number {
  if (samples.length === 0) throw new Error('At least one sample is required.');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error('Percentile must be greater than 0 and at most 1.');
  }
  if (!samples.every((sample) => Number.isFinite(sample) && sample >= 0)) {
    throw new Error('Latency samples must be finite and non-negative.');
  }

  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * percentile) - 1];
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  return {
    sampleCount: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    p50: nearestRankPercentile(samples, 0.5),
    p95: nearestRankPercentile(samples, 0.95),
    p99: nearestRankPercentile(samples, 0.99),
  };
}

import {
  nearestRankPercentile,
  summarizeLatency,
} from './benchmarks/recallMetrics';

describe('recall benchmark latency metrics', () => {
  it('uses nearest-rank percentiles without rounding raw values', () => {
    const samples = [10.5, 1.25, 5.75, 4.5, 3.25];

    expect(nearestRankPercentile(samples, 0.5)).toBe(4.5);
    expect(nearestRankPercentile(samples, 0.95)).toBe(10.5);
    expect(nearestRankPercentile(samples, 1)).toBe(10.5);
    expect(summarizeLatency(samples)).toEqual({
      sampleCount: 5,
      min: 1.25,
      max: 10.5,
      mean: 5.05,
      p50: 4.5,
      p95: 10.5,
      p99: 10.5,
    });
  });

  it('rejects empty, invalid, and out-of-range input', () => {
    expect(() => nearestRankPercentile([], 0.95)).toThrow('At least one sample');
    expect(() => nearestRankPercentile([1], 0)).toThrow('Percentile');
    expect(() => nearestRankPercentile([Number.NaN], 0.5)).toThrow('Latency samples');
  });
});

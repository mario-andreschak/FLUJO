export type CriterionMode = 'enforce' | 'warn' | 'report';

export interface DailySoakMetric {
  day: number;
  activitiesAttempted: number;
  activitiesSucceeded: number;
  recallPrecision: number;
  recallP95Ms: number;
  residentMemoryBytes: number;
  eventAppendP95Ms: number;
  collectionCounts: Record<string, number>;
  faults: string[];
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function renderSoakReport(metrics: DailySoakMetric[]): string {
  const last = metrics.at(-1);
  return [
    '# Persona soak report',
    '',
    `Simulated days: ${metrics.length}`,
    `Activities: ${metrics.reduce((n, metric) => n + metric.activitiesSucceeded, 0)}`,
    `Final recall precision: ${last?.recallPrecision.toFixed(4) ?? 'n/a'}`,
    `Final recall p95: ${last?.recallP95Ms.toFixed(2) ?? 'n/a'} ms`,
    `Faults injected: ${metrics.flatMap((metric) => metric.faults).length}`,
    '',
  ].join('\n');
}

export type CriterionMode = 'enforce' | 'warn' | 'report';

export type SoakCriterionStatus = 'passed' | 'failed' | 'not_evaluated';

export interface SoakCriterionResult {
  key: string;
  status: SoakCriterionStatus;
  summary: string;
  evidence: Record<string, number | string | boolean>;
}

export interface DailySoakMetric {
  day: number;
  activitiesAttempted: number;
  activitiesSucceeded: number;
  recallPrecision: number;
  recallP95Ms: number;
  residentMemoryBytes: number;
  eventAppendP95Ms: number;
  eventLogSegments: number;
  collectionCounts: Record<string, number>;
  collectionUncompactedCounts: Record<string, number>;
  faultsScheduled: string[];
  faultsExecuted: string[];
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function renderSoakReport(
  metrics: DailySoakMetric[],
  criteria: SoakCriterionResult[],
): string {
  const last = metrics.at(-1);
  const rows = criteria.map((criterion) => (
    `| ${criterion.key} | ${criterion.status} | ${criterion.summary} |`
  ));
  return [
    '# Persona soak report',
    '',
    `Simulated days: ${metrics.length}`,
    `Activities attempted: ${metrics.reduce((n, metric) => n + metric.activitiesAttempted, 0)}`,
    `Activities completed successfully: ${metrics.reduce((n, metric) => n + metric.activitiesSucceeded, 0)}`,
    `Final recall precision: ${last?.recallPrecision.toFixed(4) ?? 'n/a'}`,
    `Final recall p95: ${last?.recallP95Ms.toFixed(2) ?? 'n/a'} ms`,
    `Faults executed: ${metrics.flatMap((metric) => metric.faultsExecuted).length}`,
    '',
    '| Criterion | Status | Evidence |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

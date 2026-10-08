import type {
  SoakCriterionResult,
  SoakRunIdentity,
  WorkloadReconciliationEvidence,
} from './evidence';

export interface LeaseHistoryPruningMetric {
  beforeCount: number;
  afterCount: number;
  examined: number;
  deleted: number;
  retainedProtected: number;
  retainedUnverifiable: number;
  observedAcquisitionCount: number;
  observedFencingTokenCount: number;
  minFencingToken: number | null;
  maxFencingToken: number | null;
  prePruneSnapshotSha256: string;
}

export interface DailySoakMetric {
  day: number;
  activitiesAttempted: number;
  activitiesAccepted: number;
  activitiesSucceeded: number;
  activitiesFailed: number;
  activitiesDuplicate: number;
  activitiesUnresolved: number;
  recallPrecision: number;
  recallP95Ms: number;
  residentMemoryBytes: number;
  eventAppendP95Ms: number;
  eventLogSegments: number;
  eventCount: number;
  eventFirstSeq: number | null;
  eventLastSeq: number | null;
  eventSequenceContinuous: boolean;
  eventIdsUnique: boolean;
  collectionCounts: Record<string, number>;
  collectionUncompactedCounts: Record<string, number>;
  leaseHistoryPruning: LeaseHistoryPruningMetric;
  faultsScheduled: string[];
  faultsExecuted: string[];
  faultEvidenceIds: string[];
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function renderSoakReport(
  runIdentity: SoakRunIdentity,
  metrics: DailySoakMetric[],
  criteria: SoakCriterionResult[],
  reconciliation: WorkloadReconciliationEvidence,
): string {
  const last = metrics.at(-1);
  const rows = criteria.map((criterion) => (
    `| ${criterion.id} | ${criterion.required ? 'required' : 'optional'} | ${criterion.status} | ${criterion.summary} |`
  ));
  return [
    '# Persona soak report',
    '',
    `Evidence schema: ${runIdentity.schemaVersion}`,
    `Run ID: ${runIdentity.runId}`,
    `Mode: ${runIdentity.mode}`,
    `Authoritative: ${runIdentity.authoritative}`,
    `Commit: ${runIdentity.commitSha}`,
    `Started: ${runIdentity.startedAt}`,
    `Ended: ${runIdentity.endedAt}`,
    `Node/platform: ${runIdentity.runner.node} / ${runIdentity.runner.platform} / ${runIdentity.runner.architecture}`,
    '',
    `Simulated days: ${metrics.length}`,
    `Activities attempted: ${metrics.reduce((n, metric) => n + metric.activitiesAttempted, 0)}`,
    `Activities completed successfully: ${metrics.reduce((n, metric) => n + metric.activitiesSucceeded, 0)}`,
    `Activities accepted/completed/failed/duplicate/unresolved: ${reconciliation.accepted}/${reconciliation.completed}/${reconciliation.failed}/${reconciliation.duplicate}/${reconciliation.unresolved}`,
    `Final recall precision: ${last?.recallPrecision.toFixed(4) ?? 'n/a'}`,
    `Final recall p95: ${last?.recallP95Ms.toFixed(2) ?? 'n/a'} ms`,
    `Faults executed: ${metrics.flatMap((metric) => metric.faultsExecuted).length}`,
    '',
    '| Criterion | Policy | Status | Evidence |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

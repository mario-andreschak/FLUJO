export const STATISTICS_SCHEMA_VERSION = 1 as const;

export type StatisticsRunSource =
  | 'chat'
  | 'api'
  | 'schedule'
  | 'trigger'
  | 'subflow'
  | 'mcp'
  | 'internal'
  | 'internal-tool';

export type StatisticsRunOutcome = 'completed' | 'error' | 'capped' | 'cancelled';
export type StatisticsOperationOutcome = 'completed' | 'error' | 'cancelled';

export type StatisticsErrorClass =
  | 'authentication'
  | 'authorization'
  | 'cancelled'
  | 'configuration'
  | 'context_limit'
  | 'network'
  | 'provider'
  | 'rate_limit'
  | 'timeout'
  | 'validation'
  | 'unknown';

export type StatisticsSkipReason =
  | 'disabled'
  | 'deleted'
  | 'duplicate'
  | 'encryption_locked'
  | 'exclusive_lock'
  | 'ineligible'
  | 'overlap'
  | 'paused'
  | 'queue_full'
  | 'unknown';

export interface StatisticsSnapshot {
  id: string;
  name?: string;
}

export interface StatisticsUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  contextWindow?: number;
}

interface StatisticsEventBase {
  schemaVersion: typeof STATISTICS_SCHEMA_VERSION;
  eventId: string;
  timestamp: string;
  runId: string;
}

export interface RunStartedStatisticsEvent extends StatisticsEventBase {
  type: 'run.started';
  source: StatisticsRunSource;
  flow: StatisticsSnapshot;
  plannedExecution?: StatisticsSnapshot;
  conversationId?: string;
}

export interface RunPausedStatisticsEvent extends StatisticsEventBase {
  type: 'run.paused';
  source: StatisticsRunSource;
  flow: StatisticsSnapshot;
  plannedExecution?: StatisticsSnapshot;
  pauseKind: 'approval' | 'debug';
  durationMs: number;
}

export interface RunFinishedStatisticsEvent extends StatisticsEventBase {
  type: 'run.finished';
  source: StatisticsRunSource;
  flow: StatisticsSnapshot;
  plannedExecution?: StatisticsSnapshot;
  outcome: StatisticsRunOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
  usage?: StatisticsUsage;
}

export interface NodeVisitStatisticsEvent extends StatisticsEventBase {
  type: 'node.visit';
  flow: StatisticsSnapshot;
  node: StatisticsSnapshot & { type?: string };
  outcome: StatisticsOperationOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
}

export interface ModelAttemptStatisticsEvent extends StatisticsEventBase {
  type: 'model.attempt';
  node?: StatisticsSnapshot;
  model: StatisticsSnapshot;
  provider: StatisticsSnapshot;
  credentialId?: string;
  attempt: number;
  outcome: StatisticsOperationOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
  usage?: StatisticsUsage;
}

export interface ToolInvocationStatisticsEvent extends StatisticsEventBase {
  type: 'tool.invocation';
  node?: StatisticsSnapshot;
  tool: StatisticsSnapshot & { kind: 'handoff' | 'mcp' | 'resource' | 'synthetic' | 'unknown' };
  provider?: StatisticsSnapshot;
  outcome: StatisticsOperationOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
}

export interface SchedulerSkipStatisticsEvent extends StatisticsEventBase {
  type: 'scheduler.skip';
  source: 'schedule';
  plannedExecution: StatisticsSnapshot;
  reason: StatisticsSkipReason;
}

export type StatisticsEvent =
  | RunStartedStatisticsEvent
  | RunPausedStatisticsEvent
  | RunFinishedStatisticsEvent
  | NodeVisitStatisticsEvent
  | ModelAttemptStatisticsEvent
  | ToolInvocationStatisticsEvent
  | SchedulerSkipStatisticsEvent;

const RUN_SOURCES = new Set<StatisticsRunSource>([
  'chat', 'api', 'schedule', 'trigger', 'subflow', 'mcp', 'internal', 'internal-tool',
]);
const RUN_OUTCOMES = new Set<StatisticsRunOutcome>(['completed', 'error', 'capped', 'cancelled']);
const OPERATION_OUTCOMES = new Set<StatisticsOperationOutcome>(['completed', 'error', 'cancelled']);
const ERROR_CLASSES = new Set<StatisticsErrorClass>([
  'authentication', 'authorization', 'cancelled', 'configuration', 'context_limit',
  'network', 'provider', 'rate_limit', 'timeout', 'validation', 'unknown',
]);
const SKIP_REASONS = new Set<StatisticsSkipReason>([
  'disabled', 'deleted', 'duplicate', 'encryption_locked', 'exclusive_lock',
  'ineligible', 'overlap', 'paused', 'queue_full', 'unknown',
]);
const TOOL_KINDS = new Set<ToolInvocationStatisticsEvent['tool']['kind']>([
  'handoff', 'mcp', 'resource', 'synthetic', 'unknown',
]);

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function snapshot(value: unknown): StatisticsSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id) return undefined;
  const name = stringValue(record.name);
  return name ? { id, name } : { id };
}

function usage(value: unknown): StatisticsUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: StatisticsUsage = {};
  const fields = [
    'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'cacheWriteTokens', 'contextWindow',
  ] as const;
  for (const field of fields) {
    const number = nonNegativeNumber(source[field]);
    if (number !== undefined) result[field] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function base(value: unknown): StatisticsEventBase & Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const eventId = stringValue(record.eventId);
  const timestamp = stringValue(record.timestamp);
  const runId = stringValue(record.runId);
  if (
    record.schemaVersion !== STATISTICS_SCHEMA_VERSION
    || !eventId
    || !timestamp
    || !timestamp.endsWith('Z')
    || !Number.isFinite(Date.parse(timestamp))
    || !runId
  ) return undefined;
  return {
    ...record,
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    eventId,
    timestamp,
    runId,
  };
}

/**
 * Strict metadata boundary for persistence and replay. Every event is rebuilt
 * from an explicit allowlist so extra request/content/error fields are dropped.
 */
export function sanitizeStatisticsEvent(value: unknown): StatisticsEvent | undefined {
  const record = base(value);
  if (!record || typeof record.type !== 'string') return undefined;
  const common = {
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    eventId: record.eventId,
    timestamp: record.timestamp,
    runId: record.runId,
  } as const;
  const errorClass = ERROR_CLASSES.has(record.errorClass as StatisticsErrorClass)
    ? record.errorClass as StatisticsErrorClass
    : undefined;

  switch (record.type) {
    case 'run.started': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      if (!RUN_SOURCES.has(source) || !flow) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      const conversationId = stringValue(record.conversationId);
      return { ...common, type: record.type, source, flow, ...(plannedExecution ? { plannedExecution } : {}), ...(conversationId ? { conversationId } : {}) };
    }
    case 'run.paused': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      const durationMs = nonNegativeNumber(record.durationMs);
      const pauseKind = record.pauseKind === 'approval' || record.pauseKind === 'debug' ? record.pauseKind : undefined;
      if (!RUN_SOURCES.has(source) || !flow || durationMs === undefined || !pauseKind) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      return { ...common, type: record.type, source, flow, pauseKind, durationMs, ...(plannedExecution ? { plannedExecution } : {}) };
    }
    case 'run.finished': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      const outcome = record.outcome as StatisticsRunOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!RUN_SOURCES.has(source) || !flow || !RUN_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      const eventUsage = usage(record.usage);
      return { ...common, type: record.type, source, flow, outcome, durationMs, ...(plannedExecution ? { plannedExecution } : {}), ...(errorClass ? { errorClass } : {}), ...(eventUsage ? { usage: eventUsage } : {}) };
    }
    case 'node.visit': {
      const flow = snapshot(record.flow);
      const nodeBase = snapshot(record.node);
      const nodeType = record.node && typeof record.node === 'object' ? stringValue((record.node as Record<string, unknown>).type) : undefined;
      const outcome = record.outcome as StatisticsOperationOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!flow || !nodeBase || !OPERATION_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const node = nodeType ? { ...nodeBase, type: nodeType } : nodeBase;
      return { ...common, type: record.type, flow, node, outcome, durationMs, ...(errorClass ? { errorClass } : {}) };
    }
    case 'model.attempt': {
      const model = snapshot(record.model);
      const provider = snapshot(record.provider);
      const node = snapshot(record.node);
      const attempt = record.attempt;
      const outcome = record.outcome as StatisticsOperationOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!model || !provider || !Number.isInteger(attempt) || (attempt as number) < 1 || !OPERATION_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const credentialId = stringValue(record.credentialId);
      const eventUsage = usage(record.usage);
      return { ...common, type: record.type, model, provider, attempt: attempt as number, outcome, durationMs, ...(node ? { node } : {}), ...(credentialId ? { credentialId } : {}), ...(errorClass ? { errorClass } : {}), ...(eventUsage ? { usage: eventUsage } : {}) };
    }
    case 'tool.invocation': {
      const toolBase = snapshot(record.tool);
      const toolKind = record.tool && typeof record.tool === 'object' ? (record.tool as Record<string, unknown>).kind as ToolInvocationStatisticsEvent['tool']['kind'] : undefined;
      const outcome = record.outcome as StatisticsOperationOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!toolBase || !toolKind || !TOOL_KINDS.has(toolKind) || !OPERATION_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const node = snapshot(record.node);
      const provider = snapshot(record.provider);
      return { ...common, type: record.type, tool: { ...toolBase, kind: toolKind }, outcome, durationMs, ...(node ? { node } : {}), ...(provider ? { provider } : {}), ...(errorClass ? { errorClass } : {}) };
    }
    case 'scheduler.skip': {
      const plannedExecution = snapshot(record.plannedExecution);
      const reason = record.reason as StatisticsSkipReason;
      if (record.source !== 'schedule' || !plannedExecution || !SKIP_REASONS.has(reason)) return undefined;
      return { ...common, type: record.type, source: 'schedule', plannedExecution, reason };
    }
    default:
      return undefined;
  }
}

/** Runtime boundary for JSONL replay. Unknown schema versions are ignored. */
export function isStatisticsEvent(value: unknown): value is StatisticsEvent {
  return sanitizeStatisticsEvent(value) !== undefined;
}


/** Inclusive UTC date range accepted by the aggregate statistics API. */
export interface StatisticsDateRange {
  from: string;
  to: string;
}

export type StatisticsStatusFilter = StatisticsRunOutcome | 'paused' | 'skipped';

/** All filter values are exact metadata identifiers; no display names are accepted. */
export interface StatisticsFilters {
  flowIds?: readonly string[];
  plannedExecutionIds?: readonly string[];
  sources?: readonly StatisticsRunSource[];
  statuses?: readonly StatisticsStatusFilter[];
  modelIds?: readonly string[];
  providerIds?: readonly string[];
  credentialIds?: readonly string[];
}

export interface StatisticsAggregateRequest {
  range: StatisticsDateRange;
  filters?: StatisticsFilters;
}

export interface StatisticsDurationMetrics {
  count: number;
  totalMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface StatisticsUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export interface StatisticsSummary {
  runs: number;
  successes: number;
  errors: number;
  capped: number;
  cancelled: number;
  paused: number;
  schedulerSkips: number;
  providerAttempts: number;
  providerErrors: number;
  nodeVisits: number;
  nodeErrors: number;
  toolCalls: number;
  toolFailures: number;
  usage: StatisticsUsageTotals;
  peakContextUtilization: number;
  runDuration: StatisticsDurationMetrics;
  providerDuration: StatisticsDurationMetrics;
  stepDuration: StatisticsDurationMetrics;
  toolDuration: StatisticsDurationMetrics;
}

export interface StatisticsDailyBucket {
  date: string;
  summary: StatisticsSummary;
}

/** A common aggregate-only row used by every ranking dimension. */
export interface StatisticsRankingRow extends StatisticsSummary {
  id: string;
  name?: string;
}

export interface StatisticsRankings {
  flows: StatisticsRankingRow[];
  plannedExecutions: StatisticsRankingRow[];
  models: StatisticsRankingRow[];
  providers: StatisticsRankingRow[];
  credentials: StatisticsRankingRow[];
  nodes: StatisticsRankingRow[];
  tools: StatisticsRankingRow[];
}

export interface StatisticsAggregateResponse {
  range: StatisticsDateRange;
  filters: StatisticsFilters;
  summary: StatisticsSummary;
  daily: StatisticsDailyBucket[];
  rankings: StatisticsRankings;
}

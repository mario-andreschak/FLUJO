export const STATISTICS_SCHEMA_VERSION = 1 as const;

/**
 * Hard ceiling for every persisted numeric metadata value (byte counts,
 * character counts, phase durations). Keeps a single corrupted or hostile
 * producer from writing unbounded numbers into a partition.
 */
export const STATISTICS_MAX_METRIC_VALUE = 1e15;

export type StatisticsRunSource =
  | 'chat'
  | 'api'
  | 'schedule'
  | 'trigger'
  | 'subflow'
  | 'mcp'
  | 'internal'
  | 'meeting'
  | 'internal-tool';

export type StatisticsRunOutcome = 'completed' | 'error' | 'capped' | 'cancelled';
export type StatisticsOperationOutcome = 'completed' | 'error' | 'cancelled';

/**
 * Subflow calls can outlive their parent (detached mode) or die with the
 * process, so they carry two extra terminal states that must never be folded
 * into successes or failures.
 */
export type StatisticsSubflowOutcome =
  | StatisticsOperationOutcome
  | 'timeout'
  | 'incomplete';

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

/**
 * Normalized payload shape categories. Raw MIME types, file names, and
 * payloads are never persisted; only this bounded allowlist is.
 */
export type StatisticsContentCategory =
  | 'json'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'binary'
  | 'multipart'
  | 'empty'
  | 'unknown';

/**
 * Explicit cache semantics. `unsupported` means the provider/tool cannot report
 * cache behaviour at all, `unknown` means it could but did not for this call.
 * Only `hit`/`miss`/`write` participate in hit-rate denominators.
 */
export type StatisticsCacheOutcome =
  | 'hit'
  | 'miss'
  | 'write'
  | 'mixed'
  | 'unsupported'
  | 'unknown';

export type StatisticsSubflowMode = 'inline' | 'detached' | 'graph' | 'fanout' | 'unknown';

/**
 * Timing phases. Phases are measured from real execution boundaries only and
 * may overlap (a tool phase can contain a nested subflow phase), so they must
 * never be summed into a single wall-clock total.
 */
export type StatisticsPhase =
  | 'queue'
  | 'approval'
  | 'provider'
  | 'tool'
  | 'narration'
  | 'engine'
  | 'subflowWait'
  | 'subflowExecution';

export type StatisticsPhaseTimings = Partial<Record<StatisticsPhase, number>>;

/** Metadata-only description of a request/response pair. Never its content. */
export interface StatisticsPayloadMetadata {
  requestBytes?: number;
  responseBytes?: number;
  requestChars?: number;
  responseChars?: number;
  requestCategory?: StatisticsContentCategory;
  responseCategory?: StatisticsContentCategory;
}

/**
 * Opaque revision identities. Either an immutable saved-configuration ID or a
 * local deterministic fingerprint; the configuration content itself is never
 * persisted.
 */
export interface StatisticsRevisions {
  flowRevisionId?: string;
  promptRevisionId?: string;
  nodeConfigRevisionId?: string;
  toolDefinitionRevisionId?: string;
}

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
  parentRunId?: string;
  parentNodeId?: string;
  revisions?: StatisticsRevisions;
}

export interface RunPausedStatisticsEvent extends StatisticsEventBase {
  type: 'run.paused';
  source: StatisticsRunSource;
  flow: StatisticsSnapshot;
  plannedExecution?: StatisticsSnapshot;
  pauseKind: 'approval' | 'debug';
  durationMs: number;
  parentRunId?: string;
  parentNodeId?: string;
  revisions?: StatisticsRevisions;
  phases?: StatisticsPhaseTimings;
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
  parentRunId?: string;
  parentNodeId?: string;
  revisions?: StatisticsRevisions;
  phases?: StatisticsPhaseTimings;
}

export interface NodeVisitStatisticsEvent extends StatisticsEventBase {
  type: 'node.visit';
  flow: StatisticsSnapshot;
  node: StatisticsSnapshot & { type?: string };
  outcome: StatisticsOperationOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
  invocationId?: string;
  revisions?: StatisticsRevisions;
  phases?: StatisticsPhaseTimings;
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
  /** Stable id of the logical model call; retries share it. */
  invocationId?: string;
  /** Stable id of this single attempt. */
  attemptId?: string;
  cacheOutcome?: StatisticsCacheOutcome;
  payload?: StatisticsPayloadMetadata;
  phases?: StatisticsPhaseTimings;
  revisions?: StatisticsRevisions;
}

export interface ToolInvocationStatisticsEvent extends StatisticsEventBase {
  type: 'tool.invocation';
  node?: StatisticsSnapshot;
  tool: StatisticsSnapshot & { kind: 'handoff' | 'mcp' | 'resource' | 'synthetic' | 'unknown' };
  provider?: StatisticsSnapshot;
  outcome: StatisticsOperationOutcome;
  durationMs: number;
  errorClass?: StatisticsErrorClass;
  /**
   * Stable id of the logical tool invocation. Aggregation counts one logical
   * invocation per id even when several producers observe the same call.
   */
  invocationId?: string;
  payload?: StatisticsPayloadMetadata;
  cacheOutcome?: StatisticsCacheOutcome;
  phases?: StatisticsPhaseTimings;
  revisions?: StatisticsRevisions;
}

export interface SubflowInvocationStatisticsEvent extends StatisticsEventBase {
  type: 'subflow.invocation';
  /** The PARENT logical run id; the child run reports its own lifecycle. */
  node?: StatisticsSnapshot;
  subflow: StatisticsSnapshot;
  mode: StatisticsSubflowMode;
  outcome: StatisticsSubflowOutcome;
  durationMs: number;
  waitMs?: number;
  childRunId?: string;
  invocationId?: string;
  errorClass?: StatisticsErrorClass;
  phases?: StatisticsPhaseTimings;
}

export interface SchedulerFireStatisticsEvent extends StatisticsEventBase {
  type: 'scheduler.fire';
  source: 'schedule';
  plannedExecution: StatisticsSnapshot;
  outcome: 'fired' | 'queued';
  conversationId?: string;
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
  | SubflowInvocationStatisticsEvent
  | SchedulerFireStatisticsEvent
  | SchedulerSkipStatisticsEvent;

const RUN_SOURCES = new Set<StatisticsRunSource>([
  'chat', 'api', 'schedule', 'trigger', 'subflow', 'mcp', 'internal', 'meeting', 'internal-tool',
]);
const RUN_OUTCOMES = new Set<StatisticsRunOutcome>(['completed', 'error', 'capped', 'cancelled']);
const OPERATION_OUTCOMES = new Set<StatisticsOperationOutcome>(['completed', 'error', 'cancelled']);
const SUBFLOW_OUTCOMES = new Set<StatisticsSubflowOutcome>([
  'completed', 'error', 'cancelled', 'timeout', 'incomplete',
]);
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
export const STATISTICS_CONTENT_CATEGORIES = [
  'json', 'text', 'image', 'audio', 'video', 'binary', 'multipart', 'empty', 'unknown',
] as const;
const CONTENT_CATEGORIES = new Set<StatisticsContentCategory>(STATISTICS_CONTENT_CATEGORIES);
export const STATISTICS_CACHE_OUTCOMES = [
  'hit', 'miss', 'write', 'mixed', 'unsupported', 'unknown',
] as const;
const CACHE_OUTCOMES = new Set<StatisticsCacheOutcome>(STATISTICS_CACHE_OUTCOMES);
export const STATISTICS_SUBFLOW_MODES = [
  'inline', 'detached', 'graph', 'fanout', 'unknown',
] as const;
const SUBFLOW_MODES = new Set<StatisticsSubflowMode>(STATISTICS_SUBFLOW_MODES);
export const STATISTICS_PHASES = [
  'queue', 'approval', 'provider', 'tool', 'narration', 'engine',
  'subflowWait', 'subflowExecution',
] as const;
const PHASES = new Set<StatisticsPhase>(STATISTICS_PHASES);

/** Correlation/revision identifiers are opaque and strictly bounded. */
const SAFE_METADATA_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Non-negative, finite, and capped so a single record cannot skew aggregates. */
function boundedNumber(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  return number === undefined ? undefined : Math.min(number, STATISTICS_MAX_METRIC_VALUE);
}

function metadataId(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && SAFE_METADATA_ID.test(text) ? text : undefined;
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

/** Only allowlisted phases with bounded non-negative durations survive. */
function phaseTimings(value: unknown): StatisticsPhaseTimings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: StatisticsPhaseTimings = {};
  for (const phase of PHASES) {
    const number = boundedNumber(source[phase]);
    if (number !== undefined) result[phase] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Sizes and normalized categories only; a raw MIME string is dropped. */
function payloadMetadata(value: unknown): StatisticsPayloadMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: StatisticsPayloadMetadata = {};
  const numbers = ['requestBytes', 'responseBytes', 'requestChars', 'responseChars'] as const;
  for (const field of numbers) {
    const number = boundedNumber(source[field]);
    if (number !== undefined) result[field] = number;
  }
  for (const field of ['requestCategory', 'responseCategory'] as const) {
    const category = source[field] as StatisticsContentCategory;
    if (CONTENT_CATEGORIES.has(category)) result[field] = category;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function revisionIds(value: unknown): StatisticsRevisions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: StatisticsRevisions = {};
  const fields = [
    'flowRevisionId', 'promptRevisionId', 'nodeConfigRevisionId', 'toolDefinitionRevisionId',
  ] as const;
  for (const field of fields) {
    const id = metadataId(source[field]);
    if (id) result[field] = id;
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
 *
 * All correlation, revision, payload-size, cache, and phase fields are OPTIONAL
 * additions to schema version 1: version-1 records written before they existed
 * still replay unchanged, and unknown future versions are still rejected.
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
  const parentRunId = metadataId(record.parentRunId);
  const parentNodeId = metadataId(record.parentNodeId);
  const invocationId = metadataId(record.invocationId);
  const revisions = revisionIds(record.revisions);
  const phases = phaseTimings(record.phases);
  const payload = payloadMetadata(record.payload);
  const cacheOutcome = CACHE_OUTCOMES.has(record.cacheOutcome as StatisticsCacheOutcome)
    ? record.cacheOutcome as StatisticsCacheOutcome
    : undefined;

  switch (record.type) {
    case 'run.started': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      if (!RUN_SOURCES.has(source) || !flow) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      const conversationId = stringValue(record.conversationId);
      return { ...common, type: record.type, source, flow, ...(plannedExecution ? { plannedExecution } : {}), ...(conversationId ? { conversationId } : {}), ...(parentRunId ? { parentRunId } : {}), ...(parentNodeId ? { parentNodeId } : {}), ...(revisions ? { revisions } : {}) };
    }
    case 'run.paused': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      const durationMs = nonNegativeNumber(record.durationMs);
      const pauseKind = record.pauseKind === 'approval' || record.pauseKind === 'debug' ? record.pauseKind : undefined;
      if (!RUN_SOURCES.has(source) || !flow || durationMs === undefined || !pauseKind) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      return { ...common, type: record.type, source, flow, pauseKind, durationMs, ...(plannedExecution ? { plannedExecution } : {}), ...(parentRunId ? { parentRunId } : {}), ...(parentNodeId ? { parentNodeId } : {}), ...(revisions ? { revisions } : {}), ...(phases ? { phases } : {}) };
    }
    case 'run.finished': {
      const source = record.source as StatisticsRunSource;
      const flow = snapshot(record.flow);
      const outcome = record.outcome as StatisticsRunOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!RUN_SOURCES.has(source) || !flow || !RUN_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const plannedExecution = snapshot(record.plannedExecution);
      const eventUsage = usage(record.usage);
      return { ...common, type: record.type, source, flow, outcome, durationMs, ...(plannedExecution ? { plannedExecution } : {}), ...(errorClass ? { errorClass } : {}), ...(eventUsage ? { usage: eventUsage } : {}), ...(parentRunId ? { parentRunId } : {}), ...(parentNodeId ? { parentNodeId } : {}), ...(revisions ? { revisions } : {}), ...(phases ? { phases } : {}) };
    }
    case 'node.visit': {
      const flow = snapshot(record.flow);
      const nodeBase = snapshot(record.node);
      const nodeType = record.node && typeof record.node === 'object' ? stringValue((record.node as Record<string, unknown>).type) : undefined;
      const outcome = record.outcome as StatisticsOperationOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!flow || !nodeBase || !OPERATION_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const node = nodeType ? { ...nodeBase, type: nodeType } : nodeBase;
      return { ...common, type: record.type, flow, node, outcome, durationMs, ...(errorClass ? { errorClass } : {}), ...(invocationId ? { invocationId } : {}), ...(revisions ? { revisions } : {}), ...(phases ? { phases } : {}) };
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
      const attemptId = metadataId(record.attemptId);
      const eventUsage = usage(record.usage);
      return { ...common, type: record.type, model, provider, attempt: attempt as number, outcome, durationMs, ...(node ? { node } : {}), ...(credentialId ? { credentialId } : {}), ...(errorClass ? { errorClass } : {}), ...(eventUsage ? { usage: eventUsage } : {}), ...(invocationId ? { invocationId } : {}), ...(attemptId ? { attemptId } : {}), ...(cacheOutcome ? { cacheOutcome } : {}), ...(payload ? { payload } : {}), ...(phases ? { phases } : {}), ...(revisions ? { revisions } : {}) };
    }
    case 'tool.invocation': {
      const toolBase = snapshot(record.tool);
      const toolKind = record.tool && typeof record.tool === 'object' ? (record.tool as Record<string, unknown>).kind as ToolInvocationStatisticsEvent['tool']['kind'] : undefined;
      const outcome = record.outcome as StatisticsOperationOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!toolBase || !toolKind || !TOOL_KINDS.has(toolKind) || !OPERATION_OUTCOMES.has(outcome) || durationMs === undefined) return undefined;
      const node = snapshot(record.node);
      const provider = snapshot(record.provider);
      return { ...common, type: record.type, tool: { ...toolBase, kind: toolKind }, outcome, durationMs, ...(node ? { node } : {}), ...(provider ? { provider } : {}), ...(errorClass ? { errorClass } : {}), ...(invocationId ? { invocationId } : {}), ...(payload ? { payload } : {}), ...(cacheOutcome ? { cacheOutcome } : {}), ...(phases ? { phases } : {}), ...(revisions ? { revisions } : {}) };
    }
    case 'subflow.invocation': {
      const subflow = snapshot(record.subflow);
      const mode = record.mode as StatisticsSubflowMode;
      const outcome = record.outcome as StatisticsSubflowOutcome;
      const durationMs = nonNegativeNumber(record.durationMs);
      if (!subflow || !SUBFLOW_MODES.has(mode) || !SUBFLOW_OUTCOMES.has(outcome) || durationMs === undefined) {
        return undefined;
      }
      const node = snapshot(record.node);
      const childRunId = metadataId(record.childRunId);
      const waitMs = boundedNumber(record.waitMs);
      return { ...common, type: record.type, subflow, mode, outcome, durationMs, ...(node ? { node } : {}), ...(childRunId ? { childRunId } : {}), ...(invocationId ? { invocationId } : {}), ...(waitMs !== undefined ? { waitMs } : {}), ...(errorClass ? { errorClass } : {}), ...(phases ? { phases } : {}) };
    }
    case 'scheduler.fire': {
      const plannedExecution = snapshot(record.plannedExecution);
      const outcome = record.outcome === 'fired' || record.outcome === 'queued'
        ? record.outcome
        : undefined;
      if (record.source !== 'schedule' || !plannedExecution || !outcome) return undefined;
      const conversationId = stringValue(record.conversationId);
      return {
        ...common,
        type: record.type,
        source: 'schedule',
        plannedExecution,
        outcome,
        ...(conversationId ? { conversationId } : {}),
      };
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
  nodeIds?: readonly string[];
  toolIds?: readonly string[];
  subflowIds?: readonly string[];
  subflowModes?: readonly StatisticsSubflowMode[];
  revisionIds?: readonly string[];
  cacheOutcomes?: readonly StatisticsCacheOutcome[];
  contentCategories?: readonly StatisticsContentCategory[];
  parentRunIds?: readonly string[];
}

export type StatisticsSortField =
  | 'activity'
  | 'id'
  | 'runs'
  | 'errors'
  | 'failureRate'
  | 'providerAttempts'
  | 'providerErrors'
  | 'nodeVisits'
  | 'toolCalls'
  | 'toolFailures'
  | 'subflowCalls'
  | 'tokens'
  | 'duration'
  | 'cacheHitRate'
  | 'requestBytes'
  | 'responseBytes';

export type StatisticsSortDirection = 'asc' | 'desc';

export interface StatisticsSort {
  field: StatisticsSortField;
  direction: StatisticsSortDirection;
}

export interface StatisticsAggregateRequest {
  range: StatisticsDateRange;
  filters?: StatisticsFilters;
  sort?: StatisticsSort;
}

export interface StatisticsDurationMetrics {
  count: number;
  totalMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface StatisticsSizeMetrics {
  count: number;
  totalBytes: number;
  averageBytes: number;
  p50Bytes: number;
  p95Bytes: number;
}

export interface StatisticsUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/**
 * Cache rates use an explicit denominator: `requests` counts only calls that
 * reported a hit, miss, or write. `unknown` (including `unsupported`) is
 * reported separately and never inflates or deflates the hit rate.
 */
export interface StatisticsCacheTotals {
  requests: number;
  hits: number;
  misses: number;
  writes: number;
  unknown: number;
  hitRate: number;
}

export interface StatisticsPayloadTotals {
  request: StatisticsSizeMetrics;
  response: StatisticsSizeMetrics;
}

export type StatisticsErrorClassTotals = Partial<Record<StatisticsErrorClass, number>>;
export type StatisticsContentCategoryTotals = Partial<Record<StatisticsContentCategory, number>>;
export type StatisticsPhaseTotals = Partial<Record<StatisticsPhase, StatisticsDurationMetrics>>;

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
  /** Parent-side subflow calls. Child runs are counted in `runs` separately. */
  subflowCalls: number;
  subflowFailures: number;
  /** Cancelled, timed-out, or never-terminated subflow calls. */
  subflowIncomplete: number;
  /** Runs that started but never produced a terminal or paused record. */
  runsIncomplete: number;
  subflowDuration: StatisticsDurationMetrics;
  subflowWaitDuration: StatisticsDurationMetrics;
  cache: StatisticsCacheTotals;
  toolPayload: StatisticsPayloadTotals;
  errorClasses: StatisticsErrorClassTotals;
  contentCategories: StatisticsContentCategoryTotals;
  phases: StatisticsPhaseTotals;
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
  subflows: StatisticsRankingRow[];
  revisions: StatisticsRankingRow[];
}

export interface StatisticsAggregateResponse {
  range: StatisticsDateRange;
  filters: StatisticsFilters;
  sort?: StatisticsSort;
  summary: StatisticsSummary;
  daily: StatisticsDailyBucket[];
  rankings: StatisticsRankings;
  /** Set when a ranking dimension was capped for response-size safety. */
  truncatedDimensions?: string[];
}

export type StatisticsDetailKind = 'runs' | 'tools' | 'subflows';

export interface StatisticsDetailRequest {
  range: StatisticsDateRange;
  filters?: StatisticsFilters;
  kind: StatisticsDetailKind;
  cursor?: string;
  limit?: number;
}

export interface StatisticsRunDetailRow {
  kind: 'run';
  runId: string;
  day: string;
  timestamp: string;
  source?: StatisticsRunSource;
  flowId?: string;
  flowName?: string;
  plannedExecutionId?: string;
  parentRunId?: string;
  revisionId?: string;
  outcome?: StatisticsRunOutcome;
  status: StatisticsStatusFilter | 'incomplete';
  errorClass?: StatisticsErrorClass;
  durationMs?: number;
  providerAttempts: number;
  nodeVisits: number;
  toolCalls: number;
  toolFailures: number;
  subflowCalls: number;
  totalTokens: number;
}

export interface StatisticsToolDetailRow {
  kind: 'tool';
  runId: string;
  timestamp: string;
  invocationId?: string;
  toolId: string;
  toolName?: string;
  toolKind: ToolInvocationStatisticsEvent['tool']['kind'];
  nodeId?: string;
  providerId?: string;
  outcome: StatisticsOperationOutcome;
  errorClass?: StatisticsErrorClass;
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
  requestCategory?: StatisticsContentCategory;
  responseCategory?: StatisticsContentCategory;
  cacheOutcome?: StatisticsCacheOutcome;
}

export interface StatisticsSubflowDetailRow {
  kind: 'subflow';
  runId: string;
  timestamp: string;
  invocationId?: string;
  childRunId?: string;
  subflowId: string;
  subflowName?: string;
  mode: StatisticsSubflowMode;
  nodeId?: string;
  outcome: StatisticsSubflowOutcome;
  errorClass?: StatisticsErrorClass;
  durationMs: number;
  waitMs?: number;
}

export type StatisticsDetailRow =
  | StatisticsRunDetailRow
  | StatisticsToolDetailRow
  | StatisticsSubflowDetailRow;

export interface StatisticsDetailResponse {
  range: StatisticsDateRange;
  filters: StatisticsFilters;
  kind: StatisticsDetailKind;
  limit: number;
  rows: StatisticsDetailRow[];
  nextCursor?: string;
  total: number;
}

export type StatisticsComparisonMetric =
  | 'runs'
  | 'failureRate'
  | 'runDurationP95Ms'
  | 'totalTokens'
  | 'toolCalls'
  | 'toolFailureRate'
  | 'providerErrorRate'
  | 'cacheHitRate'
  | 'subflowFailureRate';

export interface StatisticsCohortSelector {
  revisionIds?: readonly string[];
  range?: StatisticsDateRange;
}

export interface StatisticsComparisonRequest {
  range: StatisticsDateRange;
  filters?: StatisticsFilters;
  baseline: StatisticsCohortSelector;
  candidate: StatisticsCohortSelector;
}

export interface StatisticsComparisonCohort {
  label: 'baseline' | 'candidate';
  range: StatisticsDateRange;
  revisionIds: readonly string[];
  /** Logical runs observed in the cohort; the sample size for every delta. */
  samples: number;
  summary: StatisticsSummary;
}

export interface StatisticsComparisonDelta {
  metric: StatisticsComparisonMetric;
  baseline: number;
  candidate: number;
  absoluteDelta: number;
  /** Null when the baseline value is zero, so no percentage is defined. */
  percentDelta: number | null;
}

export type StatisticsComparisonWarning =
  | 'insufficient_baseline_samples'
  | 'insufficient_candidate_samples'
  | 'observational_comparison'
  | 'different_ranges';

export interface StatisticsComparisonResponse {
  filters: StatisticsFilters;
  baseline: StatisticsComparisonCohort;
  candidate: StatisticsComparisonCohort;
  deltas: StatisticsComparisonDelta[];
  warnings: StatisticsComparisonWarning[];
}

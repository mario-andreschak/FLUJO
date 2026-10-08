import {
  getStatisticsPartitionMetadata,
  readStatisticsEvents,
  type StatisticsPartitionMetadata,
} from '@/backend/services/statistics';
import {
  STATISTICS_CACHE_OUTCOMES,
  STATISTICS_CONTENT_CATEGORIES,
  STATISTICS_SUBFLOW_MODES,
  type ModelAttemptStatisticsEvent,
  type NodeVisitStatisticsEvent,
  type StatisticsAggregateRequest,
  type StatisticsAggregateResponse,
  type StatisticsCacheOutcome,
  type StatisticsCacheTotals,
  type StatisticsCohortSelector,
  type StatisticsComparisonCohort,
  type StatisticsComparisonDelta,
  type StatisticsComparisonMetric,
  type StatisticsComparisonRequest,
  type StatisticsComparisonResponse,
  type StatisticsComparisonWarning,
  type StatisticsContentCategory,
  type StatisticsDateRange,
  type StatisticsDetailKind,
  type StatisticsDetailRequest,
  type StatisticsDetailResponse,
  type StatisticsDetailRow,
  type StatisticsDurationMetrics,
  type StatisticsErrorClass,
  type StatisticsEvent,
  type StatisticsFilters,
  type StatisticsPhase,
  type StatisticsPhaseTimings,
  type StatisticsRankingRow,
  type StatisticsRunOutcome,
  type StatisticsRunSource,
  type StatisticsSizeMetrics,
  type StatisticsSort,
  type StatisticsSortDirection,
  type StatisticsSortField,
  type StatisticsStatusFilter,
  type StatisticsSubflowMode,
  type StatisticsSubflowOutcome,
  type StatisticsSummary,
  type StatisticsUsage,
  type StatisticsUsageTotals,
  type SubflowInvocationStatisticsEvent,
  type ToolInvocationStatisticsEvent,
} from '@/shared/types/statistics';
import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import { workspaceCacheKey } from '@/utils/workspace';

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SAFE_CREDENTIAL = /^cred_[A-Za-z0-9_-]{1,128}$/;
const SAFE_PERSONA_ATTRIBUTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CURSOR = /^\d{1,9}$/;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 32;
const MAX_FILTER_VALUES = 50;

export const STATISTICS_MAX_RANGE_DAYS = 90;
export const STATISTICS_DEFAULT_RANGE_DAYS = 7;
/** Response-size guard: every ranking dimension is capped to this many rows. */
export const STATISTICS_MAX_RANKING_ROWS = 100;
export const STATISTICS_DEFAULT_DETAIL_LIMIT = 50;
export const STATISTICS_MAX_DETAIL_LIMIT = 200;
/** Detail pagination never scans more than this many candidate rows. */
export const STATISTICS_MAX_DETAIL_SCAN = 5_000;
/** Below this sample size a comparison cohort is flagged as unreliable. */
export const STATISTICS_MIN_COMPARISON_SAMPLES = 10;

const RUN_SOURCES = new Set<StatisticsRunSource>([
  'chat', 'api', 'schedule', 'trigger', 'subflow', 'mcp', 'internal', 'meeting', 'internal-tool',
]);
const STATUSES = new Set<StatisticsStatusFilter>([
  'completed', 'error', 'capped', 'cancelled', 'paused', 'skipped',
]);
const CACHE_OUTCOMES = new Set<StatisticsCacheOutcome>(STATISTICS_CACHE_OUTCOMES);
const CONTENT_CATEGORIES = new Set<StatisticsContentCategory>(STATISTICS_CONTENT_CATEGORIES);
const SUBFLOW_MODES = new Set<StatisticsSubflowMode>(STATISTICS_SUBFLOW_MODES);
const DETAIL_KINDS = new Set<StatisticsDetailKind>(['runs', 'tools', 'subflows']);
const SORT_FIELDS = new Set<StatisticsSortField>([
  'activity', 'id', 'runs', 'errors', 'failureRate', 'providerAttempts', 'providerErrors',
  'nodeVisits', 'toolCalls', 'toolFailures', 'subflowCalls', 'tokens', 'duration',
  'cacheHitRate', 'requestBytes', 'responseBytes',
]);

const FILTER_QUERY_KEYS = [
  'personaId', 'activityId', 'behaviorRevisionId',
  'flowId', 'plannedExecutionId', 'source', 'status', 'modelId', 'providerId',
  'credentialId', 'nodeId', 'toolId', 'subflowId', 'subflowMode', 'revisionId',
  'cacheOutcome', 'contentCategory', 'parentRunId',
] as const;
const AGGREGATE_QUERY_KEYS = new Set<string>([
  // Validated and consumed by withWorkspaceRoute before this parser runs.
  'workspace', 'from', 'to', 'view', 'sort', 'direction', ...FILTER_QUERY_KEYS,
]);
const DETAIL_QUERY_KEYS = new Set<string>([
  ...AGGREGATE_QUERY_KEYS, 'kind', 'cursor', 'limit',
]);
const COMPARE_QUERY_KEYS = new Set<string>([
  ...AGGREGATE_QUERY_KEYS, 'baselineRevisionId', 'candidateRevisionId',
  'baselineFrom', 'baselineTo', 'candidateFrom', 'candidateTo',
]);
const ALLOWED_FILTER_KEYS = new Set<keyof StatisticsFilters>([
  'personaIds', 'activityIds', 'behaviorRevisionIds',
  'flowIds', 'plannedExecutionIds', 'sources', 'statuses', 'modelIds', 'providerIds',
  'credentialIds', 'nodeIds', 'toolIds', 'subflowIds', 'subflowModes', 'revisionIds',
  'cacheOutcomes', 'contentCategories', 'parentRunIds',
]);

export class StatisticsRequestError extends Error {
  readonly status = 400;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StatisticsRequestError';
  }
}

function parseUtcDay(value: string, field: string): string {
  if (!UTC_DAY.test(value)) {
    throw new StatisticsRequestError('invalid_date', `${field} must use YYYY-MM-DD.`);
  }
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
    throw new StatisticsRequestError('invalid_date', `${field} must be a valid UTC calendar date.`);
  }
  return value;
}

function dayMillis(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function formatDay(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

function daysInRange(range: StatisticsDateRange): string[] {
  const days: string[] = [];
  for (let value = dayMillis(range.from); value <= dayMillis(range.to); value += DAY_MS) {
    days.push(formatDay(value));
  }
  return days;
}

function assertRange(range: StatisticsDateRange, fromField = 'from', toField = 'to'): StatisticsDateRange {
  const from = parseUtcDay(range.from, fromField);
  const to = parseUtcDay(range.to, toField);
  const span = Math.floor((dayMillis(to) - dayMillis(from)) / DAY_MS) + 1;
  if (span < 1) {
    throw new StatisticsRequestError('inverted_range', `${fromField} must not be after ${toField}.`);
  }
  if (span > STATISTICS_MAX_RANGE_DAYS) {
    throw new StatisticsRequestError(
      'range_too_large',
      `Statistics ranges are limited to ${STATISTICS_MAX_RANGE_DAYS} days.`,
    );
  }
  return { from, to };
}

function parseValues(
  searchParams: URLSearchParams,
  key: string,
  validator: (value: string) => boolean,
): string[] | undefined {
  const values = searchParams.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length > MAX_FILTER_VALUES || values.some(value => !validator(value))) {
    throw new StatisticsRequestError('invalid_filter', `Invalid ${key} filter.`);
  }
  return [...new Set(values)].sort();
}

function assertAllowedKeys(searchParams: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new StatisticsRequestError('unknown_parameter', 'Unknown statistics query parameter.');
    }
  }
}

function parseFilters(searchParams: URLSearchParams): StatisticsFilters {
  const personaIds = parseValues(
    searchParams,
    'personaId',
    value => SAFE_PERSONA_ATTRIBUTION_ID.test(value),
  );
  const activityIds = parseValues(
    searchParams,
    'activityId',
    value => SAFE_PERSONA_ATTRIBUTION_ID.test(value),
  );
  const behaviorRevisionIds = parseValues(
    searchParams,
    'behaviorRevisionId',
    value => SAFE_PERSONA_ATTRIBUTION_ID.test(value),
  );
  const flowIds = parseValues(searchParams, 'flowId', value => SAFE_IDENTIFIER.test(value));
  const plannedExecutionIds = parseValues(
    searchParams,
    'plannedExecutionId',
    value => SAFE_IDENTIFIER.test(value),
  );
  const sources = parseValues(searchParams, 'source', value => RUN_SOURCES.has(value as StatisticsRunSource)) as StatisticsRunSource[] | undefined;
  const statuses = parseValues(searchParams, 'status', value => STATUSES.has(value as StatisticsStatusFilter)) as StatisticsStatusFilter[] | undefined;
  const modelIds = parseValues(searchParams, 'modelId', value => SAFE_IDENTIFIER.test(value));
  const providerIds = parseValues(searchParams, 'providerId', value => SAFE_IDENTIFIER.test(value));
  const credentialIds = parseValues(searchParams, 'credentialId', value => SAFE_CREDENTIAL.test(value));
  const nodeIds = parseValues(searchParams, 'nodeId', value => SAFE_IDENTIFIER.test(value));
  const toolIds = parseValues(searchParams, 'toolId', value => SAFE_IDENTIFIER.test(value));
  const subflowIds = parseValues(searchParams, 'subflowId', value => SAFE_IDENTIFIER.test(value));
  const subflowModes = parseValues(searchParams, 'subflowMode', value => SUBFLOW_MODES.has(value as StatisticsSubflowMode)) as StatisticsSubflowMode[] | undefined;
  const revisionIds = parseValues(searchParams, 'revisionId', value => SAFE_IDENTIFIER.test(value));
  const cacheOutcomes = parseValues(searchParams, 'cacheOutcome', value => CACHE_OUTCOMES.has(value as StatisticsCacheOutcome)) as StatisticsCacheOutcome[] | undefined;
  const contentCategories = parseValues(searchParams, 'contentCategory', value => CONTENT_CATEGORIES.has(value as StatisticsContentCategory)) as StatisticsContentCategory[] | undefined;
  const parentRunIds = parseValues(searchParams, 'parentRunId', value => SAFE_IDENTIFIER.test(value));

  return {
    ...(personaIds ? { personaIds } : {}),
    ...(activityIds ? { activityIds } : {}),
    ...(behaviorRevisionIds ? { behaviorRevisionIds } : {}),
    ...(flowIds ? { flowIds } : {}),
    ...(plannedExecutionIds ? { plannedExecutionIds } : {}),
    ...(sources ? { sources } : {}),
    ...(statuses ? { statuses } : {}),
    ...(modelIds ? { modelIds } : {}),
    ...(providerIds ? { providerIds } : {}),
    ...(credentialIds ? { credentialIds } : {}),
    ...(nodeIds ? { nodeIds } : {}),
    ...(toolIds ? { toolIds } : {}),
    ...(subflowIds ? { subflowIds } : {}),
    ...(subflowModes ? { subflowModes } : {}),
    ...(revisionIds ? { revisionIds } : {}),
    ...(cacheOutcomes ? { cacheOutcomes } : {}),
    ...(contentCategories ? { contentCategories } : {}),
    ...(parentRunIds ? { parentRunIds } : {}),
  };
}

function parseRange(searchParams: URLSearchParams, now: Date): StatisticsDateRange {
  if (searchParams.getAll('from').length > 1 || searchParams.getAll('to').length > 1) {
    throw new StatisticsRequestError('invalid_date', 'Date parameters may only be supplied once.');
  }
  const defaultTo = now.toISOString().slice(0, 10);
  const to = parseUtcDay(searchParams.get('to') ?? defaultTo, 'to');
  const from = parseUtcDay(
    searchParams.get('from') ?? formatDay(dayMillis(to) - (STATISTICS_DEFAULT_RANGE_DAYS - 1) * DAY_MS),
    'from',
  );
  return assertRange({ from, to });
}

function parseSort(searchParams: URLSearchParams): StatisticsSort | undefined {
  const field = searchParams.get('sort');
  const direction = searchParams.get('direction');
  if (searchParams.getAll('sort').length > 1 || searchParams.getAll('direction').length > 1) {
    throw new StatisticsRequestError('invalid_sort', 'Sort parameters may only be supplied once.');
  }
  if (!field && !direction) return undefined;
  if (field && !SORT_FIELDS.has(field as StatisticsSortField)) {
    throw new StatisticsRequestError('invalid_sort', 'Unknown statistics sort field.');
  }
  if (direction && direction !== 'asc' && direction !== 'desc') {
    throw new StatisticsRequestError('invalid_sort', 'Sort direction must be asc or desc.');
  }
  return {
    field: (field as StatisticsSortField) ?? 'activity',
    direction: (direction as StatisticsSortDirection) ?? 'desc',
  };
}

/** Strictly parses the documented GET query into a canonical aggregate request. */
export function parseStatisticsRequest(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): StatisticsAggregateRequest {
  assertAllowedKeys(searchParams, AGGREGATE_QUERY_KEYS);
  const view = searchParams.get('view');
  if (view && view !== 'aggregate') {
    throw new StatisticsRequestError('invalid_view', 'Unsupported statistics view.');
  }
  const sort = parseSort(searchParams);
  return {
    range: parseRange(searchParams, now),
    filters: parseFilters(searchParams),
    ...(sort ? { sort } : {}),
  };
}

/** Strictly parses the bounded metadata-only detail query. */
export function parseStatisticsDetailRequest(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): StatisticsDetailRequest {
  assertAllowedKeys(searchParams, DETAIL_QUERY_KEYS);
  const kind = searchParams.get('kind') ?? 'runs';
  if (!DETAIL_KINDS.has(kind as StatisticsDetailKind)) {
    throw new StatisticsRequestError('invalid_kind', 'Unknown statistics detail kind.');
  }
  const cursor = searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && !SAFE_CURSOR.test(cursor)) {
    throw new StatisticsRequestError('invalid_cursor', 'Invalid statistics detail cursor.');
  }
  const rawLimit = searchParams.get('limit');
  let limit = STATISTICS_DEFAULT_DETAIL_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) {
      throw new StatisticsRequestError('invalid_limit', 'Invalid statistics detail limit.');
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > STATISTICS_MAX_DETAIL_LIMIT) {
      throw new StatisticsRequestError(
        'invalid_limit',
        `Detail limit must be between 1 and ${STATISTICS_MAX_DETAIL_LIMIT}.`,
      );
    }
  }
  return {
    range: parseRange(searchParams, now),
    filters: parseFilters(searchParams),
    kind: kind as StatisticsDetailKind,
    ...(cursor !== undefined ? { cursor } : {}),
    limit,
  };
}

/** Strictly parses a two-cohort revision comparison query. */
export function parseStatisticsComparisonRequest(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): StatisticsComparisonRequest {
  assertAllowedKeys(searchParams, COMPARE_QUERY_KEYS);
  const range = parseRange(searchParams, now);
  const cohort = (prefix: 'baseline' | 'candidate'): StatisticsCohortSelector => {
    const revisionIds = parseValues(
      searchParams,
      `${prefix}RevisionId`,
      value => SAFE_IDENTIFIER.test(value),
    );
    const from = searchParams.get(`${prefix}From`);
    const to = searchParams.get(`${prefix}To`);
    if ((from && !to) || (!from && to)) {
      throw new StatisticsRequestError(
        'invalid_cohort',
        `${prefix} range requires both ${prefix}From and ${prefix}To.`,
      );
    }
    const cohortRange = from && to
      ? assertRange({ from, to }, `${prefix}From`, `${prefix}To`)
      : undefined;
    if (!revisionIds && !cohortRange) {
      throw new StatisticsRequestError(
        'invalid_cohort',
        `${prefix} cohort requires a revision id or a date range.`,
      );
    }
    return {
      ...(revisionIds ? { revisionIds } : {}),
      ...(cohortRange ? { range: cohortRange } : {}),
    };
  };
  return {
    range,
    filters: parseFilters(searchParams),
    baseline: cohort('baseline'),
    candidate: cohort('candidate'),
  };
}

export type StatisticsQuery =
  | { view: 'aggregate'; request: StatisticsAggregateRequest }
  | { view: 'detail'; request: StatisticsDetailRequest }
  | { view: 'compare'; request: StatisticsComparisonRequest };

/** Dispatches the `view` parameter to the matching bounded request parser. */
export function parseStatisticsQuery(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): StatisticsQuery {
  const view = searchParams.get('view') ?? 'aggregate';
  if (searchParams.getAll('view').length > 1) {
    throw new StatisticsRequestError('invalid_view', 'view may only be supplied once.');
  }
  switch (view) {
    case 'aggregate':
      return { view, request: parseStatisticsRequest(searchParams, now) };
    case 'detail':
      return { view, request: parseStatisticsDetailRequest(searchParams, now) };
    case 'compare':
      return { view, request: parseStatisticsComparisonRequest(searchParams, now) };
    default:
      throw new StatisticsRequestError('invalid_view', 'Unsupported statistics view.');
  }
}

type DurationKey =
  | 'runDuration'
  | 'providerDuration'
  | 'stepDuration'
  | 'toolDuration'
  | 'subflowDuration'
  | 'subflowWaitDuration';

const DURATION_KEYS: DurationKey[] = [
  'runDuration', 'providerDuration', 'stepDuration', 'toolDuration',
  'subflowDuration', 'subflowWaitDuration',
];

interface MutableCache {
  requests: number;
  hits: number;
  misses: number;
  writes: number;
  unknown: number;
}

type MutableSummary = Omit<
  StatisticsSummary,
  DurationKey | 'usage' | 'cache' | 'toolPayload' | 'errorClasses' | 'contentCategories' | 'phases'
> & {
  usage: StatisticsUsageTotals;
  durations: Record<DurationKey, number[]>;
  cache: MutableCache;
  payload: { request: number[]; response: number[] };
  errorClasses: Partial<Record<StatisticsErrorClass, number>>;
  contentCategories: Partial<Record<StatisticsContentCategory, number>>;
  phases: Partial<Record<StatisticsPhase, number[]>>;
};

interface MutableRanking {
  id: string;
  name?: string;
  summary: MutableSummary;
}

type AttemptContribution = Pick<
  ModelAttemptStatisticsEvent,
  'timestamp' | 'model' | 'provider' | 'credentialId' | 'node' | 'outcome' | 'durationMs'
  | 'usage' | 'errorClass' | 'invocationId' | 'attemptId' | 'cacheOutcome' | 'phases' | 'payload'
>;
type NodeContribution = Pick<
  NodeVisitStatisticsEvent,
  'timestamp' | 'node' | 'outcome' | 'durationMs' | 'errorClass' | 'phases'
>;
type ToolContribution = Pick<
  ToolInvocationStatisticsEvent,
  'timestamp' | 'tool' | 'node' | 'provider' | 'outcome' | 'durationMs' | 'errorClass'
  | 'invocationId' | 'payload' | 'cacheOutcome' | 'phases'
>;
type SubflowContribution = Pick<
  SubflowInvocationStatisticsEvent,
  'timestamp' | 'subflow' | 'node' | 'mode' | 'outcome' | 'durationMs' | 'waitMs'
  | 'childRunId' | 'invocationId' | 'errorClass' | 'phases'
>;
type SkipContribution = Pick<
  Extract<StatisticsEvent, { type: 'scheduler.skip' }>,
  'timestamp' | 'source' | 'plannedExecution'
>;

interface RunBundle {
  runId: string;
  earliestDay: string;
  earliestTimestamp: string;
  personaAttribution?: PersonaAttribution;
  anchorDay?: string;
  anchorTimestamp?: string;
  source?: StatisticsRunSource;
  flow?: { id: string; name?: string };
  plannedExecution?: { id: string; name?: string };
  parentRunId?: string;
  revisionId?: string;
  outcome?: StatisticsRunOutcome;
  errorClass?: StatisticsErrorClass;
  durationMs?: number;
  paused: boolean;
  hasLifecycle: boolean;
  attempts: AttemptContribution[];
  nodes: NodeContribution[];
  tools: ToolContribution[];
  subflows: SubflowContribution[];
  /** Logical invocation ids already recorded, so duplicates cannot double count. */
  toolInvocationIds: Set<string>;
  subflowInvocationIds: Set<string>;
  attemptIds: Set<string>;
}

interface CacheEntry {
  createdAt: number;
  freshness: StatisticsPartitionMetadata[];
  response: StatisticsAggregateResponse;
}

const aggregateCache = new Map<string, CacheEntry>();

export function _clearStatisticsAggregateCacheForTests(): void {
  aggregateCache.clear();
}

function emptyUsage(): StatisticsUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
}

function emptyMutableSummary(): MutableSummary {
  return {
    runs: 0,
    successes: 0,
    errors: 0,
    capped: 0,
    cancelled: 0,
    paused: 0,
    schedulerSkips: 0,
    providerAttempts: 0,
    providerErrors: 0,
    nodeVisits: 0,
    nodeErrors: 0,
    toolCalls: 0,
    toolFailures: 0,
    usage: emptyUsage(),
    peakContextUtilization: 0,
    subflowCalls: 0,
    subflowFailures: 0,
    subflowIncomplete: 0,
    runsIncomplete: 0,
    durations: {
      runDuration: [],
      providerDuration: [],
      stepDuration: [],
      toolDuration: [],
      subflowDuration: [],
      subflowWaitDuration: [],
    },
    cache: { requests: 0, hits: 0, misses: 0, writes: 0, unknown: 0 },
    payload: { request: [], response: [] },
    errorClasses: {},
    contentCategories: {},
    phases: {},
  };
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile: rank = ceil(p * sample count), with a minimum rank of one. */
export function statisticsPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)];
}

function durationMetrics(values: readonly number[]): StatisticsDurationMetrics {
  const totalMs = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    totalMs,
    averageMs: values.length === 0 ? 0 : round(totalMs / values.length),
    p50Ms: statisticsPercentile(values, 0.5),
    p95Ms: statisticsPercentile(values, 0.95),
  };
}

function sizeMetrics(values: readonly number[]): StatisticsSizeMetrics {
  const totalBytes = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    totalBytes,
    averageBytes: values.length === 0 ? 0 : round(totalBytes / values.length),
    p50Bytes: statisticsPercentile(values, 0.5),
    p95Bytes: statisticsPercentile(values, 0.95),
  };
}

function finalizeCache(value: MutableCache): StatisticsCacheTotals {
  return {
    requests: value.requests,
    hits: value.hits,
    misses: value.misses,
    writes: value.writes,
    unknown: value.unknown,
    // Denominator is only the calls that explicitly reported cache behaviour.
    hitRate: value.requests === 0 ? 0 : round(value.hits / value.requests, 6),
  };
}

function finalizeSummary(value: MutableSummary): StatisticsSummary {
  const phases: StatisticsSummary['phases'] = {};
  for (const [phase, values] of Object.entries(value.phases) as [StatisticsPhase, number[]][]) {
    if (values.length > 0) phases[phase] = durationMetrics(values);
  }
  return {
    runs: value.runs,
    successes: value.successes,
    errors: value.errors,
    capped: value.capped,
    cancelled: value.cancelled,
    paused: value.paused,
    schedulerSkips: value.schedulerSkips,
    providerAttempts: value.providerAttempts,
    providerErrors: value.providerErrors,
    nodeVisits: value.nodeVisits,
    nodeErrors: value.nodeErrors,
    toolCalls: value.toolCalls,
    toolFailures: value.toolFailures,
    usage: { ...value.usage },
    peakContextUtilization: round(value.peakContextUtilization, 6),
    runDuration: durationMetrics(value.durations.runDuration),
    providerDuration: durationMetrics(value.durations.providerDuration),
    stepDuration: durationMetrics(value.durations.stepDuration),
    toolDuration: durationMetrics(value.durations.toolDuration),
    subflowCalls: value.subflowCalls,
    subflowFailures: value.subflowFailures,
    subflowIncomplete: value.subflowIncomplete,
    runsIncomplete: value.runsIncomplete,
    subflowDuration: durationMetrics(value.durations.subflowDuration),
    subflowWaitDuration: durationMetrics(value.durations.subflowWaitDuration),
    cache: finalizeCache(value.cache),
    toolPayload: {
      request: sizeMetrics(value.payload.request),
      response: sizeMetrics(value.payload.response),
    },
    errorClasses: { ...value.errorClasses },
    contentCategories: { ...value.contentCategories },
    phases,
  };
}

function addUsage(target: MutableSummary, usage: StatisticsUsage | undefined): void {
  if (!usage) return;
  target.usage.inputTokens += usage.inputTokens ?? 0;
  target.usage.outputTokens += usage.outputTokens ?? 0;
  target.usage.totalTokens += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  target.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
  target.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  if (usage.contextWindow && usage.inputTokens !== undefined) {
    target.peakContextUtilization = Math.max(
      target.peakContextUtilization,
      usage.inputTokens / usage.contextWindow,
    );
  }
}

function addErrorClass(target: MutableSummary, errorClass: StatisticsErrorClass | undefined): void {
  if (!errorClass) return;
  target.errorClasses[errorClass] = (target.errorClasses[errorClass] ?? 0) + 1;
}

function addPhases(target: MutableSummary, phases: StatisticsPhaseTimings | undefined): void {
  if (!phases) return;
  for (const [phase, value] of Object.entries(phases) as [StatisticsPhase, number][]) {
    (target.phases[phase] ??= []).push(value);
  }
}

/**
 * Cache accounting. Only explicit hit/miss/write outcomes enter the
 * denominator; `unknown` and `unsupported` are tracked separately so an
 * unsupported provider can never look like a 0% cache hit rate.
 */
function addCacheOutcome(target: MutableSummary, outcome: StatisticsCacheOutcome | undefined): void {
  if (!outcome) return;
  if (outcome === 'unknown' || outcome === 'unsupported') {
    target.cache.unknown += 1;
    return;
  }
  target.cache.requests += 1;
  if (outcome === 'hit') target.cache.hits += 1;
  else if (outcome === 'miss') target.cache.misses += 1;
  else if (outcome === 'write') target.cache.writes += 1;
  else if (outcome === 'mixed') {
    // A mixed call both read and wrote cache; it counts once as a request.
    target.cache.hits += 1;
    target.cache.writes += 1;
  }
}

function addToolPayload(target: MutableSummary, tool: ToolContribution): void {
  const payload = tool.payload;
  if (!payload) return;
  if (payload.requestBytes !== undefined) target.payload.request.push(payload.requestBytes);
  if (payload.responseBytes !== undefined) target.payload.response.push(payload.responseBytes);
  for (const category of [payload.requestCategory, payload.responseCategory]) {
    if (!category) continue;
    target.contentCategories[category] = (target.contentCategories[category] ?? 0) + 1;
  }
}

function mergeSummary(target: MutableSummary, source: MutableSummary): void {
  target.runs += source.runs;
  target.successes += source.successes;
  target.errors += source.errors;
  target.capped += source.capped;
  target.cancelled += source.cancelled;
  target.paused += source.paused;
  target.schedulerSkips += source.schedulerSkips;
  target.providerAttempts += source.providerAttempts;
  target.providerErrors += source.providerErrors;
  target.nodeVisits += source.nodeVisits;
  target.nodeErrors += source.nodeErrors;
  target.toolCalls += source.toolCalls;
  target.toolFailures += source.toolFailures;
  target.subflowCalls += source.subflowCalls;
  target.subflowFailures += source.subflowFailures;
  target.subflowIncomplete += source.subflowIncomplete;
  target.runsIncomplete += source.runsIncomplete;
  for (const key of Object.keys(target.usage) as (keyof StatisticsUsageTotals)[]) {
    target.usage[key] += source.usage[key];
  }
  target.peakContextUtilization = Math.max(
    target.peakContextUtilization,
    source.peakContextUtilization,
  );
  for (const key of DURATION_KEYS) {
    target.durations[key].push(...source.durations[key]);
  }
  target.cache.requests += source.cache.requests;
  target.cache.hits += source.cache.hits;
  target.cache.misses += source.cache.misses;
  target.cache.writes += source.cache.writes;
  target.cache.unknown += source.cache.unknown;
  target.payload.request.push(...source.payload.request);
  target.payload.response.push(...source.payload.response);
  for (const [key, count] of Object.entries(source.errorClasses) as [StatisticsErrorClass, number][]) {
    target.errorClasses[key] = (target.errorClasses[key] ?? 0) + count;
  }
  for (const [key, count] of Object.entries(source.contentCategories) as [StatisticsContentCategory, number][]) {
    target.contentCategories[key] = (target.contentCategories[key] ?? 0) + count;
  }
  for (const [key, values] of Object.entries(source.phases) as [StatisticsPhase, number[]][]) {
    (target.phases[key] ??= []).push(...values);
  }
}

function rankingEntry(
  rankings: Map<string, MutableRanking>,
  id: string,
  name?: string,
): MutableRanking {
  let entry = rankings.get(id);
  if (!entry) {
    entry = { id, ...(name ? { name } : {}), summary: emptyMutableSummary() };
    rankings.set(id, entry);
  } else if (!entry.name && name) {
    entry.name = name;
  }
  return entry;
}

function recordRunOutcome(target: MutableSummary, run: RunBundle): void {
  if (!run.hasLifecycle) return;
  target.runs += 1;
  if (run.outcome === 'completed') target.successes += 1;
  if (run.outcome === 'error') target.errors += 1;
  if (run.outcome === 'capped') target.capped += 1;
  if (run.outcome === 'cancelled') target.cancelled += 1;
  if (!run.outcome && run.paused) target.paused += 1;
  // Started, never terminal, never paused: an abandoned/crashed span. Tracked
  // explicitly instead of being folded into successes or failures.
  if (!run.outcome && !run.paused) target.runsIncomplete += 1;
  if (run.outcome === 'error') addErrorClass(target, run.errorClass);
  if (run.durationMs !== undefined) target.durations.runDuration.push(run.durationMs);
}

function addAttempt(target: MutableSummary, attempt: AttemptContribution): void {
  target.providerAttempts += 1;
  if (attempt.outcome === 'error') {
    target.providerErrors += 1;
    addErrorClass(target, attempt.errorClass);
  }
  target.durations.providerDuration.push(attempt.durationMs);
  addUsage(target, attempt.usage);
  addCacheOutcome(target, attempt.cacheOutcome);
  addPhases(target, attempt.phases);
}

function addNode(target: MutableSummary, node: NodeContribution): void {
  target.nodeVisits += 1;
  if (node.outcome === 'error') {
    target.nodeErrors += 1;
    addErrorClass(target, node.errorClass);
  }
  target.durations.stepDuration.push(node.durationMs);
  addPhases(target, node.phases);
}

function addTool(target: MutableSummary, tool: ToolContribution): void {
  target.toolCalls += 1;
  if (tool.outcome === 'error') {
    target.toolFailures += 1;
    addErrorClass(target, tool.errorClass);
  }
  target.durations.toolDuration.push(tool.durationMs);
  addToolPayload(target, tool);
  addCacheOutcome(target, tool.cacheOutcome);
  addPhases(target, tool.phases);
}

function addSubflow(target: MutableSummary, subflow: SubflowContribution): void {
  target.subflowCalls += 1;
  if (subflow.outcome === 'error') {
    target.subflowFailures += 1;
    addErrorClass(target, subflow.errorClass);
  }
  // Cancelled, timed out, or never finished: never a success, never a failure.
  if (subflow.outcome === 'cancelled' || subflow.outcome === 'timeout' || subflow.outcome === 'incomplete') {
    target.subflowIncomplete += 1;
  }
  target.durations.subflowDuration.push(subflow.durationMs);
  if (subflow.waitMs !== undefined) target.durations.subflowWaitDuration.push(subflow.waitMs);
  addPhases(target, subflow.phases);
}

function matches(values: readonly string[] | undefined, value: string | undefined): boolean {
  return !values || (value !== undefined && values.includes(value));
}

function attemptNodeMatches(filters: StatisticsFilters, nodeId: string | undefined): boolean {
  return !filters.nodeIds || (nodeId !== undefined && filters.nodeIds.includes(nodeId));
}

function matchingAttempts(run: RunBundle, filters: StatisticsFilters): AttemptContribution[] {
  return run.attempts.filter(attempt => (
    matches(filters.modelIds, attempt.model.id)
    && matches(filters.providerIds, attempt.provider.id)
    && matches(filters.credentialIds, attempt.credentialId)
    && attemptNodeMatches(filters, attempt.node?.id)
    && (!filters.cacheOutcomes || (
      attempt.cacheOutcome !== undefined && filters.cacheOutcomes.includes(attempt.cacheOutcome)
    ))
  ));
}

function matchingNodes(run: RunBundle, filters: StatisticsFilters): NodeContribution[] {
  return run.nodes.filter(node => matches(filters.nodeIds, node.node.id));
}

function matchingTools(run: RunBundle, filters: StatisticsFilters): ToolContribution[] {
  return run.tools.filter(tool => (
    matches(filters.toolIds, tool.tool.id)
    && attemptNodeMatches(filters, tool.node?.id)
    && (!filters.cacheOutcomes || (
      tool.cacheOutcome !== undefined && filters.cacheOutcomes.includes(tool.cacheOutcome)
    ))
    && (!filters.contentCategories || [
      tool.payload?.requestCategory,
      tool.payload?.responseCategory,
    ].some(category => category !== undefined && filters.contentCategories!.includes(category)))
  ));
}

function matchingSubflows(run: RunBundle, filters: StatisticsFilters): SubflowContribution[] {
  return run.subflows.filter(subflow => (
    matches(filters.subflowIds, subflow.subflow.id)
    && (!filters.subflowModes || filters.subflowModes.includes(subflow.mode))
    && attemptNodeMatches(filters, subflow.node?.id)
  ));
}

function runMatches(run: RunBundle, filters: StatisticsFilters): boolean {
  if (!matches(filters.personaIds, run.personaAttribution?.personaId)) return false;
  if (!matches(filters.activityIds, run.personaAttribution?.activityId)) return false;
  if (!matches(filters.behaviorRevisionIds, run.personaAttribution?.behaviorRevisionId)) return false;
  if (!matches(filters.flowIds, run.flow?.id)) return false;
  if (!matches(filters.plannedExecutionIds, run.plannedExecution?.id)) return false;
  if (!matches(filters.sources, run.source)) return false;
  if (!matches(filters.revisionIds, run.revisionId)) return false;
  if (!matches(filters.parentRunIds, run.parentRunId)) return false;
  const status: StatisticsStatusFilter | undefined = run.outcome ?? (run.paused ? 'paused' : undefined);
  if (filters.statuses && (!status || !filters.statuses.includes(status))) return false;

  const hasAttemptFilters = Boolean(
    filters.modelIds || filters.providerIds || filters.credentialIds,
  );
  const hasToolFilters = Boolean(filters.toolIds || filters.contentCategories);
  const hasSubflowFilters = Boolean(filters.subflowIds || filters.subflowModes);
  if (hasAttemptFilters && matchingAttempts(run, filters).length === 0) return false;
  if (hasToolFilters && matchingTools(run, filters).length === 0) return false;
  if (hasSubflowFilters && matchingSubflows(run, filters).length === 0) return false;
  if (filters.cacheOutcomes
    && matchingAttempts(run, filters).length === 0
    && matchingTools(run, filters).length === 0) return false;
  if (filters.nodeIds
    && matchingNodes(run, filters).length === 0
    && matchingAttempts(run, filters).length === 0
    && matchingTools(run, filters).length === 0
    && matchingSubflows(run, filters).length === 0) return false;
  return true;
}

function skipMatches(
  event: SkipContribution,
  filters: StatisticsFilters,
): boolean {
  if (
    filters.flowIds || filters.modelIds || filters.providerIds || filters.credentialIds
    || filters.nodeIds || filters.toolIds || filters.subflowIds || filters.subflowModes
    || filters.revisionIds || filters.cacheOutcomes || filters.contentCategories
    || filters.parentRunIds || filters.personaIds || filters.activityIds
    || filters.behaviorRevisionIds
  ) return false;
  if (!matches(filters.plannedExecutionIds, event.plannedExecution.id)) return false;
  if (!matches(filters.sources, event.source)) return false;
  return !filters.statuses || filters.statuses.includes('skipped');
}

function canonicalFilters(filters: StatisticsFilters): StatisticsFilters {
  const sorted = (values: readonly string[] | undefined) => values
    ? [...new Set(values)].sort()
    : undefined;
  const result: Record<string, readonly string[]> = {};
  for (const key of ALLOWED_FILTER_KEYS) {
    const values = sorted(filters[key] as readonly string[] | undefined);
    if (values) result[key] = values;
  }
  return result as StatisticsFilters;
}

function canonicalRequest(request: StatisticsAggregateRequest): StatisticsAggregateRequest {
  return {
    range: { ...request.range },
    filters: canonicalFilters(request.filters ?? {}),
    ...(request.sort ? { sort: { ...request.sort } } : {}),
  };
}

async function partitionFreshness(days: readonly string[]): Promise<StatisticsPartitionMetadata[]> {
  return Promise.all(days.map(day => getStatisticsPartitionMetadata(day)));
}

function sameFreshness(
  left: readonly StatisticsPartitionMetadata[],
  right: readonly StatisticsPartitionMetadata[],
): boolean {
  return left.length === right.length && left.every((value, index) => (
    value.day === right[index].day
    && value.exists === right[index].exists
    && value.mtimeMs === right[index].mtimeMs
    && value.size === right[index].size
  ));
}

function pruneCache(now: number): void {
  for (const [key, entry] of aggregateCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) aggregateCache.delete(key);
  }
  while (aggregateCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = aggregateCache.keys().next().value as string | undefined;
    if (!oldest) break;
    aggregateCache.delete(oldest);
  }
}

function sortValue(row: StatisticsRankingRow, field: StatisticsSortField): number {
  switch (field) {
    case 'runs': return row.runs;
    case 'errors': return row.errors;
    case 'failureRate': return row.runs === 0 ? 0 : row.errors / row.runs;
    case 'providerAttempts': return row.providerAttempts;
    case 'providerErrors': return row.providerErrors;
    case 'nodeVisits': return row.nodeVisits;
    case 'toolCalls': return row.toolCalls;
    case 'toolFailures': return row.toolFailures;
    case 'subflowCalls': return row.subflowCalls;
    case 'tokens': return row.usage.totalTokens;
    case 'duration': return row.runDuration.totalMs + row.providerDuration.totalMs + row.toolDuration.totalMs;
    case 'cacheHitRate': return row.cache.hitRate;
    case 'requestBytes': return row.toolPayload.request.totalBytes;
    case 'responseBytes': return row.toolPayload.response.totalBytes;
    case 'id': return 0;
    case 'activity':
    default:
      return row.runs + row.schedulerSkips + row.providerAttempts + row.nodeVisits
        + row.toolCalls + row.subflowCalls;
  }
}

/** Deterministic ordering: requested metric first, then id as a stable tiebreak. */
function sortRankingRows(
  rows: StatisticsRankingRow[],
  sort: StatisticsSort | undefined,
): StatisticsRankingRow[] {
  const field = sort?.field ?? 'activity';
  const direction = sort?.direction ?? 'desc';
  const sign = direction === 'asc' ? 1 : -1;
  return rows.sort((left, right) => {
    if (field === 'id') return sign * left.id.localeCompare(right.id);
    const delta = sortValue(left, field) - sortValue(right, field);
    if (delta !== 0) return sign * delta;
    return left.id.localeCompare(right.id);
  });
}

function rankingRows(
  values: Map<string, MutableRanking>,
  sort: StatisticsSort | undefined,
): { rows: StatisticsRankingRow[]; truncated: boolean } {
  const rows = sortRankingRows(
    [...values.values()].map(value => ({
      id: value.id,
      ...(value.name ? { name: value.name } : {}),
      ...finalizeSummary(value.summary),
    })),
    sort,
  );
  return {
    rows: rows.slice(0, STATISTICS_MAX_RANKING_ROWS),
    truncated: rows.length > STATISTICS_MAX_RANKING_ROWS,
  };
}

function revisionOf(revisions: { flowRevisionId?: string; promptRevisionId?: string; nodeConfigRevisionId?: string } | undefined): string | undefined {
  if (!revisions) return undefined;
  return revisions.flowRevisionId ?? revisions.promptRevisionId ?? revisions.nodeConfigRevisionId;
}

function updateRun(bundle: RunBundle, event: Exclude<StatisticsEvent, { type: 'scheduler.skip' }>): void {
  const day = event.timestamp.slice(0, 10);
  if (day < bundle.earliestDay) bundle.earliestDay = day;
  if (event.timestamp < bundle.earliestTimestamp) bundle.earliestTimestamp = event.timestamp;
  if (!bundle.personaAttribution && event.personaAttribution) {
    bundle.personaAttribution = { ...event.personaAttribution };
  }
  switch (event.type) {
    case 'run.started':
      bundle.hasLifecycle = true;
      bundle.anchorDay ??= day;
      bundle.anchorTimestamp ??= event.timestamp;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      bundle.parentRunId ??= event.parentRunId;
      bundle.revisionId ??= revisionOf(event.revisions);
      break;
    case 'run.paused':
      bundle.hasLifecycle = true;
      bundle.paused = true;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      bundle.durationMs = event.durationMs;
      bundle.parentRunId ??= event.parentRunId;
      bundle.revisionId ??= revisionOf(event.revisions);
      break;
    case 'run.finished':
      bundle.hasLifecycle = true;
      bundle.anchorDay = day;
      bundle.anchorTimestamp = event.timestamp;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      bundle.outcome = event.outcome;
      bundle.errorClass = event.errorClass;
      bundle.durationMs = event.durationMs;
      bundle.parentRunId ??= event.parentRunId;
      bundle.revisionId ??= revisionOf(event.revisions);
      break;
    case 'node.visit':
      bundle.flow ??= event.flow;
      bundle.revisionId ??= revisionOf(event.revisions);
      bundle.nodes.push({
        timestamp: event.timestamp,
        node: event.node,
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        ...(event.phases ? { phases: event.phases } : {}),
      });
      break;
    case 'model.attempt': {
      // A repeated attemptId is a duplicate observation of the same attempt.
      if (event.attemptId) {
        if (bundle.attemptIds.has(event.attemptId)) break;
        bundle.attemptIds.add(event.attemptId);
      }
      bundle.attempts.push({
        timestamp: event.timestamp,
        model: event.model,
        provider: event.provider,
        ...(event.credentialId ? { credentialId: event.credentialId } : {}),
        ...(event.node ? { node: event.node } : {}),
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        ...(event.invocationId ? { invocationId: event.invocationId } : {}),
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.cacheOutcome ? { cacheOutcome: event.cacheOutcome } : {}),
        ...(event.phases ? { phases: event.phases } : {}),
        ...(event.payload ? { payload: event.payload } : {}),
      });
      break;
    }
    case 'tool.invocation': {
      // One logical invocation is counted once, even when both ModelHandler and
      // a self-orchestrating adapter observe the same call.
      if (event.invocationId) {
        if (bundle.toolInvocationIds.has(event.invocationId)) break;
        bundle.toolInvocationIds.add(event.invocationId);
      }
      bundle.tools.push({
        timestamp: event.timestamp,
        tool: event.tool,
        ...(event.node ? { node: event.node } : {}),
        ...(event.provider ? { provider: event.provider } : {}),
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        ...(event.invocationId ? { invocationId: event.invocationId } : {}),
        ...(event.payload ? { payload: event.payload } : {}),
        ...(event.cacheOutcome ? { cacheOutcome: event.cacheOutcome } : {}),
        ...(event.phases ? { phases: event.phases } : {}),
      });
      break;
    }
    case 'subflow.invocation': {
      if (event.invocationId) {
        if (bundle.subflowInvocationIds.has(event.invocationId)) break;
        bundle.subflowInvocationIds.add(event.invocationId);
      }
      bundle.subflows.push({
        timestamp: event.timestamp,
        subflow: event.subflow,
        ...(event.node ? { node: event.node } : {}),
        mode: event.mode,
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
        ...(event.childRunId ? { childRunId: event.childRunId } : {}),
        ...(event.invocationId ? { invocationId: event.invocationId } : {}),
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        ...(event.phases ? { phases: event.phases } : {}),
      });
      break;
    }
  }
}

function validFilterArray(
  values: readonly string[] | undefined,
  validator: (value: string) => boolean,
): boolean {
  return values === undefined || (
    Array.isArray(values)
    && values.length > 0
    && values.length <= MAX_FILTER_VALUES
    && values.every(value => typeof value === 'string' && validator(value))
  );
}

function validateFilters(filters: StatisticsFilters): void {
  if (Object.keys(filters).some(key => !ALLOWED_FILTER_KEYS.has(key as keyof StatisticsFilters))) {
    throw new StatisticsRequestError('invalid_filter', 'Invalid statistics filter.');
  }
  if (
    !validFilterArray(filters.personaIds, value => SAFE_PERSONA_ATTRIBUTION_ID.test(value))
    || !validFilterArray(filters.activityIds, value => SAFE_PERSONA_ATTRIBUTION_ID.test(value))
    || !validFilterArray(filters.behaviorRevisionIds, value => SAFE_PERSONA_ATTRIBUTION_ID.test(value))
    || !validFilterArray(filters.flowIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.plannedExecutionIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.sources, value => RUN_SOURCES.has(value as StatisticsRunSource))
    || !validFilterArray(filters.statuses, value => STATUSES.has(value as StatisticsStatusFilter))
    || !validFilterArray(filters.modelIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.providerIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.credentialIds, value => SAFE_CREDENTIAL.test(value))
    || !validFilterArray(filters.nodeIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.toolIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.subflowIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.subflowModes, value => SUBFLOW_MODES.has(value as StatisticsSubflowMode))
    || !validFilterArray(filters.revisionIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.cacheOutcomes, value => CACHE_OUTCOMES.has(value as StatisticsCacheOutcome))
    || !validFilterArray(filters.contentCategories, value => CONTENT_CATEGORIES.has(value as StatisticsContentCategory))
    || !validFilterArray(filters.parentRunIds, value => SAFE_IDENTIFIER.test(value))
  ) {
    throw new StatisticsRequestError('invalid_filter', 'Invalid statistics filter.');
  }
}

function validateAggregateRequest(request: StatisticsAggregateRequest): void {
  assertRange(request.range);
  validateFilters(request.filters ?? {});
  if (request.sort) {
    if (!SORT_FIELDS.has(request.sort.field)) {
      throw new StatisticsRequestError('invalid_sort', 'Unknown statistics sort field.');
    }
    if (request.sort.direction !== 'asc' && request.sort.direction !== 'desc') {
      throw new StatisticsRequestError('invalid_sort', 'Sort direction must be asc or desc.');
    }
  }
}

interface LoadedEvents {
  runs: Map<string, RunBundle>;
  skips: SkipContribution[];
}

/** Reads the selected partitions once, deduplicating by event id and run id. */
async function loadEvents(days: readonly string[]): Promise<LoadedEvents> {
  const runs = new Map<string, RunBundle>();
  const skips: SkipContribution[] = [];
  const eventIds = new Set<string>();

  for (const day of days) {
    const events = await readStatisticsEvents(day);
    for (const event of events) {
      if (eventIds.has(event.eventId)) continue;
      eventIds.add(event.eventId);
      if (event.type === 'scheduler.skip') {
        skips.push({
          timestamp: event.timestamp,
          source: event.source,
          plannedExecution: event.plannedExecution,
        });
        continue;
      }
      // Fire/queue admission is event-level scheduler metadata. The matching
      // run lifecycle records remain the sole source of logical-run counts.
      if (event.type === 'scheduler.fire') continue;
      let bundle = runs.get(event.runId);
      if (!bundle) {
        bundle = {
          runId: event.runId,
          earliestDay: event.timestamp.slice(0, 10),
          earliestTimestamp: event.timestamp,
          paused: false,
          hasLifecycle: false,
          attempts: [],
          nodes: [],
          tools: [],
          subflows: [],
          toolInvocationIds: new Set<string>(),
          subflowInvocationIds: new Set<string>(),
          attemptIds: new Set<string>(),
        };
        runs.set(event.runId, bundle);
      }
      updateRun(bundle, event);
    }
  }
  return { runs, skips };
}

/**
 * Aggregates only selected daily partitions. Run-level filters are linked by
 * runId; model/provider/credential filters include runs having a matching
 * provider attempt, while only matching attempts contribute attempt metrics.
 * The same rule applies to node, tool, subflow, cache, and content filters.
 *
 * A subflow CALL is parent-side metadata: it never inflates logical-run counts,
 * because the child run reports its own lifecycle under its own runId.
 */
export async function aggregateStatistics(
  input: StatisticsAggregateRequest,
): Promise<StatisticsAggregateResponse> {
  validateAggregateRequest(input);
  const request = canonicalRequest(input);
  const days = daysInRange(request.range);
  const cacheKey = workspaceCacheKey(JSON.stringify(request));
  const now = Date.now();
  pruneCache(now);
  const freshness = await partitionFreshness(days);
  const cached = aggregateCache.get(cacheKey);
  if (cached && now - cached.createdAt <= CACHE_TTL_MS && sameFreshness(cached.freshness, freshness)) {
    aggregateCache.delete(cacheKey);
    aggregateCache.set(cacheKey, cached);
    return structuredClone(cached.response);
  }

  const { runs, skips } = await loadEvents(days);

  const summary = emptyMutableSummary();
  const daily = new Map(days.map(day => [day, emptyMutableSummary()]));
  const flowRankings = new Map<string, MutableRanking>();
  const plannedRankings = new Map<string, MutableRanking>();
  const modelRankings = new Map<string, MutableRanking>();
  const providerRankings = new Map<string, MutableRanking>();
  const credentialRankings = new Map<string, MutableRanking>();
  const nodeRankings = new Map<string, MutableRanking>();
  const toolRankings = new Map<string, MutableRanking>();
  const subflowRankings = new Map<string, MutableRanking>();
  const revisionRankings = new Map<string, MutableRanking>();
  const filters = request.filters ?? {};

  for (const run of runs.values()) {
    if (!runMatches(run, filters)) continue;
    const runSummary = emptyMutableSummary();
    recordRunOutcome(runSummary, run);
    const runDay = run.anchorDay ?? run.earliestDay;
    const runDaily = daily.get(runDay);
    if (runDaily) recordRunOutcome(runDaily, run);

    const attempts = matchingAttempts(run, filters);
    const modelsSeen = new Set<string>();
    const providersSeen = new Set<string>();
    const credentialsSeen = new Set<string>();
    const nodesSeen = new Set<string>();
    const toolsSeen = new Set<string>();
    const subflowsSeen = new Set<string>();

    for (const attempt of attempts) {
      addAttempt(runSummary, attempt);
      const attemptDaily = daily.get(attempt.timestamp.slice(0, 10));
      if (attemptDaily) addAttempt(attemptDaily, attempt);
      const model = rankingEntry(modelRankings, attempt.model.id, attempt.model.name);
      addAttempt(model.summary, attempt);
      const provider = rankingEntry(providerRankings, attempt.provider.id, attempt.provider.name);
      addAttempt(provider.summary, attempt);
      modelsSeen.add(attempt.model.id);
      providersSeen.add(attempt.provider.id);
      if (attempt.credentialId) {
        addAttempt(rankingEntry(credentialRankings, attempt.credentialId).summary, attempt);
        credentialsSeen.add(attempt.credentialId);
      }
      if (attempt.node) {
        addAttempt(rankingEntry(nodeRankings, attempt.node.id, attempt.node.name).summary, attempt);
        nodesSeen.add(attempt.node.id);
      }
    }

    for (const node of matchingNodes(run, filters)) {
      addNode(runSummary, node);
      const nodeDaily = daily.get(node.timestamp.slice(0, 10));
      if (nodeDaily) addNode(nodeDaily, node);
      addNode(rankingEntry(nodeRankings, node.node.id, node.node.name).summary, node);
      nodesSeen.add(node.node.id);
    }

    for (const tool of matchingTools(run, filters)) {
      addTool(runSummary, tool);
      const toolDaily = daily.get(tool.timestamp.slice(0, 10));
      if (toolDaily) addTool(toolDaily, tool);
      addTool(rankingEntry(toolRankings, tool.tool.id, tool.tool.name).summary, tool);
      toolsSeen.add(tool.tool.id);
      if (tool.node) {
        addTool(rankingEntry(nodeRankings, tool.node.id, tool.node.name).summary, tool);
        nodesSeen.add(tool.node.id);
      }
    }

    for (const subflow of matchingSubflows(run, filters)) {
      addSubflow(runSummary, subflow);
      const subflowDaily = daily.get(subflow.timestamp.slice(0, 10));
      if (subflowDaily) addSubflow(subflowDaily, subflow);
      addSubflow(
        rankingEntry(subflowRankings, subflow.subflow.id, subflow.subflow.name).summary,
        subflow,
      );
      subflowsSeen.add(subflow.subflow.id);
      if (subflow.node) {
        addSubflow(rankingEntry(nodeRankings, subflow.node.id, subflow.node.name).summary, subflow);
        nodesSeen.add(subflow.node.id);
      }
    }

    for (const id of modelsSeen) recordRunOutcome(modelRankings.get(id)!.summary, run);
    for (const id of providersSeen) recordRunOutcome(providerRankings.get(id)!.summary, run);
    for (const id of credentialsSeen) recordRunOutcome(credentialRankings.get(id)!.summary, run);
    for (const id of nodesSeen) recordRunOutcome(nodeRankings.get(id)!.summary, run);
    for (const id of toolsSeen) recordRunOutcome(toolRankings.get(id)!.summary, run);
    for (const id of subflowsSeen) recordRunOutcome(subflowRankings.get(id)!.summary, run);

    mergeSummary(summary, runSummary);
    if (run.flow) mergeSummary(rankingEntry(flowRankings, run.flow.id, run.flow.name).summary, runSummary);
    if (run.plannedExecution) {
      mergeSummary(
        rankingEntry(plannedRankings, run.plannedExecution.id, run.plannedExecution.name).summary,
        runSummary,
      );
    }
    if (run.revisionId) {
      mergeSummary(rankingEntry(revisionRankings, run.revisionId).summary, runSummary);
    }
  }

  for (const skip of skips) {
    if (!skipMatches(skip, filters)) continue;
    summary.schedulerSkips += 1;
    const skipDaily = daily.get(skip.timestamp.slice(0, 10));
    if (skipDaily) skipDaily.schedulerSkips += 1;
    rankingEntry(
      plannedRankings,
      skip.plannedExecution.id,
      skip.plannedExecution.name,
    ).summary.schedulerSkips += 1;
  }

  const sort = request.sort;
  const dimensions = {
    flows: rankingRows(flowRankings, sort),
    plannedExecutions: rankingRows(plannedRankings, sort),
    models: rankingRows(modelRankings, sort),
    providers: rankingRows(providerRankings, sort),
    credentials: rankingRows(credentialRankings, sort),
    nodes: rankingRows(nodeRankings, sort),
    tools: rankingRows(toolRankings, sort),
    subflows: rankingRows(subflowRankings, sort),
    revisions: rankingRows(revisionRankings, sort),
  };
  const truncatedDimensions = Object.entries(dimensions)
    .filter(([, value]) => value.truncated)
    .map(([key]) => key);

  const response: StatisticsAggregateResponse = {
    range: { ...request.range },
    filters: request.filters ?? {},
    ...(sort ? { sort } : {}),
    summary: finalizeSummary(summary),
    daily: days.map(date => ({ date, summary: finalizeSummary(daily.get(date)!) })),
    rankings: {
      flows: dimensions.flows.rows,
      plannedExecutions: dimensions.plannedExecutions.rows,
      models: dimensions.models.rows,
      providers: dimensions.providers.rows,
      credentials: dimensions.credentials.rows,
      nodes: dimensions.nodes.rows,
      tools: dimensions.tools.rows,
      subflows: dimensions.subflows.rows,
      revisions: dimensions.revisions.rows,
    },
    ...(truncatedDimensions.length > 0 ? { truncatedDimensions } : {}),
  };

  const finalFreshness = await partitionFreshness(days);
  if (sameFreshness(freshness, finalFreshness)) {
    aggregateCache.set(cacheKey, {
      createdAt: now,
      freshness: finalFreshness,
      response: structuredClone(response),
    });
  } else {
    // A concurrent append must not make a partially-read response look fresh.
    aggregateCache.delete(cacheKey);
  }
  return response;
}

function runStatus(run: RunBundle): StatisticsStatusFilter | 'incomplete' {
  if (run.outcome) return run.outcome;
  if (run.paused) return 'paused';
  return 'incomplete';
}

/**
 * Bounded, metadata-only detail rows for a selected dimension.
 *
 * Rows are sorted by timestamp (newest first) with an id tiebreak so cursor
 * pagination is stable, and the scan itself is capped. Nothing beyond the
 * allowlisted event metadata is exposed: no prompts, arguments, or results.
 */
export async function statisticsDetails(
  input: StatisticsDetailRequest,
): Promise<StatisticsDetailResponse> {
  assertRange(input.range);
  validateFilters(input.filters ?? {});
  if (!DETAIL_KINDS.has(input.kind)) {
    throw new StatisticsRequestError('invalid_kind', 'Unknown statistics detail kind.');
  }
  if (input.cursor !== undefined && !SAFE_CURSOR.test(input.cursor)) {
    throw new StatisticsRequestError('invalid_cursor', 'Invalid statistics detail cursor.');
  }
  const limit = Math.min(
    Math.max(1, input.limit ?? STATISTICS_DEFAULT_DETAIL_LIMIT),
    STATISTICS_MAX_DETAIL_LIMIT,
  );
  const filters = canonicalFilters(input.filters ?? {});
  const days = daysInRange(input.range);
  const { runs } = await loadEvents(days);

  const rows: StatisticsDetailRow[] = [];
  for (const run of runs.values()) {
    if (!runMatches(run, filters)) continue;
    if (input.kind === 'runs') {
      const attempts = matchingAttempts(run, filters);
      const tools = matchingTools(run, filters);
      const totalTokens = attempts.reduce((total, attempt) => (
        total + (attempt.usage?.totalTokens
          ?? ((attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0)))
      ), 0);
      rows.push({
        kind: 'run',
        runId: run.runId,
        day: run.anchorDay ?? run.earliestDay,
        timestamp: run.anchorTimestamp ?? run.earliestTimestamp,
        ...(run.personaAttribution ? { personaAttribution: { ...run.personaAttribution } } : {}),
        ...(run.source ? { source: run.source } : {}),
        ...(run.flow ? { flowId: run.flow.id, ...(run.flow.name ? { flowName: run.flow.name } : {}) } : {}),
        ...(run.plannedExecution ? { plannedExecutionId: run.plannedExecution.id } : {}),
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.revisionId ? { revisionId: run.revisionId } : {}),
        ...(run.outcome ? { outcome: run.outcome } : {}),
        status: runStatus(run),
        ...(run.errorClass ? { errorClass: run.errorClass } : {}),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        providerAttempts: attempts.length,
        nodeVisits: matchingNodes(run, filters).length,
        toolCalls: tools.length,
        toolFailures: tools.filter(tool => tool.outcome === 'error').length,
        subflowCalls: matchingSubflows(run, filters).length,
        totalTokens,
      });
    } else if (input.kind === 'tools') {
      for (const tool of matchingTools(run, filters)) {
        rows.push({
          kind: 'tool',
          runId: run.runId,
          timestamp: tool.timestamp,
          ...(tool.invocationId ? { invocationId: tool.invocationId } : {}),
          toolId: tool.tool.id,
          ...(tool.tool.name ? { toolName: tool.tool.name } : {}),
          toolKind: tool.tool.kind,
          ...(tool.node ? { nodeId: tool.node.id } : {}),
          ...(tool.provider ? { providerId: tool.provider.id } : {}),
          outcome: tool.outcome,
          ...(tool.errorClass ? { errorClass: tool.errorClass } : {}),
          durationMs: tool.durationMs,
          ...(tool.payload?.requestBytes !== undefined ? { requestBytes: tool.payload.requestBytes } : {}),
          ...(tool.payload?.responseBytes !== undefined ? { responseBytes: tool.payload.responseBytes } : {}),
          ...(tool.payload?.requestCategory ? { requestCategory: tool.payload.requestCategory } : {}),
          ...(tool.payload?.responseCategory ? { responseCategory: tool.payload.responseCategory } : {}),
          ...(tool.cacheOutcome ? { cacheOutcome: tool.cacheOutcome } : {}),
        });
      }
    } else {
      for (const subflow of matchingSubflows(run, filters)) {
        rows.push({
          kind: 'subflow',
          runId: run.runId,
          timestamp: subflow.timestamp,
          ...(subflow.invocationId ? { invocationId: subflow.invocationId } : {}),
          ...(subflow.childRunId ? { childRunId: subflow.childRunId } : {}),
          subflowId: subflow.subflow.id,
          ...(subflow.subflow.name ? { subflowName: subflow.subflow.name } : {}),
          mode: subflow.mode,
          ...(subflow.node ? { nodeId: subflow.node.id } : {}),
          outcome: subflow.outcome,
          ...(subflow.errorClass ? { errorClass: subflow.errorClass } : {}),
          durationMs: subflow.durationMs,
          ...(subflow.waitMs !== undefined ? { waitMs: subflow.waitMs } : {}),
        });
      }
    }
    if (rows.length >= STATISTICS_MAX_DETAIL_SCAN) break;
  }

  rows.sort((left, right) => (
    right.timestamp.localeCompare(left.timestamp)
    || left.runId.localeCompare(right.runId)
  ));

  const offset = input.cursor ? Number(input.cursor) : 0;
  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    range: { ...input.range },
    filters,
    kind: input.kind,
    limit,
    rows: page,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
    total: rows.length,
  };
}

function failureRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 6);
}

function comparisonMetrics(summary: StatisticsSummary): Record<StatisticsComparisonMetric, number> {
  return {
    runs: summary.runs,
    failureRate: failureRate(summary.errors, summary.runs),
    runDurationP95Ms: summary.runDuration.p95Ms,
    totalTokens: summary.usage.totalTokens,
    toolCalls: summary.toolCalls,
    toolFailureRate: failureRate(summary.toolFailures, summary.toolCalls),
    providerErrorRate: failureRate(summary.providerErrors, summary.providerAttempts),
    cacheHitRate: summary.cache.hitRate,
    subflowFailureRate: failureRate(summary.subflowFailures, summary.subflowCalls),
  };
}

/**
 * Compares exactly two revisions or two bounded cohorts under the SAME
 * dimension filters. The result is observational only: cohorts can differ in
 * traffic, provider, retry, and source mix, so sample sizes are always
 * returned alongside the deltas.
 */
export async function compareStatistics(
  input: StatisticsComparisonRequest,
): Promise<StatisticsComparisonResponse> {
  assertRange(input.range);
  validateFilters(input.filters ?? {});
  const filters = canonicalFilters(input.filters ?? {});

  const cohortOf = async (
    label: 'baseline' | 'candidate',
    selector: StatisticsCohortSelector,
  ): Promise<StatisticsComparisonCohort> => {
    if (!selector.revisionIds?.length && !selector.range) {
      throw new StatisticsRequestError(
        'invalid_cohort',
        `${label} cohort requires a revision id or a date range.`,
      );
    }
    const range = selector.range ? assertRange(selector.range) : { ...input.range };
    const cohortFilters: StatisticsFilters = {
      ...filters,
      ...(selector.revisionIds?.length ? { revisionIds: [...new Set(selector.revisionIds)].sort() } : {}),
    };
    validateFilters(cohortFilters);
    const aggregate = await aggregateStatistics({ range, filters: cohortFilters });
    return {
      label,
      range,
      revisionIds: cohortFilters.revisionIds ?? [],
      samples: aggregate.summary.runs,
      summary: aggregate.summary,
    };
  };

  const baseline = await cohortOf('baseline', input.baseline);
  const candidate = await cohortOf('candidate', input.candidate);
  const baselineMetrics = comparisonMetrics(baseline.summary);
  const candidateMetrics = comparisonMetrics(candidate.summary);

  const deltas: StatisticsComparisonDelta[] = (
    Object.keys(baselineMetrics) as StatisticsComparisonMetric[]
  ).map((metric) => {
    const left = baselineMetrics[metric];
    const right = candidateMetrics[metric];
    return {
      metric,
      baseline: left,
      candidate: right,
      absoluteDelta: round(right - left, 6),
      // Percentage deltas are undefined against a zero baseline.
      percentDelta: left === 0 ? null : round((right - left) / left, 6),
    };
  });

  const warnings: StatisticsComparisonWarning[] = ['observational_comparison'];
  if (baseline.samples < STATISTICS_MIN_COMPARISON_SAMPLES) {
    warnings.push('insufficient_baseline_samples');
  }
  if (candidate.samples < STATISTICS_MIN_COMPARISON_SAMPLES) {
    warnings.push('insufficient_candidate_samples');
  }
  if (baseline.range.from !== candidate.range.from || baseline.range.to !== candidate.range.to) {
    warnings.push('different_ranges');
  }

  return { filters, baseline, candidate, deltas, warnings };
}

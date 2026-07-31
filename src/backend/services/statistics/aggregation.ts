import {
  getStatisticsPartitionMetadata,
  readStatisticsEvents,
  type StatisticsPartitionMetadata,
} from '@/backend/services/statistics';
import type {
  ModelAttemptStatisticsEvent,
  NodeVisitStatisticsEvent,
  StatisticsAggregateRequest,
  StatisticsAggregateResponse,
  StatisticsDateRange,
  StatisticsDurationMetrics,
  StatisticsEvent,
  StatisticsFilters,
  StatisticsRankingRow,
  StatisticsRunOutcome,
  StatisticsRunSource,
  StatisticsStatusFilter,
  StatisticsSummary,
  StatisticsUsage,
  StatisticsUsageTotals,
  ToolInvocationStatisticsEvent,
} from '@/shared/types/statistics';

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SAFE_CREDENTIAL = /^cred_[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 32;
const MAX_FILTER_VALUES = 50;

export const STATISTICS_MAX_RANGE_DAYS = 90;
export const STATISTICS_DEFAULT_RANGE_DAYS = 7;

const RUN_SOURCES = new Set<StatisticsRunSource>([
  'chat', 'api', 'schedule', 'trigger', 'subflow', 'mcp', 'internal', 'internal-tool',
]);
const STATUSES = new Set<StatisticsStatusFilter>([
  'completed', 'error', 'capped', 'cancelled', 'paused', 'skipped',
]);
const ALLOWED_QUERY_KEYS = new Set([
  'from', 'to', 'flowId', 'plannedExecutionId', 'source', 'status', 'modelId',
  'providerId', 'credentialId',
]);
const ALLOWED_FILTER_KEYS = new Set<keyof StatisticsFilters>([
  'flowIds', 'plannedExecutionIds', 'sources', 'statuses', 'modelIds', 'providerIds',
  'credentialIds',
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

/** Strictly parses the documented GET query into a canonical request. */
export function parseStatisticsRequest(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): StatisticsAggregateRequest {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new StatisticsRequestError('unknown_parameter', 'Unknown statistics query parameter.');
    }
  }

  if (searchParams.getAll('from').length > 1 || searchParams.getAll('to').length > 1) {
    throw new StatisticsRequestError('invalid_date', 'Date parameters may only be supplied once.');
  }

  const defaultTo = now.toISOString().slice(0, 10);
  const to = parseUtcDay(searchParams.get('to') ?? defaultTo, 'to');
  const from = parseUtcDay(
    searchParams.get('from') ?? formatDay(dayMillis(to) - (STATISTICS_DEFAULT_RANGE_DAYS - 1) * DAY_MS),
    'from',
  );
  const span = Math.floor((dayMillis(to) - dayMillis(from)) / DAY_MS) + 1;
  if (span < 1) {
    throw new StatisticsRequestError('inverted_range', 'from must not be after to.');
  }
  if (span > STATISTICS_MAX_RANGE_DAYS) {
    throw new StatisticsRequestError(
      'range_too_large',
      `Statistics ranges are limited to ${STATISTICS_MAX_RANGE_DAYS} days.`,
    );
  }

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

  const filters: StatisticsFilters = {
    ...(flowIds ? { flowIds } : {}),
    ...(plannedExecutionIds ? { plannedExecutionIds } : {}),
    ...(sources ? { sources } : {}),
    ...(statuses ? { statuses } : {}),
    ...(modelIds ? { modelIds } : {}),
    ...(providerIds ? { providerIds } : {}),
    ...(credentialIds ? { credentialIds } : {}),
  };
  return { range: { from, to }, filters };
}

type DurationKey = 'runDuration' | 'providerDuration' | 'stepDuration' | 'toolDuration';

type MutableSummary = Omit<StatisticsSummary, DurationKey | 'usage'> & {
  usage: StatisticsUsageTotals;
  durations: Record<DurationKey, number[]>;
};

interface MutableRanking {
  id: string;
  name?: string;
  summary: MutableSummary;
}

type AttemptContribution = Pick<
  ModelAttemptStatisticsEvent,
  'timestamp' | 'model' | 'provider' | 'credentialId' | 'node' | 'outcome' | 'durationMs' | 'usage'
>;
type NodeContribution = Pick<
  NodeVisitStatisticsEvent,
  'timestamp' | 'node' | 'outcome' | 'durationMs'
>;
type ToolContribution = Pick<
  ToolInvocationStatisticsEvent,
  'timestamp' | 'tool' | 'node' | 'outcome' | 'durationMs'
>;
type SkipContribution = Pick<
  Extract<StatisticsEvent, { type: 'scheduler.skip' }>,
  'timestamp' | 'source' | 'plannedExecution'
>;

interface RunBundle {
  runId: string;
  earliestDay: string;
  anchorDay?: string;
  source?: StatisticsRunSource;
  flow?: { id: string; name?: string };
  plannedExecution?: { id: string; name?: string };
  outcome?: StatisticsRunOutcome;
  durationMs?: number;
  paused: boolean;
  hasLifecycle: boolean;
  attempts: AttemptContribution[];
  nodes: NodeContribution[];
  tools: ToolContribution[];
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
    durations: {
      runDuration: [],
      providerDuration: [],
      stepDuration: [],
      toolDuration: [],
    },
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

function finalizeSummary(value: MutableSummary): StatisticsSummary {
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
  for (const key of Object.keys(target.usage) as (keyof StatisticsUsageTotals)[]) {
    target.usage[key] += source.usage[key];
  }
  target.peakContextUtilization = Math.max(
    target.peakContextUtilization,
    source.peakContextUtilization,
  );
  for (const key of Object.keys(target.durations) as DurationKey[]) {
    target.durations[key].push(...source.durations[key]);
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
  if (run.durationMs !== undefined) target.durations.runDuration.push(run.durationMs);
}

function addAttempt(target: MutableSummary, attempt: AttemptContribution): void {
  target.providerAttempts += 1;
  if (attempt.outcome === 'error') target.providerErrors += 1;
  target.durations.providerDuration.push(attempt.durationMs);
  addUsage(target, attempt.usage);
}

function addNode(target: MutableSummary, node: NodeContribution): void {
  target.nodeVisits += 1;
  if (node.outcome === 'error') target.nodeErrors += 1;
  target.durations.stepDuration.push(node.durationMs);
}

function addTool(target: MutableSummary, tool: ToolContribution): void {
  target.toolCalls += 1;
  if (tool.outcome === 'error') target.toolFailures += 1;
  target.durations.toolDuration.push(tool.durationMs);
}

function matches(values: readonly string[] | undefined, value: string | undefined): boolean {
  return !values || (value !== undefined && values.includes(value));
}

function matchingAttempts(run: RunBundle, filters: StatisticsFilters): AttemptContribution[] {
  return run.attempts.filter(attempt => (
    matches(filters.modelIds, attempt.model.id)
    && matches(filters.providerIds, attempt.provider.id)
    && matches(filters.credentialIds, attempt.credentialId)
  ));
}

function runMatches(run: RunBundle, filters: StatisticsFilters): boolean {
  if (!matches(filters.flowIds, run.flow?.id)) return false;
  if (!matches(filters.plannedExecutionIds, run.plannedExecution?.id)) return false;
  if (!matches(filters.sources, run.source)) return false;
  const status: StatisticsStatusFilter | undefined = run.outcome ?? (run.paused ? 'paused' : undefined);
  if (filters.statuses && (!status || !filters.statuses.includes(status))) return false;
  const hasAttemptFilters = Boolean(
    filters.modelIds || filters.providerIds || filters.credentialIds,
  );
  return !hasAttemptFilters || matchingAttempts(run, filters).length > 0;
}

function skipMatches(
  event: SkipContribution,
  filters: StatisticsFilters,
): boolean {
  if (filters.flowIds || filters.modelIds || filters.providerIds || filters.credentialIds) return false;
  if (!matches(filters.plannedExecutionIds, event.plannedExecution.id)) return false;
  if (!matches(filters.sources, event.source)) return false;
  return !filters.statuses || filters.statuses.includes('skipped');
}

function canonicalRequest(request: StatisticsAggregateRequest): StatisticsAggregateRequest {
  const sorted = (values: readonly string[] | undefined) => values
    ? [...new Set(values)].sort()
    : undefined;
  const filters = request.filters ?? {};
  return {
    range: { ...request.range },
    filters: {
      ...(sorted(filters.flowIds) ? { flowIds: sorted(filters.flowIds) } : {}),
      ...(sorted(filters.plannedExecutionIds) ? { plannedExecutionIds: sorted(filters.plannedExecutionIds) } : {}),
      ...(sorted(filters.sources) ? { sources: sorted(filters.sources) as StatisticsRunSource[] } : {}),
      ...(sorted(filters.statuses) ? { statuses: sorted(filters.statuses) as StatisticsStatusFilter[] } : {}),
      ...(sorted(filters.modelIds) ? { modelIds: sorted(filters.modelIds) } : {}),
      ...(sorted(filters.providerIds) ? { providerIds: sorted(filters.providerIds) } : {}),
      ...(sorted(filters.credentialIds) ? { credentialIds: sorted(filters.credentialIds) } : {}),
    },
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

function rankingRows(values: Map<string, MutableRanking>): StatisticsRankingRow[] {
  return [...values.values()]
    .map(value => ({ id: value.id, ...(value.name ? { name: value.name } : {}), ...finalizeSummary(value.summary) }))
    .sort((left, right) => {
      const leftActivity = left.runs + left.schedulerSkips + left.providerAttempts + left.nodeVisits + left.toolCalls;
      const rightActivity = right.runs + right.schedulerSkips + right.providerAttempts + right.nodeVisits + right.toolCalls;
      return rightActivity - leftActivity || left.id.localeCompare(right.id);
    });
}

function updateRun(bundle: RunBundle, event: Exclude<StatisticsEvent, { type: 'scheduler.skip' }>): void {
  const day = event.timestamp.slice(0, 10);
  if (day < bundle.earliestDay) bundle.earliestDay = day;
  switch (event.type) {
    case 'run.started':
      bundle.hasLifecycle = true;
      bundle.anchorDay ??= day;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      break;
    case 'run.paused':
      bundle.hasLifecycle = true;
      bundle.paused = true;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      bundle.durationMs = event.durationMs;
      break;
    case 'run.finished':
      bundle.hasLifecycle = true;
      bundle.anchorDay = day;
      bundle.source = event.source;
      bundle.flow = event.flow;
      bundle.plannedExecution = event.plannedExecution;
      bundle.outcome = event.outcome;
      bundle.durationMs = event.durationMs;
      break;
    case 'node.visit':
      bundle.flow ??= event.flow;
      bundle.nodes.push({
        timestamp: event.timestamp,
        node: event.node,
        outcome: event.outcome,
        durationMs: event.durationMs,
      });
      break;
    case 'model.attempt':
      bundle.attempts.push({
        timestamp: event.timestamp,
        model: event.model,
        provider: event.provider,
        ...(event.credentialId ? { credentialId: event.credentialId } : {}),
        ...(event.node ? { node: event.node } : {}),
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.usage ? { usage: event.usage } : {}),
      });
      break;
    case 'tool.invocation':
      bundle.tools.push({
        timestamp: event.timestamp,
        tool: event.tool,
        ...(event.node ? { node: event.node } : {}),
        outcome: event.outcome,
        durationMs: event.durationMs,
      });
      break;
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

function validateAggregateRequest(request: StatisticsAggregateRequest): void {
  const from = parseUtcDay(request.range.from, 'from');
  const to = parseUtcDay(request.range.to, 'to');
  const span = Math.floor((dayMillis(to) - dayMillis(from)) / DAY_MS) + 1;
  if (span < 1) throw new StatisticsRequestError('inverted_range', 'from must not be after to.');
  if (span > STATISTICS_MAX_RANGE_DAYS) {
    throw new StatisticsRequestError('range_too_large', `Statistics ranges are limited to ${STATISTICS_MAX_RANGE_DAYS} days.`);
  }

  const filters = request.filters ?? {};
  if (Object.keys(filters).some(key => !ALLOWED_FILTER_KEYS.has(key as keyof StatisticsFilters))) {
    throw new StatisticsRequestError('invalid_filter', 'Invalid statistics filter.');
  }
  if (
    !validFilterArray(filters.flowIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.plannedExecutionIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.sources, value => RUN_SOURCES.has(value as StatisticsRunSource))
    || !validFilterArray(filters.statuses, value => STATUSES.has(value as StatisticsStatusFilter))
    || !validFilterArray(filters.modelIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.providerIds, value => SAFE_IDENTIFIER.test(value))
    || !validFilterArray(filters.credentialIds, value => SAFE_CREDENTIAL.test(value))
  ) {
    throw new StatisticsRequestError('invalid_filter', 'Invalid statistics filter.');
  }
}

/**
 * Aggregates only selected daily partitions. Run-level filters are linked by
 * runId; model/provider/credential filters include runs having a matching
 * provider attempt, while only matching attempts contribute attempt metrics.
 */
export async function aggregateStatistics(
  input: StatisticsAggregateRequest,
): Promise<StatisticsAggregateResponse> {
  validateAggregateRequest(input);
  const request = canonicalRequest(input);
  const days = daysInRange(request.range);
  const cacheKey = JSON.stringify(request);
  const now = Date.now();
  pruneCache(now);
  const freshness = await partitionFreshness(days);
  const cached = aggregateCache.get(cacheKey);
  if (cached && now - cached.createdAt <= CACHE_TTL_MS && sameFreshness(cached.freshness, freshness)) {
    aggregateCache.delete(cacheKey);
    aggregateCache.set(cacheKey, cached);
    return structuredClone(cached.response);
  }

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
      let bundle = runs.get(event.runId);
      if (!bundle) {
        bundle = {
          runId: event.runId,
          earliestDay: event.timestamp.slice(0, 10),
          paused: false,
          hasLifecycle: false,
          attempts: [],
          nodes: [],
          tools: [],
        };
        runs.set(event.runId, bundle);
      }
      updateRun(bundle, event);
    }
  }

  const summary = emptyMutableSummary();
  const daily = new Map(days.map(day => [day, emptyMutableSummary()]));
  const flowRankings = new Map<string, MutableRanking>();
  const plannedRankings = new Map<string, MutableRanking>();
  const modelRankings = new Map<string, MutableRanking>();
  const providerRankings = new Map<string, MutableRanking>();
  const credentialRankings = new Map<string, MutableRanking>();
  const nodeRankings = new Map<string, MutableRanking>();
  const toolRankings = new Map<string, MutableRanking>();
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

    for (const node of run.nodes) {
      addNode(runSummary, node);
      const nodeDaily = daily.get(node.timestamp.slice(0, 10));
      if (nodeDaily) addNode(nodeDaily, node);
      addNode(rankingEntry(nodeRankings, node.node.id, node.node.name).summary, node);
      nodesSeen.add(node.node.id);
    }

    for (const tool of run.tools) {
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

    for (const id of modelsSeen) recordRunOutcome(modelRankings.get(id)!.summary, run);
    for (const id of providersSeen) recordRunOutcome(providerRankings.get(id)!.summary, run);
    for (const id of credentialsSeen) recordRunOutcome(credentialRankings.get(id)!.summary, run);
    for (const id of nodesSeen) recordRunOutcome(nodeRankings.get(id)!.summary, run);
    for (const id of toolsSeen) recordRunOutcome(toolRankings.get(id)!.summary, run);

    mergeSummary(summary, runSummary);
    if (run.flow) mergeSummary(rankingEntry(flowRankings, run.flow.id, run.flow.name).summary, runSummary);
    if (run.plannedExecution) {
      mergeSummary(
        rankingEntry(plannedRankings, run.plannedExecution.id, run.plannedExecution.name).summary,
        runSummary,
      );
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

  const response: StatisticsAggregateResponse = {
    range: { ...request.range },
    filters: request.filters ?? {},
    summary: finalizeSummary(summary),
    daily: days.map(date => ({ date, summary: finalizeSummary(daily.get(date)!) })),
    rankings: {
      flows: rankingRows(flowRankings),
      plannedExecutions: rankingRows(plannedRankings),
      models: rankingRows(modelRankings),
      providers: rankingRows(providerRankings),
      credentials: rankingRows(credentialRankings),
      nodes: rankingRows(nodeRankings),
      tools: rankingRows(toolRankings),
    },
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

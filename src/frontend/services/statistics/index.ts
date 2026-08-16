import {
  StatisticsAggregateResponse,
  StatisticsCacheOutcome,
  StatisticsComparisonResponse,
  StatisticsContentCategory,
  StatisticsDetailKind,
  StatisticsDetailResponse,
  StatisticsFilters,
  StatisticsRunSource,
  StatisticsSort,
  StatisticsStatusFilter,
  StatisticsSubflowMode,
} from '@/shared/types/statistics';

export interface StatisticsDashboardFilters extends StatisticsFilters {
  range: {
    from: string;
    to: string;
  };
  sort?: StatisticsSort;
}

export type StatisticsArrayFilterKey = Exclude<
  keyof StatisticsDashboardFilters,
  'range' | 'sort'
>;

const QUERY_KEYS: Array<{
  field: StatisticsArrayFilterKey;
  query: string;
}> = [
  { field: 'personaIds', query: 'personaId' },
  { field: 'activityIds', query: 'activityId' },
  { field: 'behaviorRevisionIds', query: 'behaviorRevisionId' },
  { field: 'flowIds', query: 'flowId' },
  { field: 'plannedExecutionIds', query: 'plannedExecutionId' },
  { field: 'sources', query: 'source' },
  { field: 'statuses', query: 'status' },
  { field: 'modelIds', query: 'modelId' },
  { field: 'providerIds', query: 'providerId' },
  { field: 'credentialIds', query: 'credentialId' },
  { field: 'nodeIds', query: 'nodeId' },
  { field: 'toolIds', query: 'toolId' },
  { field: 'subflowIds', query: 'subflowId' },
  { field: 'subflowModes', query: 'subflowMode' },
  { field: 'revisionIds', query: 'revisionId' },
  { field: 'cacheOutcomes', query: 'cacheOutcome' },
  { field: 'contentCategories', query: 'contentCategory' },
  { field: 'parentRunIds', query: 'parentRunId' },
];

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns the API's inclusive default window: today and the preceding six UTC days. */
export function createDefaultStatisticsFilters(
  now = new Date(),
): StatisticsDashboardFilters {
  const to = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  return {
    range: {
      from: utcDate(from),
      to: utcDate(to),
    },
  };
}

function baseQuery(filters: StatisticsDashboardFilters): URLSearchParams {
  const query = new URLSearchParams();
  query.set('from', filters.range.from);
  query.set('to', filters.range.to);

  for (const { field, query: queryKey } of QUERY_KEYS) {
    const values = filters[field] as readonly (
      string
      | StatisticsRunSource
      | StatisticsStatusFilter
      | StatisticsSubflowMode
      | StatisticsCacheOutcome
      | StatisticsContentCategory
    )[] | undefined;
    values?.forEach((value) => query.append(queryKey, value));
  }
  return query;
}

/** Serializes the shared contract's repeated, singular query-string keys. */
export function buildStatisticsUrl(filters: StatisticsDashboardFilters): string {
  const query = baseQuery(filters);
  if (filters.sort) {
    query.set('sort', filters.sort.field);
    query.set('direction', filters.sort.direction);
  }
  return `/api/statistics?${query.toString()}`;
}

/** Bounded, metadata-only detail page for one dimension. */
export function buildStatisticsDetailUrl(
  filters: StatisticsDashboardFilters,
  options: { kind: StatisticsDetailKind; cursor?: string; limit?: number },
): string {
  const query = baseQuery(filters);
  query.set('view', 'detail');
  query.set('kind', options.kind);
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  return `/api/statistics?${query.toString()}`;
}

/** Two-revision (or two-cohort) comparison under the same dimension filters. */
export function buildStatisticsComparisonUrl(
  filters: StatisticsDashboardFilters,
  options: {
    baselineRevisionIds?: readonly string[];
    candidateRevisionIds?: readonly string[];
    baselineRange?: { from: string; to: string };
    candidateRange?: { from: string; to: string };
  },
): string {
  const query = baseQuery(filters);
  query.set('view', 'compare');
  options.baselineRevisionIds?.forEach((value) => query.append('baselineRevisionId', value));
  options.candidateRevisionIds?.forEach((value) => query.append('candidateRevisionId', value));
  if (options.baselineRange) {
    query.set('baselineFrom', options.baselineRange.from);
    query.set('baselineTo', options.baselineRange.to);
  }
  if (options.candidateRange) {
    query.set('candidateFrom', options.candidateRange.from);
    query.set('candidateTo', options.candidateRange.to);
  }
  return `/api/statistics?${query.toString()}`;
}

function isStatisticsAggregateResponse(
  value: unknown,
): value is StatisticsAggregateResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  const range = response.range as Record<string, unknown> | undefined;
  const summary = response.summary as Record<string, unknown> | undefined;
  const rankings = response.rankings as Record<string, unknown> | undefined;

  return (
    !!range
    && typeof range.from === 'string'
    && typeof range.to === 'string'
    && !!summary
    && typeof summary.runs === 'number'
    && Array.isArray(response.daily)
    && !!rankings
    && Array.isArray(rankings.flows)
    && Array.isArray(rankings.plannedExecutions)
    && Array.isArray(rankings.models)
    && Array.isArray(rankings.providers)
    && Array.isArray(rankings.credentials)
    && Array.isArray(rankings.nodes)
    && Array.isArray(rankings.tools)
  );
}

function isStatisticsDetailResponse(value: unknown): value is StatisticsDetailResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.kind === 'string'
    && Array.isArray(response.rows)
    && typeof response.limit === 'number'
    && typeof response.total === 'number'
  );
}

function isStatisticsComparisonResponse(
  value: unknown,
): value is StatisticsComparisonResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  const baseline = response.baseline as Record<string, unknown> | undefined;
  const candidate = response.candidate as Record<string, unknown> | undefined;
  return (
    !!baseline
    && !!candidate
    && typeof baseline.samples === 'number'
    && typeof candidate.samples === 'number'
    && Array.isArray(response.deltas)
    && Array.isArray(response.warnings)
  );
}

async function request<T>(
  url: string,
  validate: (value: unknown) => value is T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const errorBody = body as { message?: unknown } | undefined;
    throw new Error(
      typeof errorBody?.message === 'string'
        ? errorBody.message
        : `Statistics request failed (HTTP ${response.status}).`,
    );
  }
  if (!validate(body)) {
    throw new Error('The statistics service returned an invalid response.');
  }
  return body;
}

class StatisticsService {
  async get(
    filters: StatisticsDashboardFilters,
    signal?: AbortSignal,
  ): Promise<StatisticsAggregateResponse> {
    return request(buildStatisticsUrl(filters), isStatisticsAggregateResponse, signal);
  }

  /** Metadata-only rows; never prompts, arguments, or results. */
  async getDetails(
    filters: StatisticsDashboardFilters,
    options: { kind: StatisticsDetailKind; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<StatisticsDetailResponse> {
    return request(
      buildStatisticsDetailUrl(filters, options),
      isStatisticsDetailResponse,
      signal,
    );
  }

  async compare(
    filters: StatisticsDashboardFilters,
    options: {
      baselineRevisionIds?: readonly string[];
      candidateRevisionIds?: readonly string[];
      baselineRange?: { from: string; to: string };
      candidateRange?: { from: string; to: string };
    },
    signal?: AbortSignal,
  ): Promise<StatisticsComparisonResponse> {
    return request(
      buildStatisticsComparisonUrl(filters, options),
      isStatisticsComparisonResponse,
      signal,
    );
  }
}

export const statisticsService = new StatisticsService();

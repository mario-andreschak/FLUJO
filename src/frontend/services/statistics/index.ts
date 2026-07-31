import {
  StatisticsAggregateResponse,
  StatisticsFilters,
  StatisticsRunSource,
  StatisticsStatusFilter,
} from '@/shared/types/statistics';

export interface StatisticsDashboardFilters extends StatisticsFilters {
  range: {
    from: string;
    to: string;
  };
}

const QUERY_KEYS: Array<{
  field: keyof Omit<StatisticsDashboardFilters, 'range'>;
  query: string;
}> = [
  { field: 'flowIds', query: 'flowId' },
  { field: 'plannedExecutionIds', query: 'plannedExecutionId' },
  { field: 'sources', query: 'source' },
  { field: 'statuses', query: 'status' },
  { field: 'modelIds', query: 'modelId' },
  { field: 'providerIds', query: 'providerId' },
  { field: 'credentialIds', query: 'credentialId' },
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

/** Serializes the shared contract's repeated, singular query-string keys. */
export function buildStatisticsUrl(filters: StatisticsDashboardFilters): string {
  const query = new URLSearchParams();
  query.set('from', filters.range.from);
  query.set('to', filters.range.to);

  for (const { field, query: queryKey } of QUERY_KEYS) {
    const values = filters[field] as readonly (
      string | StatisticsRunSource | StatisticsStatusFilter
    )[] | undefined;
    values?.forEach((value) => query.append(queryKey, value));
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

class StatisticsService {
  async get(
    filters: StatisticsDashboardFilters,
    signal?: AbortSignal,
  ): Promise<StatisticsAggregateResponse> {
    const response = await fetch(buildStatisticsUrl(filters), {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const errorBody = body as { message?: unknown } | undefined;
      throw new Error(
        typeof errorBody?.message === 'string'
          ? errorBody.message
          : `Statistics request failed (HTTP ${response.status}).`,
      );
    }
    if (!isStatisticsAggregateResponse(body)) {
      throw new Error('The statistics service returned an invalid response.');
    }
    return body;
  }
}

export const statisticsService = new StatisticsService();

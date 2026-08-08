import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import {
  aggregateStatistics,
  compareStatistics,
  parseStatisticsQuery,
  statisticsDetails,
  StatisticsRequestError,
} from '@/backend/services/statistics/aggregation';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/statistics/route');

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * Returns metadata-only execution statistics for an inclusive UTC date range.
 *
 * `view=aggregate` (default) returns aggregates and rankings, `view=detail`
 * returns a bounded, cursor-paginated page of metadata-only rows, and
 * `view=compare` returns a two-cohort revision comparison. Every view keeps the
 * local-request and unlocked-state guards and never returns payload content.
 */
async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const query = new URL(request.url).searchParams;
    const parsed = parseStatisticsQuery(query);
    const body = parsed.view === 'detail'
      ? await statisticsDetails(parsed.request)
      : parsed.view === 'compare'
        ? await compareStatistics(parsed.request)
        : await aggregateStatistics(parsed.request);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StatisticsRequestError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: NO_STORE },
      );
    }
    log.warn('Statistics aggregation failed');
    return NextResponse.json(
      { error: 'statistics_unavailable', message: 'Statistics are temporarily unavailable.' },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);

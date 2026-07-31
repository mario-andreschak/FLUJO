import { NextRequest, NextResponse } from 'next/server';
import {
  aggregateStatistics,
  parseStatisticsRequest,
  StatisticsRequestError,
} from '@/backend/services/statistics/aggregation';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/statistics/route');

export const dynamic = 'force-dynamic';

/** Returns aggregate-only execution statistics for an inclusive UTC date range. */
export async function GET(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const query = new URL(request.url).searchParams;
    return NextResponse.json(
      await aggregateStatistics(parseStatisticsRequest(query)),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof StatisticsRequestError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        {
          status: error.status,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      );
    }
    log.warn('Statistics aggregation failed');
    return NextResponse.json(
      { error: 'statistics_unavailable', message: 'Statistics are temporarily unavailable.' },
      {
        status: 500,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }
}

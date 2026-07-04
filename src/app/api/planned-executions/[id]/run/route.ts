import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { json } from '../../_helpers';

const log = createLogger('app/api/planned-executions/[id]/run/route');

/**
 * POST /api/planned-executions/{id}/run
 * "Run now": fire the execution immediately (works while disabled or paused).
 * Waits for the run and returns its RunRecord.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await getSchedulerService().runNow(id);
    if (result.error || !result.record) {
      return json({ error: result.error ?? 'Failed to run' }, 404);
    }
    return json({ record: result.record }, 200);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

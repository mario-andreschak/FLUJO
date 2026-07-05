import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { loadRunRecords } from '@/backend/services/scheduler/runHistory';
import { json } from '../../_helpers';

const log = createLogger('app/api/planned-executions/[id]/runs/route');

/**
 * GET /api/planned-executions/{id}/runs
 * The execution's run history (ring buffer of the newest 100, oldest first).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const execution = await getSchedulerService().get(id);
    if (!execution) {
      return json({ error: `No planned execution with id "${id}"` }, 404);
    }
    const runs = await loadRunRecords(id);
    return json({ runs }, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { json } from '../../_helpers';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { isPersonaControlledPlannedExecution } from '@/shared/types/plannedExecution';

const log = createLogger('app/api/planned-executions/[id]/run/route');

/**
 * POST /api/planned-executions/{id}/run
 * "Run now": fire the execution immediately (works while disabled or paused).
 * Waits for the run and returns its RunRecord.
 *
 * A manual run is an explicit user action, so — exactly like it bypasses the
 * overlap policy — it also bypasses the scheduler-global exclusive lock
 * (issue #171): it starts right away rather than waiting for the scheduler to
 * idle, and it does not itself claim the lock. This keeps "Run now" a
 * predictable hard override that can never hang behind an exclusive queue.
 */
async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const scheduler = getSchedulerService();
    const execution = await scheduler.get(id);
    if (isPersonaControlledPlannedExecution(execution)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    const result = await scheduler.runNow(id);
    if (result.error || !result.record) {
      return json({ error: result.error ?? 'Failed to run' }, 404);
    }
    return json({ record: result.record }, 200);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);

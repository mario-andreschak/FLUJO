import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { ensureBackendInitialized } from '@/backend/init';
import { json } from './_helpers';

const log = createLogger('app/api/planned-executions/route');

/**
 * GET /api/planned-executions
 * List all planned executions with live trigger status and last run.
 * Response: { paused, executions: [{ execution, status, lastRun }] }
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    // Make sure the scheduler singleton is booted (idempotent) so the status
    // fields reflect reality even if this route is hit right after startup.
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
    const scheduler = getSchedulerService();
    const [paused, executions] = await Promise.all([
      scheduler.isPaused(),
      scheduler.list(),
    ]);
    return json({ paused, executions }, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/planned-executions
 * Create a planned execution. Body: PlannedExecution minus id/createdAt/updatedAt.
 * The bound flow is validated advisorily — the result is returned, not enforced.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = await request.json();
    const result = await getSchedulerService().create(body);
    if (result.error || !result.execution) {
      return json({ error: result.error ?? 'Failed to create planned execution' }, 400);
    }
    const validation = await validateFlowAdvisory(result.execution.flowId);
    return json({ execution: result.execution, validation }, 201);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * PATCH /api/planned-executions
 * Global scheduler controls. Body: { paused: boolean }.
 */
export async function PATCH(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = await request.json();
    if (typeof body?.paused !== 'boolean') {
      return json({ error: '"paused" (boolean) is required' }, 400);
    }
    await getSchedulerService().setPaused(body.paused);
    return json({ paused: body.paused }, 200);
  } catch (error) {
    log.error('Error handling PATCH request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * Advisory flow validation for save responses: never blocks saving (flows can
 * be fixed later), never throws.
 */
async function validateFlowAdvisory(flowId: string) {
  try {
    const { validateFlowForRun } = await import(
      '@/backend/execution/flow/validateFlowForRun'
    );
    return await validateFlowForRun(flowId);
  } catch (error) {
    log.warn('Advisory flow validation failed:', error);
    return undefined;
  }
}

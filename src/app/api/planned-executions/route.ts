import { withWorkspaceRoute } from '@/app/api/_workspace';
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
async function GET_handler(_request: Request) {
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
async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = await request.json();
    const result = await getSchedulerService().create(body);
    if (result.error || !result.execution) {
      // A client-supplied id that collides with an existing execution is a
      // conflict, not a bad request — mirror POST /api/flow's 409 so package
      // appliers can distinguish "already installed" from "invalid" (issue #113).
      const status = result.conflict ? 409 : 400;
      return json({ error: result.error ?? 'Failed to create planned execution' }, status);
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
async function PATCH_handler(request: NextRequest) {
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

const GET_workspaceRoute = withWorkspaceRoute(GET_handler);
export function GET(): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request = new Request('http://localhost/')) {
  return GET_workspaceRoute(request);
}
export const POST = withWorkspaceRoute(POST_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);

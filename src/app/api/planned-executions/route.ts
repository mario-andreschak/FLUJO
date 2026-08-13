import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { ensureBackendInitialized } from '@/backend/init';
import { json } from './_helpers';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { isPersonaControlledPlannedExecution } from '@/shared/types/plannedExecution';

const log = createLogger('app/api/planned-executions/route');

/**
 * GET /api/planned-executions
 * List all planned executions with live trigger status and last run.
 * Response: { paused, executions: [{ execution, status, lastRun }] }
 */
async function GET_handler(request: Request) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const scheduler = getSchedulerService();
    // Inspect persisted targets before backend initialization: initialization
    // may reconcile and arm triggers, which is itself a Persona control-plane
    // action. Public callers retain the legacy list but never see or arm
    // Persona-targeted work through this route.
    const preflight = await scheduler.list();
    const hasPersonaTargets = preflight.some(entry => (
      isPersonaControlledPlannedExecution(entry.execution)
    ));
    if (hasPersonaTargets) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) {
        const paused = await scheduler.isPaused();
        return json({
          paused,
          executions: preflight.filter(entry => (
            !isPersonaControlledPlannedExecution(entry.execution)
          )),
        }, 200);
      }
    }
    // Make sure the scheduler singleton is booted (idempotent) so the status
    // fields reflect reality even if this route is hit right after startup.
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
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
    if (isPersonaControlledPlannedExecution(body)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
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
    const scheduler = getSchedulerService();
    const entries = await scheduler.list();
    if (entries.some(entry => isPersonaControlledPlannedExecution(entry.execution))) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    await scheduler.setPaused(body.paused);
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

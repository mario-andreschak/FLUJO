import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { json } from '../_helpers';
import { assertLocalRequest } from '@/utils/http/localRequest';

const log = createLogger('app/api/planned-executions/[id]/route');

/**
 * GET /api/planned-executions/{id}
 * Fetch one planned execution (config only).
 */
async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const execution = await getSchedulerService().get(id);
    if (!execution) {
      return json({ error: `No planned execution with id "${id}"` }, 404);
    }
    if (execution.personaId) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    return json(execution, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * PATCH /api/planned-executions/{id}
 * Update fields of a planned execution (partial body). Rearms the trigger.
 */
async function PATCH_handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const patch = await request.json();
    const scheduler = getSchedulerService();
    const existing = await scheduler.get(id);
    if (
      existing?.personaId
      || (patch && typeof patch === 'object' && (
        'personaId' in patch || 'behaviorSlotKey' in patch
      ))
    ) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    const result = await scheduler.update(id, patch);
    if (result.error || !result.execution) {
      const missing = result.error?.startsWith('No planned execution');
      return json({ error: result.error ?? 'Failed to update' }, missing ? 404 : 400);
    }
    return json({ execution: result.execution }, 200);
  } catch (error) {
    log.error('Error handling PATCH request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/planned-executions/{id}
 * Delete a planned execution, its run history and trigger state.
 */
async function DELETE_handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const scheduler = getSchedulerService();
    const existing = await scheduler.get(id);
    if (existing?.personaId) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    const result = await scheduler.delete(id);
    if (!result.success) {
      return json({ error: result.error ?? 'Failed to delete' }, 404);
    }
    return json({ success: true }, 200);
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);

import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { json } from '../_helpers';

const log = createLogger('app/api/planned-executions/[id]/route');

/**
 * GET /api/planned-executions/{id}
 * Fetch one planned execution (config only).
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
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const patch = await request.json();
    const result = await getSchedulerService().update(id, patch);
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
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await getSchedulerService().delete(id);
    if (!result.success) {
      return json({ error: result.error ?? 'Failed to delete' }, 404);
    }
    return json({ success: true }, 200);
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

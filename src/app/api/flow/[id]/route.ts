import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/[id]/route');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/flow/{id}
 * Get a single flow by ID.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;

    const flow = await flowService.getFlow(id);
    if (!flow) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    return json(flow, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * PUT /api/flow/{id}
 * Update an existing flow. The path ID is authoritative and overrides any ID in the
 * body. Returns 404 when the flow does not exist (use POST /api/flow to create).
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const body = (await request.json()) as Flow;

    if (!body || typeof body !== 'object') {
      return json({ error: 'A flow is required' }, 400);
    }

    const existing = await flowService.getFlow(id);
    if (!existing) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    // The path segment is the source of truth for which flow is being updated.
    const flow: Flow = { ...body, id };

    const result = await flowService.saveFlow(flow);
    if (!result.success) {
      return json({ error: result.error || 'Failed to update flow' }, 400);
    }

    return json(flow, 200);
  } catch (error) {
    log.error('Error handling PUT request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/flow/{id}
 * Delete a flow by ID.
 */
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;

    const existing = await flowService.getFlow(id);
    if (!existing) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    const result = await flowService.deleteFlow(id);
    if (!result.success) {
      return json({ error: result.error || 'Failed to delete flow' }, 500);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

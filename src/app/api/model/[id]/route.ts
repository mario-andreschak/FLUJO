import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import * as modelAdapter from '../frontend-model-adapter';

const log = createLogger('app/api/model/[id]/route');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/model/{id}
 * Get a single model by ID.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;

    const result = await modelAdapter.getModel(id);
    if (!result.success || !result.model) {
      return new Response(JSON.stringify({ error: result.error || 'Model not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result.model), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error handling GET request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * PUT /api/model/{id}
 * Update an existing model. The path ID is authoritative and overrides any ID in the body.
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const body = (await request.json()) as Model;

    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ error: 'Model is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // The path segment is the source of truth for which model is being updated.
    const model: Model = { ...body, id };

    const result = await modelAdapter.updateModel(model);
    if (!result.success) {
      const status = result.error === 'Model not found' ? 404 : 400;
      return new Response(JSON.stringify({ error: result.error }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result.model), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error handling PUT request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * DELETE /api/model/{id}
 * Delete a model by ID.
 */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;

    const result = await modelAdapter.deleteModel(id);
    if (!result.success) {
      const status = result.error === 'Model not found' ? 404 : 400;
      return new Response(JSON.stringify({ error: result.error }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

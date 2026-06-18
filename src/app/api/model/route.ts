import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import * as modelAdapter from './frontend-model-adapter';

const log = createLogger('app/api/model/route');

/**
 * GET /api/model
 * List all models.
 */
export async function GET() {
  try {
    const result = await modelAdapter.loadModels();
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Failed to load models' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(result.models), {
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
 * POST /api/model
 * Create a new model. The request body is the model object itself.
 */
export async function POST(request: NextRequest) {
  try {
    const model = (await request.json()) as Model;

    if (!model || typeof model !== 'object') {
      return new Response(JSON.stringify({ error: 'Model is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await modelAdapter.addModel(model);
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result.model), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error handling POST request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

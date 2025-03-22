import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import * as modelAdapter from './frontend-model-adapter';

const log = createLogger('app/api/model/route');

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('id');

    if (modelId) {
      // Get single model using the adapter
      const result = await modelAdapter.getModel(modelId);
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
    }

    // Get all models using the adapter
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    log.info('POST: Received request body:', JSON.stringify(body));
    const { action, model, id } = body;

    if (!action) {
      return new Response(JSON.stringify({ error: 'Action is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    switch (action) {
      case 'addModel':
        const addResult = await modelAdapter.addModel(model);
        if (!addResult.success) {
          return new Response(JSON.stringify({ error: addResult.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(addResult.model), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });

      case 'updateModel':
        const updateResult = await modelAdapter.updateModel(model);
        if (!updateResult.success) {
          return new Response(JSON.stringify({ error: updateResult.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(updateResult.model), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      case 'deleteModel':
        if (!id) {
          return new Response(JSON.stringify({ error: 'Model ID is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const deleteResult = await modelAdapter.deleteModel(id);
        if (!deleteResult.success) {
          return new Response(JSON.stringify({ error: deleteResult.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 204 });

      default:
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  } catch (error) {
    log.error('Error handling POST request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const model = (await request.json()) as Model;
    const result = await modelAdapter.updateModel(model);
    
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
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

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('id');

    if (!modelId) {
      return new Response(JSON.stringify({ error: 'Model ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await modelAdapter.deleteModel(modelId);
    
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
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

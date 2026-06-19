import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import { json } from './_helpers';

const log = createLogger('app/api/flow/route');

/**
 * GET /api/flow
 * List all flows.
 */
export async function GET() {
  try {
    const flows = await flowService.loadFlows();
    return json(flows, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/flow
 * Create a new flow. The request body is the flow object itself.
 *
 * Create semantics: a flow whose id already exists is rejected (use
 * PUT /api/flow/{id} to update an existing flow).
 */
export async function POST(request: NextRequest) {
  try {
    const flow = (await request.json()) as Flow;

    if (!flow || typeof flow !== 'object' || !flow.id) {
      return json({ error: 'A flow with an id is required' }, 400);
    }

    const existing = await flowService.getFlow(flow.id);
    if (existing) {
      return json({ error: `A flow with id "${flow.id}" already exists` }, 409);
    }

    const result = await flowService.saveFlow(flow);
    if (!result.success) {
      return json({ error: result.error || 'Failed to create flow' }, 400);
    }

    return json(flow, 201);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

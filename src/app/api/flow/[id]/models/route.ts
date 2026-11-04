import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { describeFlowModelReach } from '@/backend/services/flow/modelReach';
import { json } from '../../_helpers';

const log = createLogger('app/api/flow/[id]/models/route');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/flow/{id}/models
 * The models this flow can send data to, through its steps, its subflows and the
 * members of fallback policies. Contains no credentials.
 */
async function GET_handler(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const reach = await describeFlowModelReach(id);
    if (!reach) return json({ error: `Flow "${id}" not found` }, 404);
    return json(reach, 200);
  } catch (error) {
    log.error('Error handling GET /api/flow/{id}/models', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);

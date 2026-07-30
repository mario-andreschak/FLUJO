import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import type { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import { json } from '../../_helpers';

const log = createLogger('app/api/flow/[id]/convert-process-to-subflow/route');
type RouteContext = { params: Promise<{ id: string }> };

interface ConversionRequest {
  processNodeId?: string;
  parentFlow?: Flow;
  childFlow?: Flow;
  expectedUpdatedAt?: number;
}

/**
 * POST /api/flow/{id}/convert-process-to-subflow
 * Saves a newly extracted child and its rewritten parent with compensation.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { id } = await params;
    const body = (await request.json()) as ConversionRequest;
    if (!body?.processNodeId || !body.parentFlow || !body.childFlow) {
      return json({ error: 'processNodeId, parentFlow, and childFlow are required.' }, 400);
    }

    const result = await flowService.convertProcessToSubflow(
      { ...body.parentFlow, id },
      body.childFlow,
      body.processNodeId,
      body.expectedUpdatedAt,
    );
    if (!result.success) {
      return json({ error: result.error || 'Failed to convert Process to Subflow.' }, result.conflict ? 409 : 400);
    }

    return json({ parentFlow: result.parentFlow, childFlow: result.childFlow }, 200);
  } catch (error) {
    log.error('Error handling Process -> Subflow conversion', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

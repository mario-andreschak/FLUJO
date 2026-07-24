import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';
import { json } from '../../_helpers';

const log = createLogger('app/api/flow/[id]/versions/route');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/flow/{id}/versions
 * List the archived (superseded) versions of a flow, newest first. Returns
 * summaries only (id, savedAt, name, node/edge counts) — fetch a single
 * version's full definition via GET /api/flow/{id}/versions/{versionId}.
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

    const versions = await flowService.listFlowVersions(id);
    return json({ versions }, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

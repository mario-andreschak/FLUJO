import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';
import { json } from '../../../_helpers';

const log = createLogger('app/api/flow/[id]/versions/[versionId]/route');

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

/**
 * GET /api/flow/{id}/versions/{versionId}
 * Get one archived version with its full flow definition. The definition is
 * used to preview and (client-side) stage a restore in the builder — restoring
 * goes through the normal PUT /api/flow/{id} save path, which itself archives
 * the definition being replaced, so a restore is reversible.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id, versionId } = await params;

    const record = await flowService.getFlowVersion(id, versionId);
    if (!record) {
      return json({ error: `No version "${versionId}" of flow "${id}"` }, 404);
    }

    return json(record, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

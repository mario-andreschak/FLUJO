import { withWorkspaceRoute } from '@/app/api/_workspace';
import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import { getCurrentWorkspace } from '@/utils/workspace';
import { type NextRequest } from 'next/server';
import {
  authorizeSnapshotRequest,
  noStoreJson,
  snapshotRouteError,
} from '../_auth';

export const runtime = 'nodejs';

async function POST_handler(request: NextRequest): Promise<Response> {
  const unauthorized = authorizeSnapshotRequest(request);
  if (unauthorized) return unauthorized;
  try {
    const text = await request.text();
    if (text.length > 16 * 1024) return noStoreJson({ error: 'Snapshot selection is too large.' }, 400);
    let selection: { flowIds?: string[] } = {};
    if (text.trim()) {
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { return noStoreJson({ error: 'Snapshot selection must be valid JSON.' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return noStoreJson({ error: 'Snapshot selection must be an object.' }, 400);
      }
      const flowIds = (body as { flowIds?: unknown }).flowIds;
      if (flowIds !== undefined) {
        if (!Array.isArray(flowIds) || flowIds.length === 0 || flowIds.length > 100
          || flowIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) {
          return noStoreJson({ error: 'flowIds must contain 1 to 100 nonempty flow IDs.' }, 400);
        }
        selection = { flowIds: [...new Set(flowIds)] };
      }
    }
    return noStoreJson(
      await snapshotCoordinator.begin(getCurrentWorkspace(), selection),
      202,
    );
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const POST = withWorkspaceRoute(POST_handler);

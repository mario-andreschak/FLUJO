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
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 16 * 1024) {
            await reader.cancel();
            return noStoreJson({ error: 'Snapshot selection is too large.' }, 400);
          }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const selection: { flowIds?: string[]; recipientKey?: string } = {};
    if (text.trim()) {
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { return noStoreJson({ error: 'Snapshot selection must be valid JSON.' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return noStoreJson({ error: 'Snapshot selection must be an object.' }, 400);
      }
      const recipientKey = (body as { recipientKey?: unknown }).recipientKey;
      if (recipientKey !== undefined) {
        if (typeof recipientKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(recipientKey)) {
          return noStoreJson({ error: 'recipientKey must be a canonical base64 32-byte key.' }, 400);
        }
        const decoded = Buffer.from(recipientKey, 'base64');
        const valid = decoded.length === 32 && decoded.toString('base64') === recipientKey;
        decoded.fill(0);
        if (!valid) return noStoreJson({ error: 'recipientKey must be a canonical base64 32-byte key.' }, 400);
        selection.recipientKey = recipientKey;
      }
      const flowIds = (body as { flowIds?: unknown }).flowIds;
      if (flowIds !== undefined) {
        if (!Array.isArray(flowIds) || flowIds.length === 0 || flowIds.length > 100
          || flowIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) {
          return noStoreJson({ error: 'flowIds must contain 1 to 100 nonempty flow IDs.' }, 400);
        }
        selection.flowIds = [...new Set(flowIds)];
      }
    }
    if (selection.recipientKey === undefined) {
      return noStoreJson({ error: 'recipientKey must be a canonical base64 32-byte key.' }, 400);
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

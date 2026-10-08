import { withWorkspaceRoute } from '@/app/api/_workspace';
import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import { getCurrentWorkspace } from '@/utils/workspace';
import { type NextRequest } from 'next/server';
import {
  authorizeSnapshotRequest,
  noStoreJson,
  snapshotRouteError,
  snapshotSessionId,
} from '../_auth';

export const runtime = 'nodejs';

async function GET_handler(request: NextRequest): Promise<Response> {
  const unauthorized = authorizeSnapshotRequest(request);
  if (unauthorized) return unauthorized;
  const sessionId = snapshotSessionId(request);
  if (!sessionId) {
    return noStoreJson({ error: 'sessionId is required.' }, 400);
  }
  try {
    return noStoreJson(
      await snapshotCoordinator.status(sessionId, getCurrentWorkspace()),
    );
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const GET = withWorkspaceRoute(GET_handler);

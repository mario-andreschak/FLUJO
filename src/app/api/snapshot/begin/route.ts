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
    return noStoreJson(
      await snapshotCoordinator.begin(getCurrentWorkspace()),
      202,
    );
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const POST = withWorkspaceRoute(POST_handler);

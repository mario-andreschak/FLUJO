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

async function GET_handler(request: NextRequest): Promise<Response> {
  const unauthorized = authorizeSnapshotRequest(request);
  if (unauthorized) return unauthorized;
  try {
    return noStoreJson(await snapshotCoordinator.info(getCurrentWorkspace()));
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const GET = withWorkspaceRoute(GET_handler);

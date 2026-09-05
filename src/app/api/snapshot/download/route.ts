import { withWorkspaceRoute } from '@/app/api/_workspace';
import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import { getCurrentWorkspace } from '@/utils/workspace';
import { NextResponse, type NextRequest } from 'next/server';
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
    const archive = await snapshotCoordinator.readDownload(
      sessionId,
      getCurrentWorkspace(),
    );
    return new NextResponse(new Uint8Array(archive.content), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="flujo-workspace.snapshot.zip"',
        'Content-Length': String(archive.size),
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
        'X-Flujo-Snapshot-Sha256': archive.sha256,
      },
    });
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const GET = withWorkspaceRoute(GET_handler);

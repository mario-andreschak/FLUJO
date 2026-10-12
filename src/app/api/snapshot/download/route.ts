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
    return new NextResponse(archive.content, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="flujo-workspace.snapshot.${archive.encrypted ? 'encrypted.json' : 'zip'}"`,
        'Content-Length': String(archive.size),
        'Content-Type': archive.encryptionVersion === 2 ? 'application/vnd.flujo.workspace-snapshot+json' : archive.encrypted ? 'application/json' : 'application/zip',
        'X-Content-Type-Options': 'nosniff',
        'X-Flujo-Snapshot-Sha256': archive.sha256,
        'X-Flujo-Snapshot-Plaintext-Sha256': archive.plaintextSha256,
        'X-Flujo-Snapshot-Encryption-Version': String(archive.encryptionVersion),
        'X-Flujo-Snapshot-Encrypted': String(archive.encrypted),
        'X-Flujo-Snapshot-Recipient-Key-Used': String(archive.recipientKeyUsed),
      },
    });
  } catch (error) {
    return snapshotRouteError(error);
  }
}

export const GET = withWorkspaceRoute(GET_handler);

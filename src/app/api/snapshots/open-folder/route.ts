import { NextResponse } from 'next/server';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { withWorkspaceRoute } from '@/app/api/_workspace';

export const runtime = 'nodejs';

async function POST_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  try {
    await snapshotStore.openFolder();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: 'Unable to open snapshot folder' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);

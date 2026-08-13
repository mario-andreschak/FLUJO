import { NextResponse } from 'next/server';
import { SnapshotStoreBusyError, snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  let body: { action?: unknown; confirmation?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid cleanup request' }, { status: 400 });
  }

  try {
    if (body.action === 'clean-old') {
      const result = await snapshotStore.cleanup(true);
      return NextResponse.json({ ...result, status: await snapshotStore.status() });
    }
    if (body.action === 'delete-all') {
      if (body.confirmation !== 'DELETE SNAPSHOTS') {
        return NextResponse.json(
          { error: 'Type DELETE SNAPSHOTS to delete snapshot history' },
          { status: 400 },
        );
      }
      const result = await snapshotStore.deleteAll();
      return NextResponse.json({ ...result, status: await snapshotStore.status() });
    }
    return NextResponse.json({ error: 'Unknown cleanup action' }, { status: 400 });
  } catch (error: unknown) {
    if (error instanceof SnapshotStoreBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'Unable to clean snapshot history' }, { status: 500 });
  }
}

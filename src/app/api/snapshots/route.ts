import { NextResponse } from 'next/server';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { isSnapshotRetentionPolicy } from '@/shared/types/snapshot';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  return NextResponse.json(await snapshotStore.status());
}

export async function PATCH(request: Request) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid snapshot policy request' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid snapshot policy request' }, { status: 400 });
  }
  const current = await snapshotStore.policy();
  const policy = { ...current, ...(body as Record<string, unknown>) };
  if (!isSnapshotRetentionPolicy(policy)) {
    return NextResponse.json({ error: 'Invalid snapshot retention policy' }, { status: 400 });
  }
  // Changing policy is intentionally non-destructive. Cleanup is always explicit.
  return NextResponse.json({ policy: await snapshotStore.updatePolicy(policy) });
}

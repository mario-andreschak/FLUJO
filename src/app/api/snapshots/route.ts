import { NextResponse } from 'next/server';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { isSnapshotRetentionPolicy, type SnapshotRetentionPolicy } from '@/shared/types/snapshot';
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
  const fields = body as Record<string, unknown>;
  const current = await snapshotStore.policy();
  const policy: SnapshotRetentionPolicy = {
    version: fields.version === undefined ? current.version : fields.version as SnapshotRetentionPolicy['version'],
    enabled: fields.enabled === undefined ? current.enabled : fields.enabled as boolean,
    maxBytes: fields.maxBytes === undefined ? current.maxBytes : fields.maxBytes as number,
    maxAgeMs: fields.maxAgeMs === undefined ? current.maxAgeMs : fields.maxAgeMs as number,
    maxCapturesPerRoot: fields.maxCapturesPerRoot === undefined
      ? current.maxCapturesPerRoot
      : fields.maxCapturesPerRoot as number,
    automaticCleanup: fields.automaticCleanup === undefined
      ? current.automaticCleanup
      : fields.automaticCleanup as boolean,
  };
  if (!isSnapshotRetentionPolicy(policy)) {
    return NextResponse.json({ error: 'Invalid snapshot retention policy' }, { status: 400 });
  }
  // Changing policy is intentionally non-destructive. Cleanup is always explicit.
  return NextResponse.json({ policy: await snapshotStore.updatePolicy(policy) });
}

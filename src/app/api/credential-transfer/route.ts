import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { exportCredentialTransfer } from '@/backend/services/workspace/credentialTransfer';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';

async function POST_handler(request: NextRequest) {
  const local = assertLocalRequest(request, { strictLoopback: true });
  if (local) return local;
  if (isWorkerMode()) return NextResponse.json({ error: 'Transfer unavailable in worker mode.' }, { status: 403 });
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const body = await readBoundedBody(request, 4096);
    let passphrase: string;
    try {
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (input.confirmCredentialTransfer !== true || typeof input.recipientPassphrase !== 'string') throw new Error();
      passphrase = input.recipientPassphrase;
    } finally { body.fill(0); }
    const envelope = await exportCredentialTransfer(passphrase);
    return new NextResponse(new Uint8Array(envelope), { headers: {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="flujo-credentials.flujo-transfer"',
    } });
  } catch {
    return NextResponse.json({ error: 'Credential transfer failed. Check the passphrase and source credential integrity.' }, { status: 400 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);

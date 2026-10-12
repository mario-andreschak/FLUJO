import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { MAX_TRANSFER_BYTES } from '@/utils/encryption/recipientTransfer';
import { restoreCredentialTransfer } from '@/backend/services/workspace/credentialTransfer';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';

async function POST_handler(request: NextRequest) {
  const local = assertLocalRequest(request, { strictLoopback: true });
  if (local) return local;
  if (isWorkerMode()) return NextResponse.json({ error: 'Transfer unavailable in worker mode.' }, { status: 403 });
  // Owner admission is separate from unlocking an existing workspace. Restore
  // creates an unused namespace with its own explicitly supplied private key.
  try {
    const bytes = await readBoundedBody(request, MAX_TRANSFER_BYTES + 16 * 1024);
    let form: FormData;
    try { form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData(); }
    finally { bytes.fill(0); }
    const file = form.get('file');
    const transferPassphrase = form.get('recipientPassphrase');
    const localPassphrase = form.get('localPassphrase');
    const workspace = form.get('workspace');
    if (!(file instanceof File) || typeof transferPassphrase !== 'string' || typeof localPassphrase !== 'string'
        || typeof workspace !== 'string' || form.get('confirmCredentialTransfer') !== 'true') throw new Error();
    const envelope = Buffer.from(await file.arrayBuffer());
    try {
      const restored = await restoreCredentialTransfer(envelope, transferPassphrase, workspace, localPassphrase, { signal: request.signal });
      return NextResponse.json({ success: true, workspace: restored, encryptionProtection: 'passphrase' }, { headers: { 'Cache-Control': 'no-store' } });
    } finally { envelope.fill(0); }
  } catch {
    return NextResponse.json({ error: 'Credential restore failed. Check the transfer, passphrases, expiry and unused workspace name.' }, { status: 400 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);

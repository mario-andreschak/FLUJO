import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertValidWorkspaceName, InvalidWorkspaceNameError } from '@/utils/workspace';
import { PersonaRecoveryError } from '@/backend/services/enduringAgents/personaRecoveryError';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { capturePersonaRecovery } from '@/backend/services/enduringAgents/personaRecoveryCapture';
import { planPersonaRecoveryRestore } from '@/backend/services/enduringAgents/personaRecoveryPlan';
import { restorePersonaRecovery } from '@/backend/services/enduringAgents/personaRecoveryRestore';
import { PERSONA_RECOVERY_ZIP_LIMITS } from '@/backend/services/enduringAgents/personaRecoveryZip';
import type { PersonaRecoveryBackupSummary } from '@/shared/types/personaRecovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

async function readArchive(request: NextRequest): Promise<Buffer> {
  const limit = PERSONA_RECOVERY_ZIP_LIMITS.archiveBytes;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new PersonaRecoveryError('Recovery archive exceeds the upload limit.');
  if (!request.body) throw new PersonaRecoveryError('Select a Persona recovery archive.');
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new PersonaRecoveryError('Recovery archive exceeds the upload limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new PersonaRecoveryError('Select a non-empty Persona recovery archive.');
  if (length !== null && Number(length) !== size) throw new PersonaRecoveryError('Recovery upload was incomplete; select the original archive and retry.');
  return Buffer.concat(chunks, size);
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true });
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;
  if (isWorkerMode()) return NextResponse.json({ error: 'Persona recovery is unavailable on execution workers.' }, { status: 403, headers });
  const url = new URL(request.url);
  if (!url.searchParams.has('workspace') && !request.headers.has('x-flujo-workspace')) {
    return NextResponse.json({ error: 'Select an explicit workspace for Persona recovery.' }, { status: 400, headers });
  }
  const action = request.headers.get('x-persona-recovery-action');
  try {
    if (action === 'capture') {
      const result = await capturePersonaRecovery({ signal: request.signal });
      const summary: PersonaRecoveryBackupSummary = {
        sourceWorkspace: result.manifest.sourceWorkspace, captureId: result.manifest.captureId,
        capturedAt: result.manifest.capturedAt, counts: result.manifest.counts, archiveBytes: result.bytes.length,
      };
      return new NextResponse(new Uint8Array(result.bytes), { headers: {
        ...headers, 'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="flujo-persona-recovery-${result.manifest.captureId}.zip"`,
        'X-Flujo-Persona-Recovery-Summary': encodeURIComponent(JSON.stringify(summary)),
      } });
    }
    if (action !== 'inspect' && action !== 'restore') {
      return NextResponse.json({ error: 'Choose capture, inspect or restore.' }, { status: 400, headers });
    }
    const destination = assertValidWorkspaceName(url.searchParams.get('destination'));
    const archive = await readArchive(request);
    if (action === 'inspect') return NextResponse.json(planPersonaRecoveryRestore(archive, destination).preview, { headers });
    const previewToken = request.headers.get('x-persona-recovery-preview') ?? '';
    return NextResponse.json(await restorePersonaRecovery(archive, destination, previewToken, { signal: request.signal }), { headers });
  } catch (error) {
    const expected = error instanceof PersonaRecoveryError || error instanceof ZodError || error instanceof InvalidWorkspaceNameError;
    const message = error instanceof ZodError ? 'The recovery archive contains invalid or unsupported records.'
      : expected ? error.message : 'Persona recovery could not finish. Retry when the workspace is idle and storage is available.';
    return NextResponse.json({ error: message }, { status: expected ? (action === 'capture' ? 409 : 400) : 500, headers });
  }
}

export const POST = withWorkspaceRoute(POST_handler);

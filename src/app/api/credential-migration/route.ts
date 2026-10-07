import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { isCredentialMigrationPending } from '@/utils/encryption/credentialMigrationState';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { CredentialMigrationError, migrateCredentials, preflightCredentialMigration, recoverCredentialMigration } from '@/backend/services/workspace/credentialMigration';

function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
function admission(request: NextRequest) {
  return assertLocalRequest(request, { strictLoopback: true })
    ?? (isWorkerMode() ? json({ error: 'Credential migration is unavailable in worker mode.' }, 403) : null);
}
async function GET_handler(request: NextRequest) {
  const denied = admission(request); if (denied) return denied;
  return json({ pending: await isCredentialMigrationPending() });
}
async function POST_handler(request: NextRequest) {
  const denied = admission(request); if (denied) return denied;
  // This exact locked-state exception independently authenticates metadata or
  // the encrypted recovery journal; it never relies on the cached unlock key.
  try {
    let bytes: Buffer;
    try { bytes = await readBoundedBody(request, 4096); }
    catch { return json({ error: 'Invalid or oversized migration request.' }, 400); }
    let input: Record<string, unknown>;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return json({ error: 'Invalid migration request.' }, 400); }
    finally { bytes.fill(0); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.recoveryPassphrase !== 'string'
        || (input.sourcePassphrase !== undefined && typeof input.sourcePassphrase !== 'string')
        || (input.retireActiveKey !== undefined && typeof input.retireActiveKey !== 'boolean')
        || (input.protection !== undefined && !['passphrase', 'operator-file'].includes(String(input.protection)))) return json({ error: 'Invalid migration request.' }, 400);
    const options = { recoveryPassphrase: input.recoveryPassphrase, sourcePassphrase: input.sourcePassphrase as string | undefined,
      protection: input.protection as 'passphrase' | 'operator-file' | undefined, retireActiveKey: input.retireActiveKey as boolean | undefined, signal: request.signal };
    if (input.action === 'preflight') return json(await preflightCredentialMigration(options));
    if (input.confirmMigration !== true) return json({ error: 'Explicit migration or recovery confirmation is required.' }, 400);
    if (input.action === 'migrate' && typeof input.planToken === 'string' && /^[a-f0-9]{64}$/.test(input.planToken)) return json(await migrateCredentials(options, input.planToken));
    if (input.action === 'resume' || input.action === 'rollback') return json(await recoverCredentialMigration(options, input.action === 'rollback'));
    return json({ error: 'Invalid migration action.' }, 400);
  } catch (error) {
    if (error instanceof CredentialMigrationError) return json({ error: error.code, remediation: error.message, ...(error.store ? { store: error.store } : {}) },
      error.code === 'SOURCE_CHANGED' ? 409 : error.code === 'SOURCE_INVALID' ? 422 : error.code === 'MIGRATION_PENDING' ? 503 : 400);
    const pending = await isCredentialMigrationPending();
    return json({ error: pending ? 'MIGRATION_PENDING' : 'MIGRATION_FAILED', remediation: pending
      ? 'Preserve the journal. Resume or roll back with its recovery passphrase.'
      : 'Inspect migration status and retained backup receipts before retrying; preserve matching files.' }, pending ? 503 : 500);
  }
}
export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);

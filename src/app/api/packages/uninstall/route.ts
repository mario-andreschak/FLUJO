/**
 * POST /api/packages/uninstall (issue #211).
 *
 * The de-provisioning counterpart to POST /api/packages/install: reverse a
 * package install by deleting only the entities the install actually CREATED
 * (flows, models, MCP servers, planned executions) and dropping the ledger
 * entry. Entities the install adopted/updated in place (e.g. a pre-existing
 * model matched by displayName) are left intact.
 *
 * Same posture as install: fail-closed behind `assertUnlocked` +
 * `assertLocalRequest`, and deliberately NOT on the public API allow-list.
 *
 * Body: { packageName: string }
 * Response: the UninstallSummary (removed / skipped / errors). Partial failures
 * still return 200 with `hasErrors: true` so the client can surface them.
 * An unknown package returns 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { uninstallPackage, listInstalledPackages } from '@/backend/services/packages/installPackage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/uninstall/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { packageName } = (body ?? {}) as { packageName?: unknown };
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return NextResponse.json({ error: 'packageName is required' }, { status: 400 });
  }

  // 404 for a package with no install record (before mutating anything).
  const installed = await listInstalledPackages();
  if (!installed.some((p) => p.packageName === packageName)) {
    return NextResponse.json({ error: `No install record for package "${packageName}"` }, { status: 404 });
  }

  log.info(`Uninstalling package "${packageName}"`);

  const summary = await uninstallPackage(packageName);
  return NextResponse.json(summary, { status: 200 });
}

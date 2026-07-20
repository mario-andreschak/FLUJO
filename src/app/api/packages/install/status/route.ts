/**
 * GET /api/packages/install/status?package=<name> (issue #198).
 *
 * Returns the last recorded install summary for a package (read from the install
 * ledger). This satisfies the "status/summary endpoint" requirement without a
 * full async job queue: v1 installs are synchronous, so the caller already has
 * the live summary from POST; this endpoint lets it re-read the last outcome.
 *
 * Local-only, fail-closed (same posture as the install route).
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getLastInstallSummary } from '@/backend/services/packages/installPackage';

export async function GET(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const packageName = new URL(request.url).searchParams.get('package');
  if (!packageName) {
    return NextResponse.json({ error: 'The "package" query parameter is required' }, { status: 400 });
  }

  const summary = await getLastInstallSummary(packageName);
  if (!summary) {
    return NextResponse.json({ error: `No install record for package "${packageName}"` }, { status: 404 });
  }

  return NextResponse.json({ package: packageName, summary }, { status: 200 });
}

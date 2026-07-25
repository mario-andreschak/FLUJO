/**
 * GET /api/packages/installed (issue #211).
 *
 * Lists every package recorded in the install ledger (name, version, installed
 * date, entity counts) so the experimental Packages UI can render an
 * "Installed packages" list with an Uninstall action.
 *
 * Local-only, fail-closed (same posture as the install / uninstall routes).
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { listInstalledPackages } from '@/backend/services/packages/installPackage';

export async function GET(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const packages = await listInstalledPackages();
  return NextResponse.json({ packages }, { status: 200 });
}

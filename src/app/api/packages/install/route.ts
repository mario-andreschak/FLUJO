/**
 * POST /api/packages/install (issue #198).
 *
 * Local-only REST entry point that lets brain online / headless automation
 * provision a tenant without a browser: install a registry package (a bundle of
 * flows, models, MCP-server references and planned executions) in one call.
 *
 * The request itself IS the consent (`consentGranted: true`) — this route is
 * fail-closed behind `assertLocalRequest` and is deliberately NOT on the public
 * API allow-list. Hosted tenants opt in only via `FLUJO_EXTRA_LOCAL_HOSTS`.
 *
 * Body: { source: 'registry', packageId: string, version?: string,
 *         secrets?: Record<string,string> }
 * Response: the install summary (created / updated / skipped / disabled / errors).
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { installPackage } from '@/backend/services/packages/installPackage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/install/route');

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

  const { source, packageId, version, secrets } = (body ?? {}) as {
    source?: unknown;
    packageId?: unknown;
    version?: unknown;
    secrets?: unknown;
  };

  if (source !== 'registry') {
    return NextResponse.json({ error: "The only supported source is 'registry'" }, { status: 400 });
  }
  if (typeof packageId !== 'string' || packageId.trim() === '') {
    return NextResponse.json({ error: 'packageId is required' }, { status: 400 });
  }
  if (version !== undefined && typeof version !== 'string') {
    return NextResponse.json({ error: 'version must be a string' }, { status: 400 });
  }
  if (secrets !== undefined && (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets))) {
    return NextResponse.json({ error: 'secrets must be an object of string values' }, { status: 400 });
  }
  const secretRecord = (secrets ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(secretRecord)) {
    if (typeof v !== 'string') {
      return NextResponse.json({ error: `secret "${k}" must be a string value` }, { status: 400 });
    }
  }

  log.info(`Installing package "${packageId}"${version ? `@${version}` : ''}`);

  const summary = await installPackage({
    source: 'registry',
    packageId,
    ...(version ? { version } : {}),
    secrets: secretRecord as Record<string, string>,
    consentGranted: true,
  });

  return NextResponse.json(summary, { status: summary.ok ? 200 : 400 });
}

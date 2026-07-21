/**
 * Publish a package manifest to the hosted registry (issue #197).
 *
 *   POST -> { manifest: <FlujoPackage JSON> }
 *
 * Requires a confirmed, signed-in account (enforced by the registry + the
 * service's `withAccessToken`). Friendly error codes are mapped to HTTP status:
 * unconfirmed -> 403, name collision -> 409, validation -> 400, expired/absent
 * session -> 401. Local-only + unlock-gated. NOT on the public allow-list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { publish } from '@/backend/services/registry';
import type { RegistryPublishResult } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/publish/route');

/** Map the service's friendly error code back to an HTTP status. */
function statusForResult(result: RegistryPublishResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case 'unconfirmed':
      return 403;
    case 'name_collision':
      return 409;
    case 'validation':
      return 400;
    case 'unauthorized':
    case 'not_authenticated':
      return 401;
    default:
      return 502;
  }
}

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

  const manifest = (body as Record<string, unknown>)?.manifest;
  if (!manifest || typeof manifest !== 'object') {
    return NextResponse.json({ error: 'A package manifest is required' }, { status: 400 });
  }

  try {
    const result = await publish(manifest);
    return NextResponse.json(result, { status: statusForResult(result) });
  } catch (err) {
    log.error('Failed to publish package', err);
    return NextResponse.json({ ok: false, error: 'Failed to publish package' }, { status: 500 });
  }
}

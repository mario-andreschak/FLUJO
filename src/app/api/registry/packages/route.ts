/**
 * DELETE /api/registry/packages
 *
 * Permanently deletes a package owned by the signed-in registry publisher.
 * The local service supplies the encrypted-at-rest account token and the hosted
 * registry remains the ownership authority. Local-only + unlock-gated.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { deletePublishedPackage } from '@/backend/services/registry';
import type { RegistryDeleteResult } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/packages/route');

function statusForResult(result: RegistryDeleteResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case 'unauthorized':
    case 'not_authenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'validation':
      return 400;
    default:
      return 502;
  }
}

export async function DELETE(request: NextRequest) {
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

  const packageId =
    typeof (body as Record<string, unknown>)?.packageId === 'string'
      ? ((body as Record<string, unknown>).packageId as string).trim()
      : '';
  if (!packageId) {
    return NextResponse.json({ error: 'A package id is required' }, { status: 400 });
  }

  try {
    const result = await deletePublishedPackage(packageId);
    return NextResponse.json(result, { status: statusForResult(result) });
  } catch (err) {
    log.error('Failed to delete package', err);
    return NextResponse.json({ ok: false, code: 'error', error: 'Failed to delete package' }, { status: 500 });
  }
}

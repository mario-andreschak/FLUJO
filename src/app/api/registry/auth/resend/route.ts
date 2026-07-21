/**
 * Resend the registry email-confirmation link (issue #197).
 *
 *   POST -> { email? }   (falls back to the stored pending address)
 *
 * Local-only + unlock-gated. NOT on the middleware public allow-list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { resendConfirmation } from '@/backend/services/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/auth/resend/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty/invalid body is fine — fall back to the stored address.
  }
  const email = typeof (body as Record<string, unknown>)?.email === 'string'
    ? ((body as Record<string, unknown>).email as string).trim()
    : undefined;

  try {
    const result = await resendConfirmation(email);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err) {
    log.error('Failed to resend confirmation', err);
    return NextResponse.json({ success: false, error: 'Failed to resend confirmation' }, { status: 500 });
  }
}

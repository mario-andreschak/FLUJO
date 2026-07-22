/**
 * Request a registry account password-reset email (issue #206).
 *
 *   POST -> { email }
 *
 * Proxies the hosted registry's Supabase-backed reset flow: FLUJO only forwards
 * the "send me a reset email" request; the actual password change happens on the
 * registry's own hosted page reached via the emailed link. No reset token or
 * new-password form is handled here, so nothing is issued/returned to the browser.
 *
 * Local-only + unlock-gated. NOT on the middleware public allow-list. The
 * plaintext email address is never logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { requestPasswordReset } from '@/backend/services/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/auth/reset/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty/invalid body -> treated as a missing email below.
  }
  const email = typeof (body as Record<string, unknown>)?.email === 'string'
    ? ((body as Record<string, unknown>).email as string).trim()
    : '';

  if (!email) {
    return NextResponse.json({ success: false, error: 'Email is required' }, { status: 400 });
  }

  try {
    const result = await requestPasswordReset(email);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err) {
    log.error('Failed to request password reset', err);
    return NextResponse.json({ success: false, error: 'Failed to request password reset' }, { status: 500 });
  }
}

/**
 * Registry account auth (issue #197): sign up / log in / log out / status.
 *
 *   GET    -> masked account status
 *   POST   -> { action: 'signup' | 'login', email, password }
 *   DELETE -> log out (clears stored tokens)
 *
 * Local-only + unlock-gated (secrets at rest). NOT on the middleware public
 * allow-list. Passwords are never logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { authenticate, getAccountStatus, logout } from '@/backend/services/registry';
import type { RegistryAuthAction } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/auth/route');

export async function GET() {
  const lock = await assertUnlocked();
  if (lock) return lock;
  try {
    return NextResponse.json(await getAccountStatus());
  } catch (err) {
    log.error('Failed to read account status', err);
    return NextResponse.json({ error: 'Failed to read account status' }, { status: 500 });
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

  const raw = (body ?? {}) as Record<string, unknown>;
  const action = raw.action;
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';

  if (action !== 'signup' && action !== 'login') {
    return NextResponse.json({ error: "action must be 'signup' or 'login'" }, { status: 400 });
  }
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  try {
    const result = await authenticate(email, password, action as RegistryAuthAction);
    const httpStatus = result.status === 'error' ? 400 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err) {
    log.error(`Failed to ${action}`, err);
    return NextResponse.json({ error: 'Authentication request failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  try {
    await logout();
    return NextResponse.json({ success: true });
  } catch (err) {
    log.error('Failed to log out', err);
    return NextResponse.json({ error: 'Failed to log out' }, { status: 500 });
  }
}

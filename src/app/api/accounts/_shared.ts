import { readBoundedBody } from '@/utils/http/boundedBody';
import { createLogger } from '@/utils/logger';
import { AccountInputError } from '@/backend/services/accounts/admin';
import { PasswordHashBusyError } from '@/backend/services/accounts/passwords';
import { AccountsConflictError, AccountsDamagedError } from '@/backend/services/accounts/store';
import { accountsDamagedResponse, denialResponse } from '@/backend/services/accounts/requestAccess';

const log = createLogger('app/api/accounts');

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** A small JSON object body. Anything else is `null`. */
export async function readJsonObject(request: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readBoundedBody(request, maxBytes);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A browser change must come from this installation's own page (the proxy checks Host and Origin too). */
export function sameOriginChange(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

export function signInRequired(): Response {
  return denialResponse('sign-in-required', '');
}

export function adminRequired(): Response {
  return denialResponse('admin-required', '');
}

export function multiUserOff(): Response {
  return json({ error: 'Multi-user mode is off.', code: 'MULTI_USER_OFF' }, 409);
}

/** Plain answers for the errors the accounts services throw. */
export function accountErrorResponse(error: unknown): Response {
  if (error instanceof AccountInputError) return json({ error: error.message }, error.status);
  if (error instanceof AccountsConflictError) return json({ error: error.message, code: 'ACCOUNTS_CHANGED' }, 409);
  if (error instanceof AccountsDamagedError) return accountsDamagedResponse();
  if (error instanceof PasswordHashBusyError) {
    return json({ error: error.message, code: 'SIGN_IN_BUSY' }, 503, { 'Retry-After': String(error.retryAfterSeconds) });
  }
  log.error('Accounts request failed', error);
  return json({ error: 'The accounts change could not be saved. Try again.' }, 500);
}

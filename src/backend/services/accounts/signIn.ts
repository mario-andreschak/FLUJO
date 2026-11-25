import { USER_NAME_PATTERN, PASSWORD_MAX_LENGTH, type AccountSession, type AccountUser } from '@/shared/types/accounts';
import { createLogger } from '@/utils/logger';
import { hashPassword, verifyPassword, verifyUnknownUser } from './passwords';
import { recordFailedSignIn, recordSuccessfulSignIn, signInWaitMs } from './signInThrottle';
import { appendAudit, loadAccountsState } from './store';
import { createAccountSession } from './sessions';
import { upgradePasswordHash } from './admin';

const log = createLogger('backend/services/accounts/signIn');

/** Why a sign-in did not work, with the HTTP status the route answers. */
export class SignInError extends Error {
  readonly status: 401 | 403 | 409 | 429;
  readonly code: string;
  readonly retryAfterMs: number;
  constructor(status: 401 | 403 | 409 | 429, code: string, message: string, retryAfterMs = 0) {
    super(message);
    this.name = 'SignInError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function wrongPassword(waitMs: number): SignInError {
  return new SignInError(401, 'SIGN_IN_FAILED', 'The name or password is not right.', waitMs);
}

function waitMessage(waitMs: number): string {
  const seconds = Math.ceil(waitMs / 1000);
  return seconds < 120 ? `Too many wrong tries for this name. Try again in ${seconds} seconds.`
    : `Too many wrong tries for this name. Try again in ${Math.ceil(seconds / 60)} minutes.`;
}

/**
 * Check a name and password and start a session (#574). Wrong tries slow the
 * name down (see `signInThrottle.ts`); an unknown name costs the same time as
 * a known one, so the answer does not reveal which names exist.
 */
export async function signIn(rawName: unknown, rawPassword: unknown, now = Date.now()):
  Promise<{ token: string; session: AccountSession; user: AccountUser }> {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  const state = await loadAccountsState();
  if (state.mode !== 'on') throw new SignInError(409, 'MULTI_USER_OFF', 'Sign-in with a name and password is not turned on here.');
  const wait = signInWaitMs(name, now);
  if (wait > 0) throw new SignInError(429, 'SIGN_IN_SLOWED', waitMessage(wait), wait);
  const user = USER_NAME_PATTERN.test(name) ? state.accounts.users.find(candidate => candidate.name === name) : undefined;
  if (!user || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    await verifyUnknownUser(password);
    const waitMs = recordFailedSignIn(name, now);
    await appendAudit({ action: 'sign-in-failed', actorUserId: null, detail: { reason: 'unknown-name-or-empty' } });
    throw wrongPassword(waitMs);
  }
  const check = await verifyPassword(password, user.passwordHash);
  if (!check.ok) {
    const waitMs = recordFailedSignIn(name, now);
    await appendAudit({ action: 'sign-in-failed', actorUserId: null, target: { type: 'user', id: user.id } });
    throw wrongPassword(waitMs);
  }
  if (user.disabled) {
    throw new SignInError(403, 'ACCOUNT_DISABLED', 'This account is turned off. Ask an admin to turn it on again.');
  }
  recordSuccessfulSignIn(name);
  if (check.needsRehash) {
    try { await upgradePasswordHash(user.id, await hashPassword(password)); }
    catch (error) { log.warn('Could not store a stronger password hash; the old one keeps working.', error); }
  }
  const { token, session } = await createAccountSession(user, now);
  await appendAudit({ action: 'sign-in', actorUserId: user.id, target: { type: 'session', id: session.id } });
  return { token, session, user };
}

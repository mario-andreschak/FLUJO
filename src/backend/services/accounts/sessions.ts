import { createHash, randomBytes } from 'node:crypto';
import {
  ACCOUNT_SESSION_COOKIE_HTTP, ACCOUNT_SESSION_COOKIE_HTTPS, ACCOUNT_SESSION_MAX_AGE_MS, SESSION_TOKEN_PATTERN,
  accountSessionSchema, type AccountPrincipal, type AccountSession, type AccountUser,
} from '@/shared/types/accounts';
import { loadSessions, mutateSessions } from './store';

/**
 * Browser sessions for multi-user sign-in (#574). The cookie holds a random
 * `flo_a1_` token; `sessions.json` stores only its SHA-256 digest. A session
 * lasts 8 hours and ends earlier at sign-out, a password change or when the
 * person is disabled (their `generation` changes).
 */

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secure(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch { /* a relative test URL is plain HTTP */ }
  return process.env.FLUJO_OWNER_BROWSER_ORIGIN?.startsWith('https:') === true;
}

export function sessionCookieName(request: Request): string {
  return secure(request) ? ACCOUNT_SESSION_COOKIE_HTTPS : ACCOUNT_SESSION_COOKIE_HTTP;
}

/** The session token from the request's cookie, or `null`. Two cookies with one name count as none. */
export function readSessionToken(request: Request): string | null {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim());
  for (const name of [ACCOUNT_SESSION_COOKIE_HTTPS, ACCOUNT_SESSION_COOKIE_HTTP]) {
    const values = cookies.filter(value => value.startsWith(`${name}=`));
    if (values.length === 1) {
      const token = values[0].slice(name.length + 1);
      if (SESSION_TOKEN_PATTERN.test(token)) return token;
    }
  }
  return null;
}

export function sessionCookieHeader(request: Request, token: string, maxAgeMs: number): string {
  return `${sessionCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}${secure(request) ? '; Secure' : ''}`;
}

export function clearSessionCookieHeader(request: Request): string {
  return `${sessionCookieName(request)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(request) ? '; Secure' : ''}`;
}

/** Start a session for a person who just proved their password. Returns the cookie token (shown nowhere else). */
export async function createAccountSession(user: AccountUser, now = Date.now()): Promise<{ token: string; session: AccountSession }> {
  const token = `flo_a1_${randomBytes(32).toString('base64url')}`;
  const session = accountSessionSchema.parse({
    id: randomBytes(16).toString('hex'),
    digest: tokenDigest(token),
    userId: user.id,
    userGeneration: user.generation,
    issuedAt: now,
    expiresAt: now + ACCOUNT_SESSION_MAX_AGE_MS,
  });
  await mutateSessions(current => ({ ...current, sessions: [...current.sessions, session] }), now);
  return { token, session };
}

/** The signed-in person behind the request's cookie, or `null`. */
export async function resolveSessionPrincipal(request: Request, now = Date.now()): Promise<AccountPrincipal | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const digest = tokenDigest(token);
  const session = (await loadSessions()).sessions.find(candidate => candidate.digest === digest);
  if (!session || session.issuedAt > now || session.expiresAt <= now) return null;
  return Object.freeze({ kind: 'session', userId: session.userId, sessionId: session.id, generation: session.userGeneration });
}

/** Sign out: forget the session behind the request's cookie (if any). */
export async function endAccountSession(request: Request): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;
  const digest = tokenDigest(token);
  if (!(await loadSessions()).sessions.some(session => session.digest === digest)) return;
  await mutateSessions(current => ({ ...current, sessions: current.sessions.filter(session => session.digest !== digest) }));
}

/** End every session of one person (disabled, or the password changed). Their generation already refuses them; this tidies the file. */
export async function endSessionsForUser(userId: string): Promise<void> {
  if (!(await loadSessions()).sessions.some(session => session.userId === userId)) return;
  await mutateSessions(current => ({ ...current, sessions: current.sessions.filter(session => session.userId !== userId) }));
}

/** Turning multi-user mode off ends every session. */
export async function endAllSessions(): Promise<void> {
  if ((await loadSessions()).sessions.length === 0) return;
  await mutateSessions(current => ({ ...current, sessions: [] }));
}

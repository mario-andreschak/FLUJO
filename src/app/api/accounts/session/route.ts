import { publicUser } from '@/backend/services/accounts/admin';
import { ensurePersonalWorkspace } from '@/backend/services/accounts/personalWorkspace';
import { accountRequestUser } from '@/backend/services/accounts/requestAccess';
import { clearSessionCookieHeader, endAccountSession, sessionCookieHeader } from '@/backend/services/accounts/sessions';
import { SignInError, signIn } from '@/backend/services/accounts/signIn';
import { loadAccountsState } from '@/backend/services/accounts/store';
import { accountErrorResponse, json, readJsonObject, sameOriginChange } from '../_shared';

// FLUJO_INSTALLATION_WIDE_ROUTE: signs people in and out of a multi-user installation (#574).

export const runtime = 'nodejs';

/** Whether sign-in is on here, and who is signed in. Works while signed out. */
export async function GET(request: Request): Promise<Response> {
  try {
    const state = await loadAccountsState();
    if (state.mode === 'damaged') return json({ mode: 'damaged', user: null });
    if (state.mode === 'off') return json({ mode: 'off', user: null });
    const current = await accountRequestUser(request);
    return json({ mode: 'on', user: current?.user ? publicUser(current.user) : null });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Sign in with a name and password. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(request, 2048);
  if (!body) return json({ error: 'Send a name and a password.' }, 400);
  try {
    const { token, session, user } = await signIn(body.name, body.password);
    const workspace = await ensurePersonalWorkspace(user);
    return json({ user: publicUser(user), ...(workspace ? { createdWorkspace: workspace } : {}) }, 200, {
      'Set-Cookie': sessionCookieHeader(request, token, session.expiresAt - session.issuedAt),
    });
  } catch (error) {
    if (error instanceof SignInError) {
      return json({ error: error.message, code: error.code }, error.status,
        error.retryAfterMs > 0 ? { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) } : {});
    }
    return accountErrorResponse(error);
  }
}

/** Sign out this browser. */
export async function DELETE(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    await endAccountSession(request);
    return json({ signedIn: false }, 200, { 'Set-Cookie': clearSessionCookieHeader(request) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

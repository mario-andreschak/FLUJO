import { listWorkspaces } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { readOwnerPolicy } from '@/backend/services/security/ownerPolicy';
import { disableMultiUser, enableMultiUser, mayAdminister, publicUser } from '@/backend/services/accounts/admin';
import { accountRequestUser } from '@/backend/services/accounts/requestAccess';
import { clearSessionCookieHeader, createAccountSession, sessionCookieHeader } from '@/backend/services/accounts/sessions';
import { accountErrorResponse, adminRequired, json, readJsonObject, sameOriginChange, signInRequired } from '../_shared';

// FLUJO_INSTALLATION_WIDE_ROUTE: turns multi-user mode on or off for the whole installation (#574).

export const runtime = 'nodejs';

const log = createLogger('app/api/accounts/mode');

function ownerPolicy() {
  const file = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  if (!file) return null;
  try {
    return readOwnerPolicy(file);
  } catch (error) {
    log.warn('Could not read the owner policy; its tokens are not copied to the first admin.', error);
    return null;
  }
}

/**
 * `{ enabled: true, name, displayName?, password }` turns multi-user mode on
 * and signs this browser in as the first admin. `{ enabled: false }` turns it
 * off (admins only); nothing moves and everyone is signed out.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(request, 2048);
  if (!body || typeof body.enabled !== 'boolean') return json({ error: 'Say whether to turn multi-user mode on or off.' }, 400);
  try {
    const current = await accountRequestUser(request);
    if (current) {
      if (!current.user) return signInRequired();
      if (!mayAdminister(current.user)) return adminRequired();
    }
    if (!body.enabled) {
      await disableMultiUser(current?.user?.id ?? null);
      return json({ mode: 'off' }, 200, { 'Set-Cookie': clearSessionCookieHeader(request) });
    }
    if (current) return json({ mode: 'on', user: publicUser(current.user!) });
    const { createdAdmin: admin } = await enableMultiUser(body, {
      workspaces: (await listWorkspaces()).map(workspace => workspace.name),
      ownerPolicy: ownerPolicy(),
    });
    // Turned on again with the people from last time: they sign in as usual.
    if (!admin) return json({ mode: 'on', user: null });
    const { token, session } = await createAccountSession(admin);
    return json({ mode: 'on', user: publicUser(admin) }, 200, {
      'Set-Cookie': sessionCookieHeader(request, token, session.expiresAt - session.issuedAt),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

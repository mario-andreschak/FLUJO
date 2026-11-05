import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { createOwnerSession, ownerBrowserRequestAllowed, revokeOwnerSession } from '@/backend/services/security/ownerSession';
import { recordAccessEvent } from '@/backend/services/security/accessAudit';
import { isNamedAccessOn } from '@/backend/services/security/ownerPolicy';
import { accessActorFromPrincipal } from '@/backend/services/security/accessContext';

export const runtime = 'nodejs';

function response(body: unknown, status = 200, cookie?: string): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}),
  } });
}

export function POST(request: Request): Response {
  if (!ownerBrowserRequestAllowed(request, true)) return response({ error: 'Forbidden' }, 403);
  const admitted = resolveOwnerRequest(request, undefined, { requireBearer: true });
  if (!admitted.ok) {
    if (isNamedAccessOn()) recordAccessEvent({ action: 'login', outcome: 'denied', detail: String(admitted.response.status) });
    return admitted.response;
  }
  try {
    const denied = admitted.authorization.recheck();
    if (denied) return denied;
    const { principal } = admitted.authorization;
    const cookie = createOwnerSession(request, principal);
    if (principal.named) recordAccessEvent({ action: 'login', actor: accessActorFromPrincipal(principal), target: principal.credentialId });
    return response({ authenticated: true }, 200, cookie);
  } catch { return response({ error: 'Owner authentication is unavailable.' }, 503); }
}

export function GET(request: Request): Response {
  const admitted = resolveOwnerRequest(request);
  return admitted.ok ? response({ authenticated: true, ownerId: admitted.authorization.principal.ownerId,
    expiresAt: admitted.authorization.principal.expiresAt }) : admitted.response;
}

export function DELETE(request: Request): Response {
  if (!ownerBrowserRequestAllowed(request, true)) return response({ error: 'Forbidden' }, 403);
  const signedIn = resolveOwnerRequest(request);
  try {
    const cookie = revokeOwnerSession(request);
    if (signedIn.ok && signedIn.authorization.principal.named) {
      recordAccessEvent({ action: 'logout', actor: accessActorFromPrincipal(signedIn.authorization.principal),
        target: signedIn.authorization.principal.credentialId });
    }
    return response({ authenticated: false }, 200, cookie);
  }
  catch { return response({ error: 'Owner authentication is unavailable.' }, 503); }
}

import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { createOwnerSession, ownerBrowserRequestAllowed, revokeOwnerSession } from '@/backend/services/security/ownerSession';

export const runtime = 'nodejs';

function response(body: unknown, status = 200, cookie?: string): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}),
  } });
}

export async function POST(request: Request): Promise<Response> {
  if (!ownerBrowserRequestAllowed(request, true)) return response({ error: 'Forbidden' }, 403);
  const admitted = await resolveOwnerRequest(request, ['control:admin', 'secrets:read'], { requireBearer: true });
  if (!admitted.ok) return admitted.response;
  try {
    const denied = await admitted.authorization.recheck();
    if (denied) return denied;
    return response({ authenticated: true }, 200, await createOwnerSession(request, admitted.authorization.principal));
  } catch { return response({ error: 'Owner authentication is unavailable.' }, 503); }
}

export async function GET(request: Request): Promise<Response> {
  const admitted = await resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  return admitted.ok ? response({ authenticated: true, ownerId: admitted.authorization.principal.ownerId,
    expiresAt: admitted.authorization.principal.expiresAt }) : admitted.response;
}

export async function DELETE(request: Request): Promise<Response> {
  if (!ownerBrowserRequestAllowed(request, true)) return response({ error: 'Forbidden' }, 403);
  try { return response({ authenticated: false }, 200, await revokeOwnerSession(request)); }
  catch { return response({ error: 'Owner authentication is unavailable.' }, 503); }
}

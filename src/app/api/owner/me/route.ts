import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { accessJson } from '../_access';

// FLUJO_INSTALLATION_WIDE_ROUTE: says who the caller is; holds no workspace data.
export const runtime = 'nodejs';

/** Who am I, what may I do. Lets a client adapt instead of guessing from refusals. */
export function GET(request: Request): Response {
  if (process.env.FLUJO_OWNER_AUTH_FILE === undefined) return accessJson({ mode: 'off' });
  const resolved = resolveOwnerRequest(request);
  if (!resolved.ok) return resolved.response;
  const { principal } = resolved.authorization;
  return accessJson({
    mode: principal.named ? 'named' : 'owner',
    credentialId: principal.credentialId,
    ...(principal.name ? { name: principal.name } : {}),
    ...(principal.role ? { role: principal.role } : {}),
    scopes: principal.scopes,
    ...(principal.workspaceId ? { workspaceId: principal.workspaceId } : {}),
    ...(principal.flowIds ? { flowIds: principal.flowIds } : {}),
    expiresAt: principal.expiresAt,
    via: principal.via,
  });
}

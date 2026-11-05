import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { accessActorFromPrincipal, type AccessActor } from '@/backend/services/security/accessContext';
import { AccessPeopleError } from '@/backend/services/security/accessPeople';
import { readBoundedBody } from '@/utils/http/boundedBody';

/** Shared by the people, audit and access routes. Nothing here is ever cached. */
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 8 * 1024;

export function accessJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function namedAccessOff(): Response {
  return accessJson({ error: 'Named access is off on this installation.', code: 'NAMED_ACCESS_OFF' }, 409);
}

/** Admission comes from the route table, so a narrow credential reaches only what its scope names. */
export function requireNamedActor(request: Request): { actor: AccessActor } | { response: Response } {
  const resolved = resolveOwnerRequest(request);
  if (!resolved.ok) return { response: resolved.response };
  const actor = accessActorFromPrincipal(resolved.authorization.principal);
  return actor ? { actor } : { response: namedAccessOff() };
}

export async function readAccessBody(request: Request): Promise<Record<string, unknown> | null> {
  let bytes: Uint8Array;
  try { bytes = await readBoundedBody(request, MAX_BODY_BYTES); } catch { return null; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** Plain reasons for the person at the screen, and nothing about files or paths. */
export function accessErrorResponse(error: unknown): Response {
  if (error instanceof AccessPeopleError) return accessJson({ error: error.message, code: error.code }, error.status);
  return accessJson({ error: 'The access list is unavailable.', code: 'ACCESS_UNAVAILABLE' }, 503);
}

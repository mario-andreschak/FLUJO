import { recordAccessEvent } from '@/backend/services/security/accessAudit';
import { createPerson, listPeople } from '@/backend/services/security/accessPeople';
import { accessErrorResponse, accessJson, readAccessBody, requireNamedActor } from '../_access';

// FLUJO_INSTALLATION_WIDE_ROUTE: people and credentials belong to the installation.
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  const admitted = requireNamedActor(request);
  if ('response' in admitted) return admitted.response;
  try { return accessJson({ people: listPeople(admitted.actor) }); }
  catch (error) { return accessErrorResponse(error); }
}

/** The plain secret is in this one response and nowhere else, ever. */
export async function POST(request: Request): Promise<Response> {
  const admitted = requireNamedActor(request);
  if ('response' in admitted) return admitted.response;
  const body = await readAccessBody(request);
  if (!body) return accessJson({ error: 'A JSON object is required.', code: 'INVALID' }, 400);
  try {
    const { person, token } = createPerson(admitted.actor, {
      name: body.name, role: body.role, scopes: body.scopes, expiresAt: body.expiresAt,
      workspaceId: body.workspaceId, flowIds: body.flowIds,
    });
    recordAccessEvent({ action: 'person.create', actor: admitted.actor, target: person.id, detail: person.role,
      ...(person.workspaceId ? { workspace: person.workspaceId } : {}) });
    return accessJson({ person, token }, 201);
  } catch (error) { return accessErrorResponse(error); }
}

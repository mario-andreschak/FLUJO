import { recordAccessEvent } from '@/backend/services/security/accessAudit';
import { revokePerson, updatePerson } from '@/backend/services/security/accessPeople';
import { accessErrorResponse, accessJson, readAccessBody, requireNamedActor } from '../../_access';

// FLUJO_INSTALLATION_WIDE_ROUTE: people and credentials belong to the installation.
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/** Rename, change the expiry (now means expire now), or change the role or flow limit. */
export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const admitted = requireNamedActor(request);
  if ('response' in admitted) return admitted.response;
  const body = await readAccessBody(request);
  if (!body) return accessJson({ error: 'A JSON object is required.', code: 'INVALID' }, 400);
  const { id } = await params;
  try {
    const person = updatePerson(admitted.actor, id, {
      ...('name' in body ? { name: body.name } : {}),
      ...('role' in body ? { role: body.role } : {}),
      ...('scopes' in body ? { scopes: body.scopes } : {}),
      ...('expiresAt' in body ? { expiresAt: body.expiresAt } : {}),
      ...('workspaceId' in body ? { workspaceId: body.workspaceId } : {}),
      ...('flowIds' in body ? { flowIds: body.flowIds } : {}),
    });
    // Which fields changed, never their values.
    const fields = ['name', 'role', 'scopes', 'expiresAt', 'workspaceId', 'flowIds'].filter(field => field in body);
    recordAccessEvent({ action: 'person.update', actor: admitted.actor, target: person.id, detail: fields.join(','),
      ...(person.workspaceId ? { workspace: person.workspaceId } : {}) });
    return accessJson({ person });
  } catch (error) { return accessErrorResponse(error); }
}

/** Revoke. Takes effect on the next request, including a stream that is already open. */
export async function DELETE(request: Request, { params }: RouteContext): Promise<Response> {
  const admitted = requireNamedActor(request);
  if ('response' in admitted) return admitted.response;
  const { id } = await params;
  try {
    const person = revokePerson(admitted.actor, id);
    recordAccessEvent({ action: 'person.revoke', actor: admitted.actor, target: person.id,
      ...(person.workspaceId ? { workspace: person.workspaceId } : {}) });
    return accessJson({ person });
  } catch (error) { return accessErrorResponse(error); }
}

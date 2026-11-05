import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { accessRecordWritable, recordAccessEvent } from '@/backend/services/security/accessAudit';
import { accessActorFromPrincipal } from '@/backend/services/security/accessContext';
import { enableNamedAccess } from '@/backend/services/security/accessPeople';
import { getExposureMode } from '@/utils/http/exposureMode';
import { accessErrorResponse, accessJson, readAccessBody } from '../_access';

// FLUJO_INSTALLATION_WIDE_ROUTE: reports and switches named access for the whole installation.
export const runtime = 'nodejs';

/**
 * off     no policy file is selected; an ordinary single-user install
 * policy  a policy file is selected, with owner credentials only
 * named   named access is on
 */
export function GET(request: Request): Response {
  if (process.env.FLUJO_OWNER_AUTH_FILE === undefined) {
    return accessJson({ mode: 'off', exposure: getExposureMode() });
  }
  const resolved = resolveOwnerRequest(request);
  if (!resolved.ok) return resolved.response;
  const { principal } = resolved.authorization;
  return accessJson({
    mode: principal.named ? 'named' : 'policy',
    exposure: getExposureMode(),
    canManage: principal.scopes.includes('access:manage'),
    canReadRecord: principal.scopes.includes('audit:read'),
    recordWritable: accessRecordWritable(),
  });
}

/** Only an administrator switches this on, and doing so keeps every existing credential working. */
export async function POST(request: Request): Promise<Response> {
  if (process.env.FLUJO_OWNER_AUTH_FILE === undefined) {
    return accessJson({
      error: 'Select a policy file first. The guide in the Settings page has the exact steps.',
      code: 'NAMED_ACCESS_OFF',
    }, 409);
  }
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  if (!resolved.ok) return resolved.response;
  const body = await readAccessBody(request);
  if (body?.action !== 'enable' || Object.keys(body).length !== 1) {
    return accessJson({ error: 'The only action is enable.', code: 'INVALID' }, 400);
  }
  try {
    const { changed } = enableNamedAccess();
    if (changed) {
      recordAccessEvent({ action: 'access.enable',
        actor: accessActorFromPrincipal({ ...resolved.authorization.principal, named: true }) });
    }
    return accessJson({ mode: 'named', changed });
  } catch (error) { return accessErrorResponse(error); }
}

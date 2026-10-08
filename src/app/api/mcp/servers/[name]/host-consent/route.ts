import { NextRequest } from 'next/server';
import { resolveWorkspace } from '@/app/api/_workspace';
import { ensureWorkspaceDirs, runWithWorkspace } from '@/utils/workspace';
import { getWorkerBootstrapStatus, isWorkerMode } from '@/backend/services/workspace/workerMode';
import { authorizeExecutionTransport } from '@/backend/execution/extensions';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { approveBundledHostConsent, BundledConsentError, previewBundledHostConsent, revokeBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { consentDiagnosticCode } from '@/backend/services/security/bundledConsentDiagnostic';

type RouteContext = { params: Promise<{ name: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const scopes = ['control:admin', 'mcp:access', 'secrets:read'] as const;

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const owner = resolveOwnerRequest(request, scopes, { requireBearer: true });
  if (!owner.ok) return owner.response;
  const locked = await assertUnlocked(); if (locked) return locked;
  const runtimeHome = request.nextUrl.searchParams.get('runtimeHome');
  if (runtimeHome !== 'host' && runtimeHome !== 'isolated') return json({ error: 'Choose a runtime home mode.' }, 400);
  try {
    const { name } = await params;
    const preview = await previewBundledHostConsent(name, { runtimeHome });
    const revoked = owner.authorization.recheck(); if (revoked) return revoked;
    const policy = preview.config.trustedHost as { environmentNames: string[] };
    return json({ serverName: name, policyDigest: preview.policyDigest, privileges: 'owner-account',
      command: preview.config.command, args: preview.config.args, roots: preview.config.roots,
      runtimeHome, environmentNames: policy.environmentNames, revision: preview.revision });
  } catch (error) {
    if (!owner.authorization.recheck()) console.warn(`[bundled-consent-preview] ${consentDiagnosticCode(error)}`);
    return json({ error: 'A fixed installed package proposal is unavailable.' }, 409);
  }
}

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const owner = resolveOwnerRequest(request, scopes, { requireBearer: true });
  if (!owner.ok) return owner.response;
  const locked = await assertUnlocked(); if (locked) return locked;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid consent request.' }, 400);
    const { runtimeHome, reviewedDigest, expiresAt } = body as Record<string, unknown>;
    if ((runtimeHome !== 'host' && runtimeHome !== 'isolated') || typeof reviewedDigest !== 'string' || typeof expiresAt !== 'number') return json({ error: 'Invalid consent request.' }, 400);
    const { name } = await params;
    const result = await approveBundledHostConsent(request, name, { runtimeHome, reviewedDigest, expiresAt });
    return json({ approved: true, serverName: name, policyDigest: result.policyDigest, expiresAt });
  } catch (error) {
    if (error instanceof BundledConsentError) return error.response;
    if (!owner.authorization.recheck()) console.warn(`[bundled-consent-approval] ${consentDiagnosticCode(error)}`);
    return json({ error: 'The proposal or private owner approval changed. Review it again.' }, 409);
  }
}

// FLUJO_INSTALLATION_WIDE_ROUTE: strict private owner provisioning remains
// reachable before worker MCP readiness; snapshot/import authority is excluded.
function operatorWorkspace(handler: (request: NextRequest, context: RouteContext) => Promise<Response>) {
  return async (request: NextRequest, context: RouteContext) => {
    const execution = authorizeExecutionTransport(request);
    if (execution !== undefined) return execution ?? json({ error: 'A private operator owner bearer is required.' }, 403);
    const owner = resolveOwnerRequest(request, scopes, { requireBearer: true }); if (!owner.ok) return owner.response;
    try {
      const workspace = await resolveWorkspace(request);
      if (isWorkerMode() && getWorkerBootstrapStatus().workspace !== workspace) return json({ error: 'Worker package preparation is unavailable for this workspace.' }, 409);
      await ensureWorkspaceDirs(workspace);
      return runWithWorkspace(workspace, () => handler(request, context));
    } catch { return json({ error: 'Workspace storage is unavailable.' }, 503); }
  };
}
export const GET = operatorWorkspace(GET_handler);
export const POST = operatorWorkspace(POST_handler);
export const DELETE = operatorWorkspace(async (request: NextRequest, { params }: RouteContext) => {
  const owner = resolveOwnerRequest(request, scopes, { requireBearer: true }); if (!owner.ok) return owner.response;
  try { return json(await revokeBundledHostConsent(request, (await params).name)); }
  catch (error) { if (error instanceof BundledConsentError) return error.response; return json({ error: 'Private consent revocation failed.' }, 409); }
});

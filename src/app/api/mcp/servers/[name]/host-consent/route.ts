import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { approveBundledHostConsent, BundledConsentError, previewBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';

type RouteContext = { params: Promise<{ name: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status });
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
  } catch { return json({ error: 'A fixed installed package proposal is unavailable.' }, 409); }
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
    return json({ error: 'The proposal or private owner approval changed. Review it again.' }, 409);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);

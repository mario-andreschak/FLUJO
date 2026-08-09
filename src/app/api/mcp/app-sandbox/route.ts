import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { isValidMcpAppDomain } from '@/shared/utils/mcpAppOrigin';
import { extractAppHtml } from '@/shared/utils/mcpApps';
import { mcpService } from '@/backend/services/mcp';
import { getEffectiveMcpAppConsent } from '@/backend/mcpApps/appConsent';
import { deriveVerifiedMcpAppOriginKey } from '@/backend/mcpApps/appOrigin';
import { getCurrentWorkspace } from '@/utils/workspace';
import { getExposureMode } from '@/utils/http/exposureMode';
import {
  deriveSandboxPublicUrl,
  ensureSandboxForOriginKey,
  hasValidSandboxAppUrlTemplate,
  registerSandboxHostOrigin,
} from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox?serverName=…&uri=…
 *
 * Verifies the exact MCP App resource and returns a sandbox endpoint whose
 * browser origin and token are scoped to that host-owned resource identity.
 *
 * Query parameters:
 *   - originKey (optional compatibility hint): Must exactly match the key the
 *     server derives. It never selects an origin and a mismatch is rejected.
 *
 * Local installs use `http://<originKey>.localhost:<port>/sandbox.html` on a
 * shared loopback listener. Hosted installs require a `{app}` hostname template.
 *
 * Response shape:
 *   - port: Port number for the sandbox listener
 *   - token: Access token (per-app scoped or shared)
 *   - url?: Browser-visible URL (hosted HTTPS deployments)
 *   - originKey: Server-derived, workspace-scoped origin key
 *   - shared: Always false; retained only for compatibility with older clients
 *
 * Gated like the rest of the API (deny-by-default): MCP Apps only render inside
 * an active chat, which already requires the encryption unlock.
 */
function externalOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || request.nextUrl.protocol.replace(/:$/, '') || 'http';
  const host = forwardedHost || request.headers.get('host') || request.nextUrl.host;
  return `${protocol}://${host}`;
}

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const serverName = request.nextUrl.searchParams.get('serverName')?.trim();
  const uri = request.nextUrl.searchParams.get('uri')?.trim();
  const conversationId = request.nextUrl.searchParams.get('conversationId')?.trim();
  if (!serverName || !uri) {
    return NextResponse.json(
      { error: 'mcp_app_consent_required' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const configs = await mcpService.loadServerConfigs();
  const config = Array.isArray(configs) ? configs.find((candidate) => candidate.name === serverName) : undefined;
  const consent = await getEffectiveMcpAppConsent(config, serverName, uri, conversationId);
  if (consent !== 'internal' && consent !== 'granted') {
    return NextResponse.json(
      { error: 'mcp_app_consent_required' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // The effective render grant (server opt-in while click gating is off, or a
  // per-app decision while it is on) does not prove that a caller-supplied
  // server/URI pair is a renderable MCP App. Re-read through the app-authorized
  // service and require an exact URI + stable MCP App MIME match before deriving
  // or minting anything.
  let resource: Awaited<ReturnType<typeof mcpService.readResourceFromApp>>;
  try {
    resource = await mcpService.readResourceFromApp(serverName, uri);
  } catch (error) {
    console.error('Failed to verify MCP App resource before sandbox allocation:', error);
    return NextResponse.json(
      { error: 'MCP App resource verification failed' },
      { status: 502, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
  }
  if (!resource.success) {
    const status = Number.isInteger(resource.statusCode)
      && (resource.statusCode as number) >= 400
      && (resource.statusCode as number) <= 599
      ? resource.statusCode as number
      : 502;
    return NextResponse.json(
      { error: resource.error || 'MCP App resource is unavailable' },
      {
        status,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      },
    );
  }
  const verifiedResource = extractAppHtml(resource.data, undefined, uri);
  if ('error' in verifiedResource) {
    return NextResponse.json(
      { error: verifiedResource.error },
      {
        status: 422,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      },
    );
  }

  const originKey = deriveVerifiedMcpAppOriginKey({
    workspace: getCurrentWorkspace(),
    serverName,
    uri,
  });

  // Older clients may still send their locally-derived key. Treat it only as
  // an assertion and reject disagreement; it can never choose the partition.
  const rawOriginKey = request.nextUrl.searchParams.get('originKey');
  if (rawOriginKey !== null) {
    if (!isValidMcpAppDomain(rawOriginKey)) {
      return NextResponse.json(
        { error: 'Invalid originKey' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (rawOriginKey !== originKey) {
      return NextResponse.json(
        { error: 'originKey does not match the verified MCP App resource' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (getExposureMode() !== 'localhost' && !hasValidSandboxAppUrlTemplate()) {
    return NextResponse.json(
      { error: 'Hosted MCP Apps require a sandbox URL with {app} as a hostname label' },
      { status: 503, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
  }

  let sandboxResult;
  try {
    sandboxResult = await ensureSandboxForOriginKey(originKey);
  } catch (error) {
    console.error('Failed to start scoped MCP App sandbox:', error);
  }
  if (
    !sandboxResult
    || !Number.isInteger(sandboxResult.port)
    || typeof sandboxResult.token !== 'string'
    || sandboxResult.token.length === 0
  ) {
    return NextResponse.json(
      { error: 'A workspace-scoped MCP Apps sandbox is unavailable' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store, no-cache',
          Pragma: 'no-cache',
          'Retry-After': '2',
        },
      },
    );
  }

  const hostOrigin = externalOrigin(request);
  const publicUrl = deriveSandboxPublicUrl(hostOrigin, sandboxResult.port, originKey);
  if (!publicUrl) {
    return NextResponse.json(
      { error: 'MCP Apps sandbox hosting requires a per-app origin template' },
      { status: 503, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
  }

  // Validate that the sandbox URL origin differs from the request origin
  // (enforces foreign-origin isolation).
  try {
    const sandboxUrlOrigin = new URL(publicUrl).origin;
    const requestOrigin = new URL(hostOrigin).origin;
    if (sandboxUrlOrigin === requestOrigin) {
      return NextResponse.json(
        { error: 'Sandbox origin must differ from host origin' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'MCP Apps sandbox returned an invalid per-app URL' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // The listener only sees its own origin. Record the authenticated embedder
  // after every fail-closed check, immediately before handing out credentials.
  registerSandboxHostOrigin(hostOrigin);

  return NextResponse.json(
    {
      port: sandboxResult.port,
      token: sandboxResult.token,
      url: publicUrl,
      originKey,
      shared: false,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}

export const GET = withWorkspaceRoute(GET_handler);

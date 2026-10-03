import { NextRequest, NextResponse } from 'next/server';
import { isLocalRequest, isRequestHostAllowed } from '@/utils/http/localRequest';
import { isPublicApiPath, isPublicOpenAiPath } from '@/utils/http/publicApiAllowlist';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { authorizeExecutionTransport } from '@/backend/execution/extensions';
import {
  assertOwnerRequest, resolveOwnerRequest, isRemoteAvatarVoiceRequest, assertRemoteAvatarVoiceOrigin,
} from '@/backend/services/security/ownerAccess';

/**
 * Fail-closed localhost / DNS-rebinding origin guard for `/api/*` and `/v1/*`
 * (#142, extended to `/v1` in #143).
 *
 * FLUJO is a single-user, localhost-posture app. Several `/api/*` routes execute
 * shell commands, spawn child processes, read/delete arbitrary files, or hand
 * back decrypted secrets. Historically each such handler had to remember to call
 * `assertLocalRequest()` — an opt-in convention that leaked three times
 * (#131 → #139 → #141, each round catching routes forgotten the round before)
 * and still left routes unguarded (`/api/encryption/secure`,
 * `/api/local-models/*`).
 *
 * This proxy makes the guard SECURE-BY-DEFAULT: it runs the same pure
 * `isLocalRequest(host, origin)` check against EVERY `/api/:path*` and
 * `/v1/:path*` request and returns 403 unless the request is local. The only
 * exceptions to the same-Origin half are the small, explicit, reviewed sets of
 * protocol-public routes in `publicApiAllowlist.ts` (external webhooks + OAuth
 * redirect/flow via `isPublicApiPath`; the OpenAI surface
 * `/v1/chat/completions` + `/v1/models` via `isPublicOpenAiPath`). They still
 * pass the selected exposure mode's Host boundary. Any future
 * `/api` or `/v1` route is therefore fail-closed by construction — in
 * particular the internal `/v1/chat/conversations/**` control-plane
 * (list / respond-approve = RCE / PATCH / DELETE / debug / edit-state /
 * breakpoints) is now guarded centrally (#143). The highest-risk handlers
 * additionally keep their in-handler `assertLocalRequest` as defense-in-depth.
 *
 * An explicitly configured owner policy adds hashed, scoped API bearer
 * authentication. The durable policy is read independently by the Node proxy
 * and workspace handler boundary; neither trusts an identity header or globals
 * from the other runtime. Protocol exceptions retain their handler auth.
 *
 * OPTIONS/preflight: CORS preflight requests carry no credentials or body and
 * cannot themselves reach a sink, so we let `OPTIONS` pass through to avoid
 * confusing browser errors; the actual (non-OPTIONS) method is still blocked for
 * non-local callers, and CORS headers are tightened in `next.config.mjs`.
 */
export function proxy(request: NextRequest): NextResponse {
  // Let CORS preflight through; the real request is still guarded below.
  if (request.method === 'OPTIONS') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Optional trusted integrations may admit only their narrow execution surface.
  // The route authenticates again; proxy and handler need not share runtime state.
  const extensionResponse = authorizeExecutionTransport(request);
  if (extensionResponse !== undefined) return extensionResponse === null
    ? NextResponse.next()
    : new NextResponse(extensionResponse.body, { status: extensionResponse.status, headers: extensionResponse.headers });

  if (isWorkerMode()) {
    // Private network membership and a caller-supplied Host header are not
    // authentication. Every worker HTTP control/execution surface uses the
    // dedicated bearer, including the normally public OpenAI and MCP routes.
    const unauthorized = assertSnapshotBearer(request);
    if (unauthorized) return new NextResponse(unauthorized.body, {
      status: unauthorized.status, headers: unauthorized.headers,
    });
    return NextResponse.next();
  }

  // The selected exposure mode is the outer boundary for every endpoint,
  // including the intentionally public webhook/OAuth/OpenAI surfaces.
  if (!isRequestHostAllowed(request.headers.get('host'))) {
    return new NextResponse(
      JSON.stringify({ error: 'Forbidden: this endpoint is not available at this host.' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  const ownerDenied = assertOwnerRequest(request);
  if (ownerDenied) return new NextResponse(ownerDenied.body, {
    status: ownerDenied.status, headers: ownerDenied.headers,
  });

  // The private BFF may differ from this host. Only exact voice routes with a
  // strict workspace-bound voice principal and explicitly approved Origin pass.
  if (isRemoteAvatarVoiceRequest(request)) {
    const admitted = resolveOwnerRequest(request, ['avatar:voice']);
    const denied = admitted.ok ? assertRemoteAvatarVoiceOrigin(request) : admitted.response;
    return denied ? new NextResponse(denied.body, { status: denied.status, headers: denied.headers }) : NextResponse.next();
  }

  // MCP routes retain their existing inline Origin guards outside worker mode.
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) return NextResponse.next();

  // Public protocol surfaces do not require a same-origin browser request, but
  // they still cannot escape the selected Localhost/Network/Public host scope.
  if (isPublicApiPath(pathname) || isPublicOpenAiPath(pathname)) {
    return NextResponse.next();
  }

  const local = isLocalRequest(
    request.headers.get('host'),
    request.headers.get('origin'),
  );
  if (!local) {
    return new NextResponse(
      JSON.stringify({ error: 'Forbidden: this endpoint only accepts local requests.' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  return NextResponse.next();
}

/** Scope the proxy to the `/api` and `/v1` surfaces (see matcher-scope note
 * in `publicApiAllowlist.ts`). `/v1/:path*` is guarded too (#143), with only the
 * protocol-public OpenAI endpoints identified via `isPublicOpenAiPath`.
 * MCP HTTP surfaces are also matched for worker bearer authentication; ordinary
 * local installations retain their existing inline local-request guards. */
export const config = {
  matcher: ['/api/:path*', '/v1/:path*', '/mcp-proxy/:path*', '/mcp-flows/:path*'],
};

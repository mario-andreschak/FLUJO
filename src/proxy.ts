import { NextRequest, NextResponse } from 'next/server';
import { isLocalRequest, isRequestHostAllowed } from '@/utils/http/localRequest';
import { isPublicApiPath, isPublicOpenAiPath } from '@/utils/http/publicApiAllowlist';

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
 * It only reads the Host/Origin headers and calls the pure `isLocalRequest`
 * helper, so it is safe in Next's proxy runtime.
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

  // The selected exposure mode is the outer boundary for every endpoint,
  // including the intentionally public webhook/OAuth/OpenAI surfaces.
  if (!isRequestHostAllowed(request.headers.get('host'))) {
    return new NextResponse(
      JSON.stringify({ error: 'Forbidden: this endpoint is not available at this host.' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

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
 * `/mcp-proxy/*`
 * and `/mcp-flows` are intentionally NOT matched here (they keep their inline
 * `isLocalRequest` guards). */
export const config = {
  matcher: ['/api/:path*', '/v1/:path*'],
};

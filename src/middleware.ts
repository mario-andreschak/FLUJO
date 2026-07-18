import { NextRequest, NextResponse } from 'next/server';
import { isLocalRequest } from '@/utils/http/localRequest';
import { isPublicApiPath } from '@/utils/http/publicApiAllowlist';

/**
 * Fail-closed localhost / DNS-rebinding origin guard for `/api/*` (#142).
 *
 * FLUJO is a single-user, localhost-posture app. Several `/api/*` routes execute
 * shell commands, spawn child processes, read/delete arbitrary files, or hand
 * back decrypted secrets. Historically each such handler had to remember to call
 * `assertLocalRequest()` — an opt-in convention that leaked three times
 * (#131 → #139 → #141, each round catching routes forgotten the round before)
 * and still left routes unguarded (`/api/encryption/secure`,
 * `/api/local-models/*`).
 *
 * This middleware makes the guard SECURE-BY-DEFAULT: it runs the same pure
 * `isLocalRequest(host, origin)` check against EVERY `/api/:path*` request and
 * returns 403 unless the request is local. The only exceptions are the small,
 * explicit, reviewed set of intentionally-public routes in
 * `publicApiAllowlist.ts` (external webhooks, OAuth redirect/flow). Any future
 * `/api` route is therefore fail-closed by construction — the highest-risk
 * handlers additionally keep their in-handler `assertLocalRequest` as
 * defense-in-depth.
 *
 * Runtime: middleware runs on the Edge runtime. It only reads the Host/Origin
 * headers and calls the pure `isLocalRequest` (no Node-only APIs), so it is
 * Edge-safe. `NextResponse` is Edge-compatible.
 *
 * OPTIONS/preflight: CORS preflight requests carry no credentials or body and
 * cannot themselves reach a sink, so we let `OPTIONS` pass through to avoid
 * confusing browser errors; the actual (non-OPTIONS) method is still blocked for
 * non-local callers, and CORS headers are tightened in `next.config.mjs`.
 */
export function middleware(request: NextRequest): NextResponse {
  // Let CORS preflight through; the real request is still guarded below.
  if (request.method === 'OPTIONS') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Explicit, reviewed allow-list of intentionally-public /api routes.
  if (isPublicApiPath(pathname)) {
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

/** Scope the middleware to the `/api` surface only (see matcher-scope note in
 * `publicApiAllowlist.ts`). `/v1/*`, `/mcp-proxy/*` and `/mcp-flows` are
 * intentionally NOT matched here. */
export const config = {
  matcher: ['/api/:path*'],
};

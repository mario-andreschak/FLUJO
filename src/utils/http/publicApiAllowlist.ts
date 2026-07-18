/**
 * Public `/api/*` allow-list for the fail-closed origin guard middleware (#142).
 *
 * `src/middleware.ts` runs the localhost / DNS-rebinding check against EVERY
 * `/api/:path*` request and returns 403 by default (secure-by-default). The only
 * routes that must stay reachable from a non-local origin are enumerated here.
 *
 * This list is the central review artifact: adding an entry makes a route
 * publicly reachable, so every addition must be a deliberate, reviewed diff.
 * `__tests__/security/routeGuardDrift.test.ts` snapshots this set and asserts
 * every entry maps to a real route file, so a new sensitive route can never be
 * made public by accident (and a stale entry can never silently open nothing).
 *
 * Matcher-scope note: `/v1/*`, `/mcp-proxy/*` and `/mcp-flows` are NOT under
 * `/api/`, so the middleware's `'/api/:path*'` matcher never touches them — they
 * keep their existing behavior (public CORS for `/v1/*`; inline `isLocalRequest`
 * for the mcp transports). They are intentionally absent from this list.
 */

/**
 * Routes matched EXACTLY. Use exact matching (not prefix) so an entry can never
 * accidentally open a sibling route (e.g. `/api/oauth/callback` must not also
 * match `/api/oauth/callback-evil`).
 */
export const PUBLIC_API_EXACT_PATHS: readonly string[] = [
  // External OAuth provider redirect target (top-level browser redirect).
  '/api/oauth/callback',
  // OAuth flow start / reset — reached as part of the provider round-trip.
  '/api/oauth/initiate',
  '/api/oauth/reset',
];

/**
 * Routes matched by PREFIX (a trailing-`/` bounded prefix, so only genuine
 * sub-paths match). Used for dynamic segments like `[id]`.
 */
export const PUBLIC_API_PREFIXES: readonly string[] = [
  // Inbound external webhook triggers (`/api/webhooks/[id]`). Gated by a
  // per-execution `X-Flujo-Token` and the trigger's `allowExternal` flag.
  '/api/webhooks/',
];

/** Strip a single trailing slash (but keep the root "/"). */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Whether `pathname` is an intentionally-public `/api` route that the origin
 * guard middleware must let through regardless of Host/Origin.
 */
export function isPublicApiPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  if (PUBLIC_API_EXACT_PATHS.includes(p)) return true;
  for (const prefix of PUBLIC_API_PREFIXES) {
    // `prefix` ends with '/'. Match either the exact base (prefix without the
    // trailing slash) or any bounded sub-path under it.
    if (p === prefix.slice(0, -1) || p.startsWith(prefix)) return true;
  }
  return false;
}

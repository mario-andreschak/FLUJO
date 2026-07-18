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
 * Matcher-scope note: `/mcp-proxy/*` and `/mcp-flows` are NOT under `/api/` and
 * are NOT covered by the middleware matcher, so they keep their existing inline
 * `isLocalRequest` behavior and are intentionally absent from this list.
 *
 * `/v1` split (#143): the middleware matcher now ALSO covers `/v1/:path*`. Only
 * the genuinely-public OpenAI-compatible surface (`/v1/chat/completions`,
 * `/v1/models`) is public — see `PUBLIC_OPENAI_EXACT_PATHS`/`isPublicOpenAiPath`
 * below. Everything else under `/v1` (notably the internal
 * `/v1/chat/conversations/**` control-plane) is fail-closed by the same
 * localhost / DNS-rebinding guard as `/api`.
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

/**
 * The ONLY genuinely-public OpenAI-compatible endpoints (#143). Everything else
 * under `/v1/*` — notably the internal `/v1/chat/conversations/**` control-plane
 * (list / respond-approve / PATCH / DELETE / debug / edit-state / breakpoints) —
 * is an internal control-plane and must pass the localhost origin guard.
 *
 * EXACT matching (not prefix) so `/v1/chat/conversations` can never be mistaken
 * for public and a hypothetical `/v1/models-evil` is never opened.
 */
export const PUBLIC_OPENAI_EXACT_PATHS: readonly string[] = [
  '/v1/chat/completions',
  '/v1/models',
];

/**
 * Whether `pathname` is an intentionally-public OpenAI-compatible `/v1` endpoint
 * that the origin guard middleware must let through regardless of Host/Origin.
 */
export function isPublicOpenAiPath(pathname: string): boolean {
  return PUBLIC_OPENAI_EXACT_PATHS.includes(normalizePath(pathname));
}

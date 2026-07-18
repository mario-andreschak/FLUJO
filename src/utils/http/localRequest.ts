import { NextResponse } from 'next/server';

/**
 * Localhost / DNS-rebinding origin guard for local-only `/api/*` routes (#131).
 *
 * FLUJO is a single-user, localhost-posture app. Several internal routes execute
 * shell commands, read/delete arbitrary files, or hand back secrets (`/api/git`,
 * `/api/backup`, `/api/restore`, `/api/browse`, `/api/cwd`). Combined with a
 * permissive `Access-Control-Allow-Origin`, a cross-origin *simple* POST (e.g.
 * `Content-Type: text/plain`, no CORS preflight) from any page in the user's
 * browser can reach these routes — a drive-by RCE vector.
 *
 * This guard is the same defense already used by the MCP transports and the
 * inbound webhook route (originally `isLocalRequest` in
 * `backend/services/mcp/proxyForward.ts`, moved here so command-executing routes
 * don't have to import from `backend/services/mcp`). Semantics preserved exactly:
 *   - the Host must be localhost-family (localhost / 127.0.0.1 / ::1),
 *   - a present, non-localhost Origin is rejected (the rebinding vector),
 *   - a missing Origin (native, non-browser client) is allowed.
 *
 * It reads only the Host/Origin headers, so — unlike the encryption lock gate
 * (`assertUnlocked`, which needs in-process state) — it could also run in
 * middleware; it is kept as an in-handler call for parity and testability.
 *
 * PRIMARY CONTROL (#142): `src/middleware.ts` now runs `isLocalRequest` against
 * EVERY `/api/:path*` request and returns 403 by default (fail-closed), except
 * for the explicit public allow-list in `publicApiAllowlist.ts`. So new `/api`
 * routes are guarded automatically. The highest-risk handlers (command / secret
 * sinks) additionally keep `assertLocalRequest(request)` at the top of the
 * handler as DEFENSE-IN-DEPTH — do not remove those. `assertUnlocked()` alone is
 * a no-op while the app is unlocked and does NOT stop cross-origin drive-by
 * requests.
 *
 * HOSTED POSTURE (`FLUJO_EXTRA_LOCAL_HOSTS`, #155): when FLUJO runs behind a trusted
 * reverse proxy on a private network (e.g. one tenant microVM per customer,
 * reached only by an authenticating control plane over an internal DNS name),
 * the localhost-only Host check would 403 every request the proxy forwards.
 * Deployments may opt in to additional trusted hostnames via the
 * `FLUJO_EXTRA_LOCAL_HOSTS` env var: a comma-separated list where each entry is
 * either an exact hostname (`my-host`) or, when it starts with a dot, a domain
 * suffix (`.vm.my-tenants.internal`). Entries extend what counts as "local" for
 * BOTH the Host and the Origin hostname — so the rebinding rule is preserved
 * exactly (an attacker page's Origin still never matches). Unset (the default,
 * i.e. every standalone install) this changes nothing: localhost-family only.
 * Only set it when nothing untrusted can reach FLUJO's port at those names.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Parse `FLUJO_EXTRA_LOCAL_HOSTS` (see module doc). Read per call — it is a
 *  cheap split, and lazy reads keep the guard testable and Edge-safe. */
function extraLocalHosts(): string[] {
  const raw = process.env.FLUJO_EXTRA_LOCAL_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e !== '.');
}

/** Whether `hostname` (already bare, no port) is localhost-family or matches an
 *  opted-in `FLUJO_EXTRA_LOCAL_HOSTS` entry (exact, or dot-prefixed suffix). */
function isTrustedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(h)) return true;
  return extraLocalHosts().some((entry) =>
    entry.startsWith('.') ? h.endsWith(entry) : h === entry,
  );
}

/** Extract the bare hostname from a Host header value (strips port; handles IPv6 brackets). */
function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  return h.split(':')[0] || null;
}

/**
 * Whether a request is local. Blocks the DNS-rebinding vector: a browser tricked
 * into hitting `localhost` carries the attacker's domain in Host and an attacker
 * Origin, while native clients connect to a localhost Host and send no Origin. We
 * allow only localhost-family Hosts, and reject any non-localhost Origin when
 * present.
 */
export function isLocalRequest(host: string | null, origin: string | null): boolean {
  const h = hostnameOf(host);
  if (!h || !isTrustedHostname(h)) return false;
  if (origin) {
    try {
      if (!isTrustedHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 403 for a cross-origin / DNS-rebinding attempt on a local-only route. */
export function nonLocalResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Forbidden: this endpoint only accepts local requests.' },
    { status: 403 },
  );
}

/**
 * Returns a 403 NextResponse when the request's Host/Origin fail the localhost /
 * DNS-rebinding check, or `null` when the request may proceed. Mirrors the
 * `assertUnlocked()` ergonomics (but is synchronous):
 *
 *   const notLocal = assertLocalRequest(request);
 *   if (notLocal) return notLocal;
 *
 * Reads only Host/Origin headers, so it works on both `NextRequest` and `Request`.
 */
export function assertLocalRequest(request: Request): NextResponse | null {
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    return nonLocalResponse();
  }
  return null;
}

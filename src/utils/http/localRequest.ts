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
 * MAINTAINERS: any NEW `/api/*` route that executes a command / spawns a child
 * process, reads or deletes arbitrary files, or returns secrets (decrypted env
 * vars, API keys, tokens) MUST call `assertLocalRequest(request)` at the very top
 * of the handler (local-first, before `assertUnlocked()`) — or be covered by a
 * future central `middleware.ts` allow-list. `assertUnlocked()` alone is a no-op
 * while the app is unlocked and does NOT stop cross-origin drive-by requests.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

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
  if (!h || !LOCAL_HOSTS.has(h)) return false;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
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

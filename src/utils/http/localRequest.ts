import { NextResponse } from 'next/server';
import { getExposureMode, type ExposureMode } from './exposureMode';

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
 * NETWORK EXPOSURE: Settings has one three-state control. `localhost` keeps the
 * original loopback-only posture; `network` additionally accepts private/link-
 * local addresses and this machine's startup-discovered hostnames; `public`
 * accepts any syntactically valid Host but still requires browser Origins to
 * match that Host. The matching-Origin rule keeps public mode from turning the
 * guard into a cross-site request forgery bypass.
 *
 * `FLUJO_EXTRA_LOCAL_HOSTS` remains a read-only compatibility input for old
 * hosted deployments. It is no longer part of the documented configuration.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

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

function runtimeLocalHosts(): string[] {
  const raw = process.env.FLUJO_RUNTIME_LOCAL_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

function matchesLegacyHost(hostname: string): boolean {
  return extraLocalHosts().some((entry) =>
    entry.startsWith('.') ? hostname.endsWith(entry) : hostname === entry,
  );
}

function usesLegacyHostPolicy(): boolean {
  return process.env.FLUJO_EXPOSURE_MODE_SOURCE === 'legacy'
    || (!process.env.FLUJO_EXPOSURE_MODE && extraLocalHosts().length > 0);
}

function isNetworkHostname(hostname: string): boolean {
  return isPrivateIpv4(hostname)
    || isPrivateIpv6(hostname)
    || runtimeLocalHosts().includes(hostname)
    || ['.local', '.lan', '.home', '.internal', '.localdomain'].some((suffix) =>
      hostname.endsWith(suffix),
    );
}

/** Whether a bare hostname is allowed by the active exposure mode. */
function isTrustedHostname(hostname: string, mode: ExposureMode): boolean {
  const h = normalizeHostname(hostname);
  if (LOCAL_HOSTS.has(h)) return true;
  if (mode === 'public') return /^[a-z0-9._-]+$/i.test(h) || h.includes(':');
  if (mode === 'network') {
    return usesLegacyHostPolicy() ? matchesLegacyHost(h) : isNetworkHostname(h);
  }
  // Preserve old hosted installs until they save the new setting.
  return usesLegacyHostPolicy() && matchesLegacyHost(h);
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
  const mode = getExposureMode();
  const h = hostnameOf(host);
  if (!h || !isTrustedHostname(h, mode)) return false;
  if (origin) {
    try {
      const originHostname = normalizeHostname(new URL(origin).hostname);
      if (!isTrustedHostname(originHostname, mode)) return false;
      // Public mode trusts arbitrary hostnames for native clients, so browser
      // requests must remain same-host (ports may differ for local tooling).
      if (
        (mode === 'public' || (mode === 'network' && !usesLegacyHostPolicy()))
        && originHostname !== normalizeHostname(h)
        && !(LOCAL_HOSTS.has(originHostname) && LOCAL_HOSTS.has(normalizeHostname(h)))
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Host-only half of the exposure policy for intentionally public routes. */
export function isRequestHostAllowed(host: string | null): boolean {
  const hostname = hostnameOf(host);
  return Boolean(hostname && isTrustedHostname(hostname, getExposureMode()));
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

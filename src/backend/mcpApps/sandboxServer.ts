/**
 * MCP Apps (#97) — Phase 2 sandbox proxy origin.
 *
 * The MCP Apps spec (2026-01-26) requires a sandbox proxy on a different origin
 * from FLUJO. That proxy creates the real (inner) app iframe and relays
 * postMessage between FLUJO (parent) and the app (inner). The inner View is
 * additionally assigned an opaque origin so apps cannot share the proxy
 * origin's cookies or persistent storage with one another.
 *
 * This module runs that foreign origin as a dedicated HTTP listener on its own
 * port (4201 by default). It serves exactly one document — `sandbox.html`
 * — with a host-facing Content-Security-Policy set via HTTP header. The proxy
 * policy permits only its own mandatory `srcdoc` iframe and never inherits
 * app-declared network/frame domains. The resource's `_meta.ui.csp`, passed in
 * via the `?csp=` query param by the host, is instead sanitized and prepended
 * to that inner `srcdoc` as its first byte. Access also requires an unguessable,
 * per-process query token obtained through FLUJO's authenticated API.
 *
 * The proxy script is inlined (dependency-free vanilla JS) so this needs no
 * bundler step and stays in lockstep with the constants below.
 *
 * Security posture: the listener binds loopback by default and serves only the
 * sandbox document; every other path 404s. If it cannot start, MCP Apps simply
 * don't render — FLUJO itself is unaffected.
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger } from '@/utils/logger';
import { getExposureMode } from '@/utils/http/exposureMode';

const log = createLogger('backend/mcpApps/sandboxServer');

/** JSON-RPC method names shared with the host bridge (see mcpApps.ts). */
const SANDBOX_PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const SANDBOX_RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
const SANDBOX_NOTIFICATION_PREFIX = 'ui/notifications/sandbox-';

/** Default port for the sandbox origin. Override with FLUJO_MCP_APP_SANDBOX_PORT. */
export const DEFAULT_SANDBOX_PORT = 4201;
export const SANDBOX_AUTH_QUERY_PARAM = 'token';
export const SANDBOX_PUBLIC_URL_ENV = 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL';
export const SANDBOX_HOST_ORIGINS_ENV = 'FLUJO_MCP_APP_HOST_ORIGINS';

const MAX_CONFIGURED_HOST_ORIGINS = 16;

function shouldUseLegacySandboxConfiguration(): boolean {
  const source = process.env.FLUJO_EXPOSURE_MODE_SOURCE;
  return !source
    || source === 'legacy'
    || (source === 'settings' && getExposureMode() === 'public');
}

type SandboxServerStatus = 'idle' | 'starting' | 'listening' | 'failed';

interface SandboxRuntimeState {
  authToken: string;
  status: SandboxServerStatus;
  port?: number;
  server?: http.Server;
}

/**
 * Next may evaluate instrumentation and route-handler bundles separately in the
 * same process. Symbol.for keeps their token/readiness state shared rather than
 * accidentally minting different credentials in each bundle.
 */
const SANDBOX_RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v1');
const globalRegistry = globalThis as typeof globalThis & { [key: symbol]: unknown };
let sandboxRuntime = globalRegistry[SANDBOX_RUNTIME_STATE_KEY] as SandboxRuntimeState | undefined;
if (!sandboxRuntime) {
  sandboxRuntime = {
    authToken: randomBytes(32).toString('base64url'),
    status: 'idle',
  };
  globalRegistry[SANDBOX_RUNTIME_STATE_KEY] = sandboxRuntime;
}

/** Token required in the sandbox document URL. Never expose it outside an authenticated route. */
export function getSandboxAuthToken(): string {
  return sandboxRuntime!.authToken;
}

/** Constant-time comparison helper used by the listener and available to route-level tests. */
export function isSandboxAuthTokenValid(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const supplied = Buffer.from(candidate, 'utf8');
  const expected = Buffer.from(getSandboxAuthToken(), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Lets the API fail closed instead of directing a View at an untrusted port owner. */
export function isSandboxServerReady(): boolean {
  return sandboxRuntime!.status === 'listening';
}

/** Primarily useful for diagnostics and tests; callers should gate on readiness. */
export function getSandboxServerStatus(): SandboxServerStatus {
  return sandboxRuntime!.status;
}

export function getSandboxPort(): number {
  if (sandboxRuntime!.status === 'listening' && sandboxRuntime!.port) {
    return sandboxRuntime!.port;
  }
  const raw = process.env.FLUJO_MCP_APP_SANDBOX_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_SANDBOX_PORT;
}

/** The sandbox follows the same single exposure mode as the main server. */
function getSandboxBindHost(): string {
  // A container must listen on its bridge interface even when Docker publishes
  // that port to host loopback only (the docker-compose secure default).
  if (process.env.FLUJO_CONTAINER) return '0.0.0.0';
  return getExposureMode() === 'localhost' ? '127.0.0.1' : '0.0.0.0';
}

function parseHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Exact host origins permitted to embed a separately-hosted sandbox proxy.
 * When this env var is present but malformed, the allowlist is intentionally
 * empty (fail closed); same-host fallback applies only when it is omitted.
 */
export function getConfiguredSandboxHostOrigins(): string[] {
  if (!shouldUseLegacySandboxConfiguration()) return [];
  const raw = process.env[SANDBOX_HOST_ORIGINS_ENV];
  if (!raw?.trim()) return [];

  const origins: string[] = [];
  const seen = new Set<string>();
  for (const value of raw.split(',')) {
    const origin = parseHttpOrigin(value.trim());
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
    if (origins.length >= MAX_CONFIGURED_HOST_ORIGINS) break;
  }
  return origins;
}

function hasConfiguredSandboxHostOrigins(): boolean {
  return shouldUseLegacySandboxConfiguration()
    && Boolean(process.env[SANDBOX_HOST_ORIGINS_ENV]?.trim());
}

/**
 * Optional browser-visible sandbox URL. Hosted HTTPS deployments terminate
 * TLS for this distinct origin and proxy it to the plain HTTP listener.
 */
export function getSandboxPublicUrl(): string | undefined {
  if (!shouldUseLegacySandboxConfiguration()) return undefined;
  const raw = process.env[SANDBOX_PUBLIC_URL_ENV]?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/sandbox.html';
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function hasSandboxPublicUrlConfiguration(): boolean {
  return shouldUseLegacySandboxConfiguration()
    && Boolean(process.env[SANDBOX_PUBLIC_URL_ENV]?.trim());
}

/**
 * Public/network HTTPS installs use the same hostname and the sandbox port as
 * a distinct browser origin. A reverse proxy only needs to terminate TLS on
 * that port; no second hostname or origin allowlist is required.
 */
export function deriveSandboxPublicUrl(
  hostOrigin: string,
  port = getSandboxPort(),
): string | undefined {
  if (getExposureMode() === 'localhost') return undefined;
  try {
    const parsed = new URL(hostOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    parsed.pathname = '/sandbox.html';
    parsed.search = '';
    parsed.hash = '';
    parsed.port = String(port);
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * The CSP-source shape a resource may declare under `_meta.ui.csp`. Mirrors the
 * spec's McpUiResourceCsp; each list widens exactly one directive.
 */
interface ResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

type CspScheme = 'https' | 'wss';

/** Keep a malformed/hostile resource from producing an oversized CSP header. */
const MAX_CSP_SOURCES_PER_DIRECTIVE = 64;
const MAX_CSP_SOURCE_LENGTH = 2048;

/**
 * Validate one server-declared CSP origin.
 *
 * The metadata fields contain origins, not arbitrary CSP source expressions.
 * Accepting CSP's full source grammar here would also accept keywords, schemes,
 * paths and separators that can silently widen a policy. We intentionally
 * support only secure origins from the stable spec examples:
 * `https://host[:port]`, `https://*.host[:port]`, and (for connect-src only)
 * `wss://...`.
 */
function isValidCspOrigin(source: unknown, allowedSchemes: readonly CspScheme[]): source is string {
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    source.length > MAX_CSP_SOURCE_LENGTH ||
    /[^\x21-\x7e]/.test(source)
  ) {
    return false;
  }

  const match = /^(https|wss):\/\/(\*\.)?([^/:?#]+)(?::(\d{1,5}))?$/i.exec(source);
  if (!match || !allowedSchemes.includes(match[1].toLowerCase() as CspScheme)) return false;

  const hostname = match[3];
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )
  ) {
    return false;
  }

  const port = match[4] ? Number(match[4]) : undefined;
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

/**
 * Drop invalid entries rather than attempting to repair them. De-duplicating
 * also keeps the response header bounded and deterministic.
 */
function sanitizeCspDomains(
  domains: unknown,
  allowedSchemes: readonly CspScheme[]
): string[] {
  if (!Array.isArray(domains)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const source of domains) {
    if (!isValidCspOrigin(source, allowedSchemes)) continue;
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(source);
    if (clean.length >= MAX_CSP_SOURCES_PER_DIRECTIVE) break;
  }
  return clean;
}

function sanitizeFrameAncestor(origin?: string): string {
  if (!origin) return "'none'";
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return "'none'";
    return parsed.origin;
  } catch {
    return "'none'";
  }
}

/**
 * Build the CSP enforced inside the opaque-origin app View from the resource's
 * declared `_meta.ui.csp`. This follows the stable 2026-01-26 restrictive default:
 * scripts/styles may be inline, images/media may use data URLs, and everything
 * else is denied unless its mapped metadata field explicitly declares an
 * origin.
 *
 * A `srcdoc` document has no HTTP response on which to attach a header, so the
 * proxy prepends this sanitized policy as the document's first CSP meta. The
 * outer proxy's separate HTTP policy is built by `buildSandboxProxyCsp`.
 */
export function buildSandboxCsp(csp?: ResourceCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains, ['https']).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains, ['https', 'wss']).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains, ['https']).join(' ');
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains, ['https']).join(' ');

  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `img-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src${resourceDomains ? ` ${resourceDomains}` : " 'none'"}`,
    `media-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `connect-src${connectDomains ? ` ${connectDomains}` : " 'none'"}`,
    "worker-src 'none'",
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'self'",
    "form-action 'none'",
  ];
  return directives.join('; ');
}

/**
 * Build the HTTP CSP for the trusted relay document and the upper bound that
 * its about:srcdoc child inherits.
 *
 * Browsers enforce the relay response's CSP on the srcdoc View in addition to
 * the View's own meta policy. The relay therefore has to permit the same
 * sanitized sources as that inner policy; otherwise a stricter relay directive
 * (for example `img-src 'none'`) silently blocks a View's allowed data images.
 * The trusted relay contains no app-controlled DOM or resource references, and
 * the inner meta policy still enforces the app's exact declaration.
 */
export function buildSandboxProxyCsp(
  frameAncestor?: string,
  csp?: ResourceCsp,
): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains, ['https']).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains, ['https', 'wss']).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains, ['https']).join(' ');
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains, ['https']).join(' ');

  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `img-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src${resourceDomains ? ` ${resourceDomains}` : " 'none'"}`,
    `media-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `connect-src${connectDomains ? ` ${connectDomains}` : " 'none'"}`,
    "worker-src 'none'",
    `frame-src 'self'${frameDomains ? ` ${frameDomains}` : ''}`,
    "object-src 'none'",
    `base-uri 'self'${baseUriDomains ? ` ${baseUriDomains}` : ''}`,
    "form-action 'none'",
    `frame-ancestors ${sanitizeFrameAncestor(frameAncestor)}`,
  ].join('; ');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildInnerCspMeta(csp?: ResourceCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
    buildSandboxCsp(csp)
  )}">`;
}

/**
 * The sandbox proxy document. The inlined script is dependency-free vanilla JS:
 * it validates that it is embedded (in an iframe) by a same-hostname or
 * loopback origin, self-tests that it cannot reach `window.top` (proving the
 * sandbox is real), creates the inner app iframe, and relays postMessage in
 * both directions with strict origin checks. `sandbox-resource-ready` is
 * intercepted to load the app HTML via `srcdoc` into an opaque-origin iframe.
 */
export function buildSandboxProxyHtml(
  configuredHostOrigins = getConfiguredSandboxHostOrigins(),
  hostAllowlistConfigured = hasConfiguredSandboxHostOrigins(),
  csp?: ResourceCsp
): string {
  const innerCspMeta = buildInnerCspMeta(csp);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<title>FLUJO MCP App Sandbox</title>
<style>
  html, body { margin: 0; height: 100vh; width: 100vw; background: transparent; }
  body { display: flex; flex-direction: column; }
  * { box-sizing: border-box; }
  iframe { background: transparent; border: 0 none transparent; padding: 0; overflow: hidden; flex-grow: 1; color-scheme: inherit; }
</style>
</head>
<body>
<script>
(function () {
  var RESOURCE_READY = ${JSON.stringify(SANDBOX_RESOURCE_READY)};
  var PROXY_READY = ${JSON.stringify(SANDBOX_PROXY_READY)};
  var SANDBOX_PREFIX = ${JSON.stringify(SANDBOX_NOTIFICATION_PREFIX)};
  var CONFIGURED_HOST_ORIGINS = ${JSON.stringify(configuredHostOrigins)};
  var HOST_ALLOWLIST_CONFIGURED = ${JSON.stringify(hostAllowlistConfigured)};
  var INNER_CSP_META = ${JSON.stringify(innerCspMeta)};

  if (window.self === window.top) { throw new Error("Sandbox proxy must be embedded in an iframe."); }
  if (!document.referrer) { throw new Error("Sandbox proxy: no referrer to validate embedder."); }

  // The one-time access token and CSP declaration do not belong in untrusted
  // View-visible referrer state. The HTTP policy is already committed, so strip
  // the query before creating/loading the inner iframe.
  try { window.history.replaceState(null, "", window.location.pathname); } catch (e) {}

  var referrerOrigin;
  try { referrerOrigin = new URL(document.referrer).origin; }
  catch (e) { throw new Error("Sandbox proxy: unparseable referrer."); }

  // By default the embedder must be loopback or share this sandbox's hostname.
  // A hosted subdomain deployment instead supplies an exact host-origin
  // allowlist; its mere presence disables the broader same-host fallback.
  var refHost = new URL(document.referrer).hostname;
  var ownHost = window.location.hostname;
  var loopback = /^(localhost|127\\.0\\.0\\.1|\\[::1\\]|::1)$/;
  var allowedByConfig = CONFIGURED_HOST_ORIGINS.indexOf(referrerOrigin) !== -1;
  var allowedByDefault = !HOST_ALLOWLIST_CONFIGURED && (loopback.test(refHost) || refHost === ownHost);
  if (!(allowedByConfig || allowedByDefault)) {
    throw new Error("Sandbox proxy: embedder origin not allowed: " + referrerOrigin);
  }
  var EXPECTED_HOST_ORIGIN = referrerOrigin;

  // Self-test: reaching window.top MUST throw a SecurityError. If it does not,
  // isolation is broken and we refuse to run.
  try { window.top.alert(""); throw "FAIL"; }
  catch (e) { if (e === "FAIL") { throw new Error("Sandbox proxy: isolation self-test failed."); } }

  function buildAllowAttribute(p) {
    if (!p) return "";
    var out = [];
    if (p.camera) out.push("camera");
    if (p.microphone) out.push("microphone");
    if (p.geolocation) out.push("geolocation");
    if (p.clipboardWrite) out.push("clipboard-write");
    return out.join("; ");
  }

  function isSandboxControlMessage(data) {
    return !!data && typeof data.method === "string" && data.method.indexOf(SANDBOX_PREFIX) === 0;
  }

  // Keep the untrusted View on an opaque origin: it cannot read cookies or
  // persistent storage belonging to another View on this shared proxy origin.
  // A trusted host may further restrict scripts via the optional override, but
  // it cannot add same-origin, forms, navigation, popup or download privileges.
  function sanitizeSandbox(value) {
    if (typeof value !== "string") { return "allow-scripts"; }
    return value.split(/\\s+/).indexOf("allow-scripts") === -1 ? "" : "allow-scripts";
  }

  var inner = document.createElement("iframe");
  inner.style.cssText = "width:100%;height:100%;border:none;";
  inner.setAttribute("referrerpolicy", "no-referrer");
  inner.setAttribute("sandbox", sanitizeSandbox());
  document.body.appendChild(inner);

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) { return; }
      var data = event.data;
      if (data && data.method === RESOURCE_READY) {
        var params = data.params || {};
        if (typeof params.sandbox === "string") {
          inner.setAttribute("sandbox", sanitizeSandbox(params.sandbox));
        }
        var allow = buildAllowAttribute(params.permissions);
        if (allow) { inner.setAttribute("allow", allow); }
        if (typeof params.html === "string") {
          // The sanitized policy must precede every untrusted app-controlled
          // byte so markup in the View cannot race or invalidate enforcement.
          inner.srcdoc = INNER_CSP_META + params.html;
        }
      } else if (!isSandboxControlMessage(data) && inner.contentWindow) {
        inner.contentWindow.postMessage(data, "*");
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== "null") { return; }
      if (isSandboxControlMessage(event.data)) { return; }
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    }
  });

  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, EXPECTED_HOST_ORIGIN);
})();
</script>
</body>
</html>`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Pin frame-ancestors to the exact embedding origin after applying the same
 * hostname/loopback rule as the in-page relay. A missing or invalid referrer
 * becomes frame-ancestors 'none'; the proxy script would reject it anyway.
 */
function getAllowedFrameAncestor(req: http.IncomingMessage): string | undefined {
  const referrer = req.headers.referer;
  const requestHost = req.headers.host;
  if (!referrer || !requestHost) return undefined;
  try {
    const referrerUrl = new URL(referrer);
    const requestUrl = new URL(`http://${requestHost}`);
    if (referrerUrl.protocol !== 'http:' && referrerUrl.protocol !== 'https:') return undefined;
    const configuredOrigins = getConfiguredSandboxHostOrigins();
    if (hasConfiguredSandboxHostOrigins()) {
      return configuredOrigins.includes(referrerUrl.origin)
        ? referrerUrl.origin
        : undefined;
    }
    if (
      !isLoopbackHostname(referrerUrl.hostname) &&
      referrerUrl.hostname.toLowerCase() !== requestUrl.hostname.toLowerCase()
    ) {
      return undefined;
    }
    return referrerUrl.origin;
  } catch {
    return undefined;
  }
}

function hasValidSandboxAuthToken(url: URL): boolean {
  const suppliedValues = url.searchParams.getAll(SANDBOX_AUTH_QUERY_PARAM);
  return suppliedValues.length === 1 && isSandboxAuthTokenValid(suppliedValues[0]);
}

/**
 * Start the sandbox proxy listener (idempotent). Fire-and-forget from
 * instrumentation; never throws — a bind failure is logged and MCP Apps just
 * won't render.
 */
export function startSandboxServer(): void {
  if (sandboxRuntime!.status !== 'idle') return;
  sandboxRuntime!.status = 'starting';
  const port = getSandboxPort();
  const host = getSandboxBindHost();
  sandboxRuntime!.port = port;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/sandbox.html')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    if (!hasValidSandboxAuthToken(url)) {
      res.statusCode = 403;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end('Forbidden');
      return;
    }

    let csp: ResourceCsp | undefined;
    const cspParam = url.searchParams.get('csp');
    if (cspParam) {
      try { csp = JSON.parse(cspParam); } catch { /* fall back to default-deny */ }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      buildSandboxProxyCsp(getAllowedFrameAncestor(req), csp),
    );
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(
      buildSandboxProxyHtml(
        getConfiguredSandboxHostOrigins(),
        hasConfiguredSandboxHostOrigins(),
        csp
      )
    );
  });
  sandboxRuntime!.server = server;

  server.on('error', (err: NodeJS.ErrnoException) => {
    sandboxRuntime!.status = 'failed';
    sandboxRuntime!.server = undefined;
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Sandbox proxy port ${port} is already in use; MCP Apps are disabled rather than trusting the process on that port.`
      );
    } else {
      log.error('Sandbox proxy server error', err);
    }
  });

  server.listen(port, host, () => {
    sandboxRuntime!.status = 'listening';
    log.info(`MCP Apps sandbox proxy listening on http://${host}:${port}`);
  });
}

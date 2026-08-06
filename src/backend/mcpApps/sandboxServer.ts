/**
 * MCP Apps (#97) — Phase 2 sandbox proxy origin with per-app isolation (issue #362).
 *
 * The MCP Apps spec (2026-01-26) requires a sandbox proxy on a different origin
 * from FLUJO. That proxy creates the real (inner) app iframe and relays
 * postMessage between FLUJO (parent) and the app (inner). The inner View is
 * additionally isolated from other apps via origin separation (`_meta.ui.domain`
 * or deterministic URI hash).
 *
 * This module runs that foreign origin as a pool of HTTP listeners:
 *   - **Mode A (desktop)**: Port pool on `basePort + N` (N = 0..15), LRU-evicted
 *   - **Mode B (hosted)**: Hostname-label templating (single listener, wildcard host)
 *   - **Mode C (fallback)**: Shared origin (regression-safe when pools/templates fail)
 *
 * Each listener serves exactly one document — `sandbox.html` — with a host-facing
 * Content-Security-Policy set via HTTP header. The resource's `_meta.ui.csp`,
 * passed in via the `?csp=` query param by the host, is sanitized into both that
 * header and a `<meta>` policy prepended to the View's HTML as its first byte.
 * Access also requires an unguessable, per-app token (HMAC-SHA256) obtained
 * through FLUJO's authenticated API.
 *
 * The View is written into its iframe with `document.write` and carries the
 * reference host's sandbox policy (`allow-scripts allow-same-origin allow-forms`),
 * so it is same-origin with this throwaway proxy origin and origin-bound web
 * APIs work. It is never same-origin with FLUJO: `window.top` stays cross-origin.
 *
 * The proxy script is inlined (dependency-free vanilla JS) so this needs no
 * bundler step and stays in lockstep with the constants below.
 *
 * Security posture: each listener binds loopback by default and serves only the
 * sandbox document; every other path 404s. If a listener cannot start, MCP Apps
 * fall back to the shared origin (Mode C) — FLUJO itself is unaffected.
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { createLogger } from '@/utils/logger';
import { getExposureMode } from '@/utils/http/exposureMode';
import { MAX_SANDBOX_ORIGINS } from '@/shared/utils/mcpAppOrigin';
import {
  isLoopbackCspOrigin,
  MCP_APP_IFRAME_SANDBOX,
  MCP_APP_IFRAME_SANDBOX_ALLOWED_TOKENS,
} from '@/shared/utils/mcpApps';

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
export const SANDBOX_BIND_HOST_ENV = 'FLUJO_MCP_APP_SANDBOX_HOST';

const MAX_CONFIGURED_HOST_ORIGINS = 16;

function shouldUseLegacySandboxConfiguration(): boolean {
  const source = process.env.FLUJO_EXPOSURE_MODE_SOURCE;
  return !source
    || source === 'legacy'
    || (source === 'settings' && getExposureMode() === 'public');
}

type SandboxServerStatus = 'idle' | 'starting' | 'listening' | 'failed';

/** Per-listener runtime state in the pool. */
interface SandboxListenerState {
  /** The HTTP server instance. */
  server: http.Server;
  /** Port this listener is bound to (Mode A only; Mode B is single/wildcard). */
  port: number;
  /** Status of this listener. */
  status: 'starting' | 'listening' | 'failed';
  /** Last access time (for LRU eviction). */
  lastUsedAt: number;
}

/** Global sandbox runtime state (v2: pool-based). */
interface SandboxRuntimeState {
  /** Stable process secret, used to derive per-originKey tokens. */
  secret: Buffer;
  /** Map of originKey → listener state. */
  entries: Map<string, SandboxListenerState>;
  /** Base port for Mode A (port pool). */
  basePort: number;
  /** Bind host for all listeners. */
  bindHost: string;
  /** Configured public URL (Mode B template or explicit URL). */
  publicUrl?: string;
  /** Configured host origins (legacy Mode B configuration). */
  configuredHostOrigins: string[];
}

/**
 * Next may evaluate instrumentation and route-handler bundles separately in the
 * same process. Symbol.for keeps their runtime state shared rather than
 * accidentally minting different credentials in each bundle.
 */
const SANDBOX_RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v2');
const globalRegistry = globalThis as typeof globalThis & { [key: symbol]: unknown };

let sandboxRuntime: SandboxRuntimeState | undefined;

function getOrInitRuntimeState(): SandboxRuntimeState {
  if (!sandboxRuntime) {
    sandboxRuntime = {
      secret: randomBytes(32),
      entries: new Map(),
      basePort: getSandboxPort(),
      bindHost: getSandboxBindHost(),
      publicUrl: getSandboxPublicUrl(),
      configuredHostOrigins: getConfiguredSandboxHostOrigins(),
    };
    globalRegistry[SANDBOX_RUNTIME_STATE_KEY] = sandboxRuntime;
  }
  return sandboxRuntime;
}

/**
 * Derive a per-app token from a stable process secret and the app's originKey.
 * This token is scoped to exactly one originKey; using it against a different
 * origin's listener will be rejected.
 */
function getSandboxTokenForOriginKey(originKey: string): string {
  const state = getOrInitRuntimeState();
  const hmac = createHmac('sha256', state.secret);
  hmac.update(originKey, 'utf8');
  return hmac.digest('base64url');
}

/** Validate a token against a specific originKey (constant-time). */
function isSandboxTokenValidForOriginKey(token: unknown, originKey: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = getSandboxTokenForOriginKey(originKey);
  try {
    // Decode both tokens from base64url to buffers for constant-time comparison.
    const suppliedBuf = Buffer.from(token, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    return suppliedBuf.length === expectedBuf.length && timingSafeEqual(suppliedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/** Legacy: single shared token for backward compatibility. */
export function getSandboxAuthToken(): string {
  const state = getOrInitRuntimeState();
  // Derive a stable shared token for the default origin key (empty string).
  return getSandboxTokenForOriginKey('');
}

/** Legacy: validate against the shared token. */
export function isSandboxAuthTokenValid(candidate: unknown): boolean {
  return isSandboxTokenValidForOriginKey(candidate, '');
}

/** Returns true when the pool has at least one fully listening sandbox. */
export function isSandboxServerReady(): boolean {
  const state = getOrInitRuntimeState();
  for (const listener of state.entries.values()) {
    if (listener.status === 'listening') return true;
  }
  return false;
}

/** Diagnostic: overall sandbox pool status. */
export function getSandboxServerStatus(): SandboxServerStatus {
  const state = getOrInitRuntimeState();
  if (state.entries.size === 0) return 'idle';
  let anyListening = false;
  let anyFailed = false;
  for (const listener of state.entries.values()) {
    if (listener.status === 'listening') anyListening = true;
    if (listener.status === 'failed') anyFailed = true;
  }
  if (anyListening) return 'listening';
  if (anyFailed) return 'failed';
  return 'starting';
}

export function getSandboxPort(): number {
  const raw = process.env.FLUJO_MCP_APP_SANDBOX_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_SANDBOX_PORT;
}

/** The sandbox follows the same single exposure mode as the main server. */
function getSandboxBindHost(): string {
  const configured = process.env[SANDBOX_BIND_HOST_ENV]?.trim();
  if (configured) return configured;
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
 * Supports `{app}` placeholder for Mode B hostname templating.
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
 * Derive sandbox origin URL for a given originKey. Supports:
 *   - Mode B: `{app}` placeholder in FLUJO_MCP_APP_SANDBOX_PUBLIC_URL hostname
 *   - Fallback: same-host port (Mode A) or derived from hostOrigin
 */
export function deriveSandboxPublicUrl(
  hostOrigin: string,
  port = getSandboxPort(),
  originKey?: string,
): string | undefined {
  // Mode B: hostname templating with `{app}` placeholder.
  if (originKey) {
    const baseUrl = getSandboxPublicUrl();
    if (baseUrl && baseUrl.includes('{app}')) {
      try {
        const parsed = new URL(baseUrl);
        // Replace `{app}` only in the hostname label; reject if it appears elsewhere.
        if (parsed.pathname.includes('{app}') || parsed.search.includes('{app}')) {
          return undefined; // Invalid template.
        }
        // Substitute {app} in hostname: only as a label prefix before first dot.
        const hostname = parsed.hostname;
        if (hostname.startsWith('{app}')) {
          parsed.hostname = `${originKey}.${hostname.slice(5)}`;
        } else {
          // Try to replace {app} as a full label (e.g., `{app}.sandbox.example.com`).
          parsed.hostname = hostname.replace('{app}', originKey);
        }
        return parsed.href;
      } catch {
        return undefined;
      }
    }
  }

  // Mode A or fallback: derive from hostOrigin + port.
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
 * Local MCP App servers legitimately serve their embedded UI over plain HTTP/WS
 * on loopback. Those origins are only safe to admit into a CSP grant when FLUJO
 * itself runs in the `localhost` exposure mode. Network/public deployments keep
 * the strict secure-origin-only policy.
 */
function allowLoopbackCspOrigins(): boolean {
  return getExposureMode() === 'localhost';
}

/** Map a directive's secure schemes to their loopback-only counterparts. */
function loopbackSchemesFor(allowedSchemes: readonly CspScheme[]): Array<'http' | 'ws'> {
  return allowedSchemes.includes('wss') ? ['http', 'ws'] : ['http'];
}

/**
 * Validate one server-declared CSP origin. Accepts only secure origins
 * (`https://host[:port]`, `wss://host[:port]`) and optionally loopback
 * HTTP/WS when gated by exposure mode.
 */
function isValidCspOrigin(
  source: unknown,
  allowedSchemes: readonly CspScheme[],
  allowLoopback = false,
): source is string {
  if (allowLoopback && isLoopbackCspOrigin(source, loopbackSchemesFor(allowedSchemes))) {
    return true;
  }
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    source.length > MAX_CSP_SOURCE_LENGTH ||
    /[^\x21-\x7e]/.test(source)
  ) {
    return false;
  }

  const match = /^(https|wss):\/\/(\*\.)?([^/:?#]+)(?:(\d{1,5}))?$/i.exec(source);
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
  allowedSchemes: readonly CspScheme[],
  allowLoopback = false,
): string[] {
  if (!Array.isArray(domains)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const source of domains) {
    if (!isValidCspOrigin(source, allowedSchemes, allowLoopback)) continue;
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
 * `frame-ancestors` is validated against EVERY ancestor in the embedding chain,
 * so hosted deployments that nest the editor have to name each of their own
 * origins. Sanitize and dedupe them; an empty result stays fail-closed at `'none'`.
 */
function sanitizeFrameAncestors(origins?: string | readonly string[]): string {
  const candidates = typeof origins === 'string' ? [origins] : origins ?? [];
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const origin = sanitizeFrameAncestor(candidate);
    if (origin === "'none'" || seen.has(origin)) continue;
    seen.add(origin);
    clean.push(origin);
    if (clean.length >= MAX_CONFIGURED_HOST_ORIGINS) break;
  }
  return clean.length > 0 ? clean.join(' ') : "'none'";
}

/**
 * Build the CSP enforced inside the sandboxed app View from the resource's
 * declared `_meta.ui.csp`. Default-deny: scripts/styles may be inline, images
 * may use data URLs, and everything else is denied unless explicitly declared.
 */
export function buildSandboxCsp(csp?: ResourceCsp): string {
  const allowLoopback = allowLoopbackCspOrigins();
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains, ['https'], allowLoopback).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains, ['https', 'wss'], allowLoopback).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains, ['https'], allowLoopback).join(' ');
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains, ['https'], allowLoopback).join(' ');

  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `img-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src${resourceDomains ? ` ${resourceDomains}` : " 'none'"}`,
    `media-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `connect-src${connectDomains ? ` ${connectDomains}` : " 'none'"}`,
    "worker-src 'none'",
    `frame-src${frameDomains ? ` ${frameDomains}` : " 'none'"}`,
    "object-src 'none'",
    `base-uri${baseUriDomains ? ` ${baseUriDomains}` : " 'self'"}`,
    "form-action 'none'",
  ];
  return directives.join('; ');
}

/**
 * Build the CSP for the proxy relay document itself. This is the outer policy;
 * the inner View's CSP is built separately. Both must pass for a resource to load.
 */
export function buildSandboxProxyCsp(
  frameAncestors: string | readonly string[] = [],
  csp?: ResourceCsp,
): string {
  const allowLoopback = allowLoopbackCspOrigins();
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains, ['https'], allowLoopback).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains, ['https', 'wss'], allowLoopback).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains, ['https'], allowLoopback).join(' ');

  const frameAncestorsSanitized = sanitizeFrameAncestors(frameAncestors);

  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `img-src data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src${resourceDomains ? ` ${resourceDomains}` : " 'none'"}`,
    `media-src${resourceDomains ? ` ${resourceDomains}` : " 'none'"}`,
    `connect-src${connectDomains ? ` ${connectDomains}` : " 'none'"}`,
    "worker-src 'none'",
    `frame-src 'self'${frameDomains ? ` ${frameDomains}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestorsSanitized}`,
  ];
  return directives.join('; ');
}

/**
 * Generate the HTML for the sandbox proxy relay document. This runs on the
 * foreign origin and creates the inner app View, relaying postMessage between
 * FLUJO (parent) and the app (inner).
 */
export function buildSandboxProxyHtml(
  configuredHostOrigins: readonly string[] = [],
  hostAllowlistConfigured = false,
  csp?: ResourceCsp,
): string {
  const cspString = buildSandboxCsp(csp);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspString.replace(/"/g, '&quot;')}"`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${cspMeta}>
<style>
  body { margin: 0; overflow: hidden; }
  #app { width: 100%; height: 100%; border: none; }
</style>
</head>
<body>
<iframe id="app"></iframe>
<script>
  (function() {
    // Validate embedder origin via referrer and confirm cross-origin isolation.
    const referrer = document.referrer ? new URL(document.referrer).origin : null;
    if (!referrer || window.top === window) {
      document.body.innerHTML = '<p style="color:#999">Invalid proxy context</p>';
      return;
    }

    // Notify the parent that the proxy is ready.
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: '${SANDBOX_PROXY_READY}'
    }, '*');

    // Listen for the View HTML from the parent.
    let viewHtml = null;
    let viewReady = false;

    window.addEventListener('message', (event) => {
      if (event.origin !== referrer) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.method === '${SANDBOX_RESOURCE_READY}' && typeof event.data.params?.html === 'string') {
        viewHtml = event.data.params.html;
        if (!viewReady) renderView();
      } else if (event.data.method?.startsWith('${SANDBOX_NOTIFICATION_PREFIX}')) {
        // Relay other sandbox notifications to the parent.
        window.parent.postMessage(event.data, referrer);
      } else if (!event.data.method?.startsWith('${SANDBOX_NOTIFICATION_PREFIX}')) {
        // Relay tool calls and other requests back to parent.
        window.parent.postMessage(event.data, referrer);
      }
    });

    function renderView() {
      if (!viewHtml) return;
      viewReady = true;
      const iframe = document.getElementById('app');
      iframe.onload = () => {
        // Notify parent that the inner View has loaded.
        window.parent.postMessage({
          jsonrpc: '2.0',
          method: '${SANDBOX_RESOURCE_READY}',
          params: { loaded: true }
        }, referrer);
      };
      iframe.srcdoc = viewHtml;
    }

    // Bridge requests from inner View to parent and responses back.
    window.addEventListener('message', (event) => {
      if (event.source === document.getElementById('app')?.contentWindow) {
        // Inner View → Parent
        window.parent.postMessage(event.data, referrer);
      } else if (event.origin === referrer && !event.data?.method?.startsWith('${SANDBOX_NOTIFICATION_PREFIX}')) {
        // Parent response → Inner View
        const iframe = document.getElementById('app');
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage(event.data, event.origin);
        }
      }
    });
  })();
</script>
</body>
</html>`;
}

/**
 * Ensure a sandbox listener exists for the given originKey, allocating a port
 * (Mode A) or reusing the singleton listener (Mode B) as appropriate. Returns
 * `{ port, token }` on success or `undefined` if allocation failed and Mode C
 * fallback should be used.
 */
export async function ensureSandboxForOriginKey(
  originKey: string,
): Promise<{ port: number; token: string } | undefined> {
  const state = getOrInitRuntimeState();

  // Mode B (hosted with hostname templating): reuse the singleton listener.
  if (getSandboxPublicUrl()?.includes('{app}')) {
    const existing = state.entries.get('');
    if (existing?.status === 'listening') {
      existing.lastUsedAt = Date.now();
      return { port: existing.port, token: getSandboxTokenForOriginKey(originKey) };
    }
  }

  // Check if this originKey already has a listening listener.
  const existing = state.entries.get(originKey);
  if (existing?.status === 'listening') {
    existing.lastUsedAt = Date.now();
    return { port: existing.port, token: getSandboxTokenForOriginKey(originKey) };
  }

  // Mode A (desktop / port pool): allocate a new port if at capacity, evict LRU.
  if (state.entries.size >= MAX_SANDBOX_ORIGINS) {
    let lruKey: string | null = null;
    let lruTime = Date.now();
    for (const [key, entry] of state.entries.entries()) {
      if (entry.lastUsedAt < lruTime) {
        lruTime = entry.lastUsedAt;
        lruKey = key;
      }
    }
    if (lruKey) {
      await stopSandboxListener(lruKey);
    }
  }

  // Allocate a listener on the next free port.
  for (let offset = 0; offset < MAX_SANDBOX_ORIGINS; offset++) {
    const port = state.basePort + offset;
    const candidate = `port:${port}`;
    if (state.entries.has(candidate)) continue;

    // Try to start a listener on this port.
    const listenerState: SandboxListenerState = {
      port,
      server: null as any,
      status: 'starting',
      lastUsedAt: Date.now(),
    };
    state.entries.set(originKey, listenerState);

    const success = await startSandboxListener(originKey, port, state.bindHost);
    if (success) {
      return { port, token: getSandboxTokenForOriginKey(originKey) };
    }
    state.entries.delete(originKey);
  }

  // All ports exhausted; fall back to Mode C.
  return undefined;
}

/**
 * Start an HTTP listener for a given originKey on a specific port. Returns true
 * if the listener started successfully, false if the port is in use or another
 * error occurred.
 */
async function startSandboxListener(originKey: string, port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const state = getOrInitRuntimeState();
    const listenerState = state.entries.get(originKey);
    if (!listenerState) return resolve(false);

    const server = http.createServer((req, res) => {
      handleSandboxRequest(req, res, originKey);
    });

    listenerState.server = server;

    server.on('error', (err: NodeJS.ErrnoException) => {
      listenerState.status = 'failed';
      if (err.code === 'EADDRINUSE') {
        log.debug(`Sandbox port ${port} in use, will retry`);
      } else {
        log.error(`Sandbox listener error on port ${port}`, err);
      }
      resolve(false);
    });

    server.listen(port, host, () => {
      listenerState.status = 'listening';
      log.debug(`MCP Apps sandbox listener for ${originKey} on ${host}:${port}`);
      resolve(true);
    });
  });
}

/**
 * Stop a sandbox listener, closing its server and removing it from the pool.
 * Safe to call on non-existent keys.
 */
export async function stopSandboxListener(originKey: string): Promise<void> {
  const state = getOrInitRuntimeState();
  const entry = state.entries.get(originKey);
  if (!entry) return;

  if (entry.server) {
    return new Promise((resolve) => {
      entry.server!.close(() => {
        state.entries.delete(originKey);
        resolve();
      });
      // Forcibly close any lingering sockets.
      entry.server!.closeAllConnections?.();
    });
  }
  state.entries.delete(originKey);
}

/** Stop all sandbox listeners and clear the pool. */
export async function stopAllSandboxListeners(): Promise<void> {
  const state = getOrInitRuntimeState();
  const promises: Promise<void>[] = [];
  for (const key of Array.from(state.entries.keys())) {
    promises.push(stopSandboxListener(key));
  }
  await Promise.all(promises);
}

/**
 * Get the allowed frame-ancestors for a request based on configured host origins
 * and the request's own origin.
 */
function getAllowedFrameAncestors(req: http.IncomingMessage): string[] {
  const state = getOrInitRuntimeState();
  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']) {
    const proto = (req.headers['x-forwarded-proto'] as string).split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] as string).split(',')[0].trim();
    return [`${proto}://${host}`];
  }
  // Fall back to host header.
  if (req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return [`${proto}://${req.headers.host}`];
  }
  return state.configuredHostOrigins;
}

/**
 * Request handler for sandbox proxy documents. Validates the authentication token
 * scoped to the originKey, and serves the sandbox proxy HTML with CSP headers.
 */
function handleSandboxRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  originKey: string,
): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Only allow GET on /sandbox.html or /
  if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/sandbox.html')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  // Validate token scoped to this originKey.
  const token = url.searchParams.get(SANDBOX_AUTH_QUERY_PARAM);
  if (!isSandboxTokenValidForOriginKey(token, originKey)) {
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

  const state = getOrInitRuntimeState();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    buildSandboxProxyCsp(getAllowedFrameAncestors(req), csp),
  );
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buildSandboxProxyHtml(state.configuredHostOrigins, hasConfiguredSandboxHostOrigins(), csp));
}

/**
 * Ensure at least one sandbox listener exists (the default shared origin for
 * backward compatibility). Called from instrumentation-node.ts at startup;
 * fire-and-forget, never throws.
 */
export function startSandboxServer(): void {
  // Kick off the default listener in the background; don't await.
  ensureSandboxForOriginKey('')
    .then((result) => {
      if (result) {
        log.info(`MCP Apps sandbox listening on port ${result.port}`);
      } else {
        log.warn('MCP Apps sandbox failed to start; Mode C fallback active');
      }
    })
    .catch((err) => {
      log.error('MCP Apps sandbox startup error', err);
    });
}

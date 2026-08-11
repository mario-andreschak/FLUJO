/**
 * MCP Apps (#97) — Phase 2 sandbox proxy origin with per-app isolation (issue #362).
 *
 * The MCP Apps spec (2026-01-26) requires a sandbox proxy on a different origin
 * from FLUJO. That proxy creates the real (inner) app iframe and relays
 * postMessage between FLUJO (parent) and the app (inner). The inner View is
 * additionally isolated from other apps via a host-derived SHA-256 identity
 * over the active workspace, configured server, and verified resource URI.
 *
 * This module runs that foreign origin on one HTTP listener while preserving a
 * distinct, stable browser origin for every verified app identity:
 *   - **Local**: `<originKey>.localhost:<port>` resolves to the shared loopback
 *     listener without recycling browser origins between apps.
 *   - **Hosted/network**: a configured `{app}` DNS-label template routes every
 *     app hostname to the same listener through wildcard DNS/reverse proxying.
 *
 * The listener serves exactly one document — `sandbox.html` — with a host-facing
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
 * Security posture: the listener binds loopback by default and serves only the
 * sandbox document; every other path 404s. Origin allocation fails closed when
 * the listener cannot start or a non-local deployment lacks a valid wildcard
 * hostname template. There is deliberately no shared browser-origin fallback.
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { createLogger } from '@/utils/logger';
import { getExposureMode } from '@/utils/http/exposureMode';
import { isValidMcpAppDomain } from '@/shared/utils/mcpAppOrigin';
import {
  canonicalizeLoopbackCspOrigin,
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

/**
 * Escape hatch for hosted deployments behind a reverse proxy that rewrites
 * `Host`/`Referer` headers. When the persisted `network.allowAllMcpAppContent`
 * setting is enabled (propagated here by scripts/exposure-mode.mjs as
 * `FLUJO_MCP_APP_SANDBOX_ALLOW_ALL`), the sandbox accepts any embedder/child
 * origin instead of enforcing the host-origin allowlist. This disables the
 * cross-origin isolation boundary and is intended only as a temporary escape
 * hatch; the long-term fix is correct `FLUJO_MCP_APP_HOST_ORIGINS` config.
 */
export function sandboxAllowAllContent(): boolean {
  const value = process.env.FLUJO_MCP_APP_SANDBOX_ALLOW_ALL;
  if (!value) return false;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function shouldUseSandboxEndpointConfiguration(): boolean {
  const source = process.env.FLUJO_EXPOSURE_MODE_SOURCE;
  return !source
    || source === 'legacy'
    || getExposureMode() !== 'localhost';
}

type SandboxServerStatus = 'idle' | 'starting' | 'listening' | 'failed';

/** Runtime state for the singleton sandbox listener. */
interface SandboxListenerState {
  /** The HTTP server instance. */
  server?: http.Server;
  /** Port this listener is bound to. */
  port: number;
  /** Status of this listener. */
  status: 'starting' | 'listening' | 'failed';
}

/** Global sandbox runtime state. */
interface SandboxRuntimeState {
  /** Transport architecture marker used to safely adopt state across HMR bundles. */
  architectureVersion?: 4;
  /** Stable process secret, used to derive per-originKey tokens. */
  secret: Buffer;
  /** Singleton listener stored under the internal empty-string key. */
  entries: Map<string, SandboxListenerState>;
  /** Fixed listener port. */
  basePort: number;
  /** Bind host for all listeners. */
  bindHost: string;
  /** In-flight singleton startup shared by concurrent app requests. */
  sharedListenerStart?: Promise<boolean>;
  /** Configured host origins for hosted/network deployments. */
  configuredHostOrigins: string[];
  /**
   * FLUJO origins observed on authenticated `/api/mcp/app-sandbox` requests.
   * The sandbox listener never sees the embedder in its own `Host` header, so
   * this is how a local install learns which origin is allowed to frame it.
   * Insertion-ordered and bounded; oldest entries are dropped first.
   */
  hostOrigins: string[];
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
    // Adopt the state a sibling bundle already published, otherwise the two
    // bundles mint different secrets and — since the API route registers the
    // embedder origin while the listener reads it — the sandbox would answer
    // with `frame-ancestors 'none'`.
    const shared = globalRegistry[SANDBOX_RUNTIME_STATE_KEY] as SandboxRuntimeState | undefined;
    if (shared) {
      // Tolerate state published before `hostOrigins` existed.
      shared.hostOrigins ??= [];
      sandboxRuntime = shared;

      if (shared.architectureVersion !== 4) {
        // A pre-singleton/HMR bundle may have left per-app listeners alive. Drop
        // every recycled-port entry so none of those old browser origins can be
        // issued again, and close their transports immediately.
        for (const [key, entry] of shared.entries.entries()) {
          if (key === '') continue;
          shared.entries.delete(key);
          try {
            entry.server?.close();
            entry.server?.closeAllConnections?.();
          } catch (error) {
            log.warn(`Could not close legacy MCP App sandbox listener "${key}"`, error);
          }
        }

        // The base listener can stay bound (avoiding an HMR port-release race),
        // but its old request closure may still implement shared-token fallback.
        // Replace only that application-level handler with the new fail-closed
        // Host-derived handler.
        const baseListener = shared.entries.get('');
        if (baseListener?.server) {
          baseListener.server.removeAllListeners('request');
          baseListener.server.on('request', handleSandboxRequest);
        }
        shared.architectureVersion = 4;
      }
      return sandboxRuntime;
    }
    sandboxRuntime = {
      architectureVersion: 4,
      secret: randomBytes(32),
      entries: new Map(),
      basePort: getSandboxPort(),
      bindHost: getSandboxBindHost(),
      configuredHostOrigins: getConfiguredSandboxHostOrigins(),
      hostOrigins: [],
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

/** Returns true when the singleton transport is fully listening. */
export function isSandboxServerReady(): boolean {
  const state = getOrInitRuntimeState();
  for (const listener of state.entries.values()) {
    if (listener.status === 'listening') return true;
  }
  return false;
}

/** Diagnostic: overall sandbox transport status. */
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
  if (!shouldUseSandboxEndpointConfiguration()) return [];
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
  return shouldUseSandboxEndpointConfiguration()
    && Boolean(process.env[SANDBOX_HOST_ORIGINS_ENV]?.trim());
}

/**
 * Optional browser-visible sandbox URL. Hosted HTTPS deployments terminate
 * TLS for this distinct origin and proxy it to the plain HTTP listener.
 * Supports `{app}` as a hostname label for hosted/network templating.
 */
export function getSandboxPublicUrl(): string | undefined {
  if (!shouldUseSandboxEndpointConfiguration()) return undefined;
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
  return shouldUseSandboxEndpointConfiguration()
    && Boolean(process.env[SANDBOX_PUBLIC_URL_ENV]?.trim());
}

/**
 * Origin keys are embedded as exactly one DNS label. The route derives them
 * from verified app identity; this boundary still validates its input so a
 * future caller cannot turn a key into a sibling/parent hostname.
 */
function isValidSandboxOriginKey(originKey: unknown): originKey is string {
  return isValidMcpAppDomain(originKey)
    && !originKey.includes('.')
    && originKey.length <= 63;
}

/** Parse the configured hosted URL only when `{app}` is one whole DNS label. */
function getValidSandboxAppUrlTemplate(): URL | undefined {
  const configured = getSandboxPublicUrl();
  if (!configured) return undefined;

  try {
    const parsed = new URL(configured);
    const labels = parsed.hostname.toLowerCase().split('.');
    const placeholderIndexes = labels
      .map((label, index) => label === '{app}' ? index : -1)
      .filter(index => index !== -1);

    // One occurrence, as one complete label, and nowhere else in the URL.
    if (
      placeholderIndexes.length !== 1
      || configured.split('{app}').length !== 2
      || labels.length < 2
    ) {
      return undefined;
    }

    for (const label of labels) {
      if (label === '{app}') continue;
      if (
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      ) {
        return undefined;
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Whether an optional hosted wildcard URL has been configured correctly. */
export function hasValidSandboxAppUrlTemplate(): boolean {
  return getValidSandboxAppUrlTemplate() !== undefined;
}

/**
 * Derive the browser-visible sandbox URL for a given originKey. Resolution is
 * automatic for normal installs:
 *   - Local requests use a stable `<originKey>.localhost` browser origin.
 *   - A configured `{app}` hostname template is honored for hosted HTTPS.
 *   - A configured public URL WITHOUT `{app}` serves every app from that one
 *     TLS-terminated shared origin (one DNS record, one certificate). The
 *     scoped key travels in the authenticated URL like the LAN fallback.
 *   - Plain-HTTP LAN requests reuse the already-working request hostname and
 *     sandbox port. The scoped key travels in the authenticated URL because a
 *     server cannot create DNS records for invented LAN subdomains.
 *
 * The LAN fallback shares the outer proxy origin. Untrusted App HTML remains in
 * the nested sandboxed View, while the query key keeps proxy tokens app-scoped.
 */
export function deriveSandboxPublicUrl(
  hostOrigin: string,
  port = getSandboxPort(),
  originKey?: string,
): string | undefined {
  if (!isValidSandboxOriginKey(originKey)) return undefined;

  let hostUrl: URL;
  try {
    hostUrl = new URL(hostOrigin);
    if (
      (hostUrl.protocol !== 'http:' && hostUrl.protocol !== 'https:')
      || hostUrl.username
      || hostUrl.password
    ) return undefined;
  } catch {
    return undefined;
  }

  if (
    getExposureMode() === 'localhost'
    || (hostUrl.protocol === 'http:' && isLoopbackHostname(hostUrl.hostname))
  ) {
    return `http://${originKey}.localhost:${port}/sandbox.html`;
  }

  const template = getValidSandboxAppUrlTemplate();
  if (template) {
    const labels = template.hostname.toLowerCase().split('.');
    template.hostname = labels
      .map(label => label === '{app}' ? originKey : label)
      .join('.');
    return template.href;
  }

  // Shared hosted origin: a configured public URL WITHOUT an `{app}`
  // placeholder names ONE TLS-terminated browser origin for every app, so a
  // hosted install needs a single DNS record and certificate instead of a
  // wildcard pair. The verified key travels in the authenticated URL exactly
  // like the LAN fallback below and each proxy token stays scoped to that
  // key; untrusted App HTML still renders in the nested sandboxed View on an
  // opaque origin. A URL that still CONTAINS `{app}` but failed template
  // validation is a configuration error and must keep failing closed rather
  // than silently collapsing per-app origins into a shared one.
  // Note: the URL parser percent-encodes `{app}` outside the hostname, so a
  // misplaced placeholder must be rejected in either spelling.
  const configuredShared = getSandboxPublicUrl();
  if (
    configuredShared
    && !configuredShared.includes('{app}')
    && !/%7Bapp%7D/i.test(configuredShared)
  ) {
    try {
      const sharedUrl = new URL(configuredShared);
      sharedUrl.searchParams.set('originKey', originKey);
      return sharedUrl.href;
    } catch {
      return undefined;
    }
  }

  // Browsers block an HTTP iframe inside an HTTPS page. HTTPS deployments need
  // a real TLS endpoint, but ordinary HTTP LAN use needs no DNS/proxy config.
  if (hostUrl.protocol !== 'http:') return undefined;
  hostUrl.port = String(port);
  hostUrl.pathname = '/sandbox.html';
  hostUrl.search = '';
  hostUrl.hash = '';
  hostUrl.searchParams.set('originKey', originKey);
  return hostUrl.href;
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
 * on loopback (an IDE gateway on `http://127.0.0.1:<port>` with its bridge on
 * `ws://127.0.0.1:<port>`, for example). Those origins stay safe to admit into a
 * CSP grant for as long as FLUJO is NOT published to the open internet: only in
 * the `public` mode does the browser rendering an app belong to someone else, so
 * that `http://127.0.0.1:…` would name a stranger's machine instead of the one
 * running the MCP server.
 *
 * `localhost` and `network` are both self-hosted modes — `network` differs only
 * in which hostname the operator reaches the same install by — so gating on
 * `localhost` alone silently broke every local App with a loopback gateway as
 * soon as LAN access was enabled (`frame-src`/`connect-src` collapsed to
 * `'none'`). Public deployments keep the strict secure-origin-only policy.
 */
function allowLoopbackCspOrigins(): boolean {
  return getExposureMode() !== 'public';
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
 * Resolve one declared origin to the exact source expression the policy should
 * carry, or `undefined` to drop it. Secure origins are emitted verbatim; the
 * loopback exception is collapsed to its port-wildcard form so a local App
 * server's ephemeral-port restart cannot invalidate an already-committed CSP
 * (see canonicalizeLoopbackCspOrigin).
 */
function normalizeCspOrigin(
  source: unknown,
  allowedSchemes: readonly CspScheme[],
  allowLoopback: boolean,
): string | undefined {
  if (allowLoopback) {
    const loopback = canonicalizeLoopbackCspOrigin(source, loopbackSchemesFor(allowedSchemes));
    if (loopback) return loopback;
  }
  // Loopback already handled, so this call only admits secure origins.
  return isValidCspOrigin(source, allowedSchemes, false) ? source : undefined;
}

/**
 * Drop invalid entries rather than attempting to repair them. De-duplicating
 * also keeps the response header bounded and deterministic — and, because
 * loopback origins are normalized first, several ports on the same loopback host
 * collapse into a single wildcard source.
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
    const normalized = normalizeCspOrigin(source, allowedSchemes, allowLoopback);
    if (normalized === undefined) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(normalized);
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
  // Escape hatch: a literal '*' (from sandboxAllowAllContent) means "any
  // ancestor may frame this document" and must survive sanitization verbatim.
  if (candidates.includes('*')) return '*';
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
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains, ['https'], allowLoopback).join(' ');

  const frameAncestorsSanitized = sanitizeFrameAncestors(frameAncestors);

  // The View document is written into an about:blank child that INHERITS this
  // policy, so every directive the View legitimately needs (`'self'` scripts and
  // styles on this throwaway origin, inline data: media) has to survive here as
  // well. Dropping `'self'`/`data:` from this outer policy silently breaks apps
  // even when their own inner meta policy allows them.
  const directives = [
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
    `frame-ancestors ${frameAncestorsSanitized}`,
  ];
  return directives.join('; ');
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
 * Generate the HTML for the sandbox proxy relay document. This runs on the
 * foreign origin and creates the inner app View, relaying postMessage between
 * FLUJO (parent) and the app (inner).
 *
 * Relay contract (do not "simplify" it):
 *   - Parent -> View messages are forwarded with targetOrigin `"*"`. The View is
 *     an about:blank/srcdoc document whose origin is either this proxy origin or
 *     an opaque `null` (when a host sandbox override drops allow-same-origin).
 *     Targeting the FLUJO host origin instead makes the browser DROP every
 *     message, which strands each app on its `ui/initialize` request forever.
 *   - View -> parent messages are only forwarded after the source frame and its
 *     origin are verified, and reserved `ui/notifications/sandbox-*` control
 *     messages are never relayed in either direction (a View must not be able to
 *     forge proxy control traffic, and host control frames stop here).
 */
export function buildSandboxProxyHtml(
  configuredHostOrigins: readonly string[] = getConfiguredSandboxHostOrigins(),
  hostAllowlistConfigured = hasConfiguredSandboxHostOrigins(),
  csp?: ResourceCsp,
  allowAll = false,
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
  var CONFIGURED_HOST_ORIGINS = ${JSON.stringify([...configuredHostOrigins])};
  var HOST_ALLOWLIST_CONFIGURED = ${JSON.stringify(hostAllowlistConfigured)};
  var ALLOW_ALL = ${JSON.stringify(allowAll)};
  var INNER_CSP_META = ${JSON.stringify(innerCspMeta)};
  var DEFAULT_VIEW_SANDBOX = ${JSON.stringify(MCP_APP_IFRAME_SANDBOX)};
  var ALLOWED_SANDBOX_TOKENS = ${JSON.stringify([...MCP_APP_IFRAME_SANDBOX_ALLOWED_TOKENS])};

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
  // Escape hatch: when ALLOW_ALL is set, accept any embedder origin and relay
  // to any host origin. Disables the cross-origin isolation boundary.
  if (!(ALLOW_ALL || allowedByConfig || allowedByDefault)) {
    throw new Error("Sandbox proxy: embedder origin not allowed: " + referrerOrigin);
  }
  var EXPECTED_HOST_ORIGIN = ALLOW_ALL ? "*" : referrerOrigin;
  // The View is same-origin with this proxy, so its messages carry this origin
  // rather than "null". Both are accepted so a narrowing sandbox override that
  // drops allow-same-origin cannot silently mute the View's bridge.
  var OWN_ORIGIN = window.location.origin;

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

  // The host owns the View's sandbox policy: an override may only ever narrow
  // the default to a subset of the allowlist, never add navigation, popup or
  // download privileges (those stay host-mediated via ui/open-link and
  // ui/download-file). A View that cannot run scripts cannot run the bridge
  // either, so dropping allow-scripts yields no privileges at all.
  function sanitizeSandbox(value) {
    if (typeof value !== "string") { return DEFAULT_VIEW_SANDBOX; }
    var requested = value.toLowerCase().split(/\\s+/);
    var granted = [];
    for (var i = 0; i < requested.length; i++) {
      var token = requested[i];
      if (ALLOWED_SANDBOX_TOKENS.indexOf(token) !== -1 && granted.indexOf(token) === -1) {
        granted.push(token);
      }
    }
    return granted.indexOf("allow-scripts") === -1 ? "" : granted.join(" ");
  }

  var inner = null;

  // Sandbox flags are committed when the browser creates the frame's initial
  // about:blank document; later attribute edits only apply to a subsequent
  // navigation, and this frame is never navigated. So build a fresh frame per
  // resource with its final sandbox/allow attributes already in place.
  function createViewFrame(sandbox, allow) {
    if (inner && inner.parentNode) { inner.parentNode.removeChild(inner); }
    inner = document.createElement("iframe");
    inner.style.cssText = "width:100%;height:100%;border:none;";
    inner.setAttribute("referrerpolicy", "no-referrer");
    inner.setAttribute("sandbox", sandbox);
    if (allow) { inner.setAttribute("allow", allow); }
    document.body.appendChild(inner);
    return inner;
  }

  // document.write (not srcdoc) keeps the View on this proxy origin, which is
  // what makes origin-bound APIs and nested same-site documents work; it is
  // also what the reference host does. Enforcement is unchanged: the about:blank
  // document inherits this proxy's HTTP CSP, and the sanitized meta policy still
  // precedes every untrusted app-controlled byte. srcdoc is the fallback for
  // when the View document is unreachable (e.g. a narrowed sandbox override).
  function writeView(frame, html) {
    var doc = null;
    try {
      doc = frame.contentDocument
        || (frame.contentWindow && frame.contentWindow.document)
        || null;
    } catch (e) { doc = null; }
    if (doc && typeof doc.write === "function") {
      doc.open();
      doc.write(INNER_CSP_META + html);
      doc.close();
      return;
    }
    frame.srcdoc = INNER_CSP_META + html;
  }

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) { return; }
      var data = event.data;
      if (data && data.method === RESOURCE_READY) {
        var params = data.params || {};
        var frame = createViewFrame(
          sanitizeSandbox(params.sandbox),
          buildAllowAttribute(params.permissions)
        );
        if (typeof params.html === "string") { writeView(frame, params.html); }
      } else if (!isSandboxControlMessage(data) && inner && inner.contentWindow) {
        // "*" is required: the View lives on this proxy origin or on an opaque
        // origin, never on the host origin. See the contract note above.
        inner.contentWindow.postMessage(data, "*");
      }
    } else if (inner && event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN && event.origin !== "null") { return; }
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


/** Ensure the one transport listener is running, sharing concurrent startup. */
async function ensureSharedSandboxListener(
  state: SandboxRuntimeState,
): Promise<SandboxListenerState | undefined> {
  const existing = state.entries.get('');
  if (existing?.status === 'listening') return existing;

  if (state.sharedListenerStart) {
    const success = await state.sharedListenerStart;
    const started = state.entries.get('');
    return success && started?.status === 'listening' ? started : undefined;
  }

  const listenerState: SandboxListenerState = {
    port: state.basePort,
    status: 'starting',
  };
  state.entries.set('', listenerState);

  const startPromise = startSandboxListener(listenerState, state.bindHost);
  state.sharedListenerStart = startPromise;
  let success = false;
  try {
    success = await startPromise;
  } finally {
    if (state.sharedListenerStart === startPromise) {
      state.sharedListenerStart = undefined;
    }
  }

  if (!success) {
    if (state.entries.get('') === listenerState) state.entries.delete('');
    return undefined;
  }
  return listenerState;
}

/**
 * Ensure the singleton sandbox transport is available and mint a token scoped
 * to `originKey`. Local installs separate browser state with `*.localhost`; LAN
 * installs can use the request hostname directly, and hosted installs may use
 * an optional wildcard hostname template.
 *
 * The empty key is reserved for internal startup/readiness compatibility. API
 * routes must derive and pass a non-empty verified key before returning a URL.
 */
export async function ensureSandboxForOriginKey(
  originKey: string,
): Promise<{ port: number; token: string } | undefined> {
  const state = getOrInitRuntimeState();
  if (originKey !== '' && !isValidSandboxOriginKey(originKey)) return undefined;

  const listener = await ensureSharedSandboxListener(state);
  if (!listener) return undefined;
  return {
    port: listener.port,
    token: getSandboxTokenForOriginKey(originKey),
  };
}

/**
 * Start the singleton HTTP listener. Returns false on binding/runtime errors;
 * callers never probe another port because browser origins must stay stable.
 */
async function startSandboxListener(
  listenerState: SandboxListenerState,
  host: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handleSandboxRequest(req, res);
    });

    listenerState.server = server;
    let startupSettled = false;
    const settleStartup = (success: boolean) => {
      if (startupSettled) return;
      startupSettled = true;
      resolve(success);
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      listenerState.status = 'failed';
      if (err.code === 'EADDRINUSE') {
        log.warn(`MCP Apps sandbox port ${listenerState.port} is already in use`);
      } else {
        log.error(`Sandbox listener error on port ${listenerState.port}`, err);
      }
      settleStartup(false);
    });

    server.listen(listenerState.port, host, () => {
      listenerState.status = 'listening';
      log.debug(`MCP Apps sandbox listener on ${host}:${listenerState.port}`);
      settleStartup(true);
    });
  });
}

/**
 * Stop a sandbox listener, closing its server and removing it from runtime.
 * Safe to call on non-existent keys.
 */
export async function stopSandboxListener(originKey: string): Promise<void> {
  const state = getOrInitRuntimeState();
  if (originKey === '' && state.sharedListenerStart) {
    try {
      await state.sharedListenerStart;
    } catch {
      // Startup reports failure through its boolean result; continue cleanup.
    }
  }
  const entry = state.entries.get(originKey);
  if (!entry) return;

  const server = entry.server;
  if (server?.listening) {
    return new Promise((resolve) => {
      server.close(() => {
        if (state.entries.get(originKey) === entry) state.entries.delete(originKey);
        resolve();
      });
      // Forcibly close any lingering sockets.
      server.closeAllConnections?.();
    });
  }
  if (state.entries.get(originKey) === entry) state.entries.delete(originKey);
}

/** Stop all sandbox listeners, including any adopted legacy entries. */
export async function stopAllSandboxListeners(): Promise<void> {
  const state = getOrInitRuntimeState();
  const promises: Promise<void>[] = [];
  for (const key of Array.from(state.entries.keys())) {
    promises.push(stopSandboxListener(key));
  }
  await Promise.all(promises);
}

/**
 * Record a FLUJO origin that is allowed to frame the sandbox. Called from the
 * authenticated `/api/mcp/app-sandbox` handler, which is the only place where
 * the host origin is known for certain: the sandbox listener's own request
 * headers describe the *sandbox* origin, never the embedder.
 */
export function registerSandboxHostOrigin(candidate: string | undefined | null): void {
  if (!candidate) return;
  const origin = parseHttpOrigin(candidate);
  if (!origin) return;
  const state = getOrInitRuntimeState();
  const existing = state.hostOrigins.indexOf(origin);
  if (existing !== -1) state.hostOrigins.splice(existing, 1);
  state.hostOrigins.push(origin);
  while (state.hostOrigins.length > MAX_CONFIGURED_HOST_ORIGINS) {
    state.hostOrigins.shift();
  }
}

/** Diagnostic/test accessor for the registered embedder origins. */
export function getRegisteredSandboxHostOrigins(): string[] {
  return [...getOrInitRuntimeState().hostOrigins];
}

/**
 * The embedder's origin as reported by `Referer`. The host sets
 * `referrerpolicy="origin"` on the proxy iframe, but tolerate a full URL too
 * (a stricter/looser policy must not silently break framing).
 */
function refererOriginOf(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    const parsed = new URL(referer);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost');
}

/**
 * Decide whether the referring document may be named in `frame-ancestors`.
 * A local install serves FLUJO and the sandbox from the same hostname on
 * different ports, so a same-hostname (or loopback-to-loopback) referrer is
 * the expected desktop case. Anything else must be declared explicitly.
 */
function isTrustedEmbedderOrigin(origin: string, req: http.IncomingMessage): boolean {
  const state = getOrInitRuntimeState();
  if (state.configuredHostOrigins.includes(origin)) return true;
  if (state.hostOrigins.includes(origin)) return true;

  const embedderHost = hostnameOf(origin);
  const listenerHost = hostnameOf(req.headers.host);
  if (!embedderHost) return false;
  if (listenerHost && embedderHost.toLowerCase() === listenerHost.toLowerCase()) return true;
  return isLoopbackHostname(embedderHost) && isLoopbackHostname(listenerHost);
}

/**
 * Get the allowed `frame-ancestors` for a sandbox document request.
 *
 * The embedder is FLUJO's own page (e.g. `http://localhost:4200`), NOT this
 * listener (`http://localhost:4203`). Deriving the directive from the request's
 * `Host`/`X-Forwarded-Host` header therefore named the sandbox itself and the
 * browser blocked every frame. Sources, in order of trust:
 *   1. `FLUJO_MCP_APP_HOST_ORIGINS` (explicit allowlist, needed for nested chains)
 *   2. Origins registered when the host minted a sandbox token (authenticated)
 *   3. The request's `Referer` origin, when it passes {@link isTrustedEmbedderOrigin}
 * An empty result stays fail-closed (`'none'`) in {@link sanitizeFrameAncestors}.
 */
export function getAllowedFrameAncestors(req: http.IncomingMessage): string[] {
  // Escape hatch: accept any embedder origin. The literal '*' is preserved by
  // sanitizeFrameAncestors and becomes `frame-ancestors *`.
  if (sandboxAllowAllContent()) return ['*'];
  const state = getOrInitRuntimeState();
  const ancestors: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    ancestors.push(value);
  };

  for (const origin of state.configuredHostOrigins) add(origin);

  // A configured allowlist is authoritative and stays fail-closed.
  if (state.configuredHostOrigins.length > 0) return ancestors;

  for (const origin of state.hostOrigins) add(origin);

  const refererOrigin = refererOriginOf(req.headers.referer);
  if (refererOrigin && isTrustedEmbedderOrigin(refererOrigin, req)) add(refererOrigin);

  return ancestors;
}

function parseHostHeaderHostname(hostHeader: string | undefined): string | undefined {
  if (
    !hostHeader
    || hostHeader.length > 512
    || /[\s/\\?#@,]/.test(hostHeader)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the app key from a key-bearing browser-visible hostname. The
 * `<key>.localhost` form remains valid regardless of global exposure mode, so
 * switching on LAN access cannot break a dashboard opened on localhost. Hosted
 * mode also matches `{app}` as one complete configured DNS label.
 */
export function deriveOriginKeyFromHost(hostHeader: string | undefined): string | undefined {
  const requestHostname = parseHostHeaderHostname(hostHeader);
  if (!requestHostname) return undefined;

  const suffix = '.localhost';
  if (requestHostname.endsWith(suffix)) {
    const candidate = requestHostname.slice(0, -suffix.length);
    return isValidSandboxOriginKey(candidate) ? candidate : undefined;
  }

  const template = getValidSandboxAppUrlTemplate();
  if (!template) return undefined;
  const templateLabels = template.hostname.toLowerCase().split('.');
  const requestLabels = requestHostname.split('.');
  if (requestLabels.length !== templateLabels.length) return undefined;

  const placeholderIndex = templateLabels.indexOf('{app}');
  if (placeholderIndex === -1) return undefined;
  for (let index = 0; index < templateLabels.length; index += 1) {
    if (index === placeholderIndex) continue;
    if (requestLabels[index] !== templateLabels[index]) return undefined;
  }

  const candidate = requestLabels[placeholderIndex];
  return isValidSandboxOriginKey(candidate) ? candidate : undefined;
}

/**
 * Request handler for sandbox proxy documents. Validates the authentication token
 * scoped to the originKey, and serves the sandbox proxy HTML with CSP headers.
 *
 * Browser requests normally carry the app key in their hostname. The automatic
 * LAN fallback carries it in the URL because arbitrary LAN subdomains do not
 * resolve without managed DNS. In both cases the HMAC token is scoped to that
 * exact key; the internal empty startup key is never a browser-visible fallback.
 */
function handleSandboxRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Never let an untrusted/malformed Host header participate in URL parsing.
  const url = new URL(req.url || '/', 'http://localhost');

  // Only allow GET on /sandbox.html or /
  if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/sandbox.html')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const hostOriginKey = deriveOriginKeyFromHost(req.headers.host);
  const queryOriginKey = url.searchParams.get('originKey');
  const effectiveOriginKey = hostOriginKey || (
    getExposureMode() !== 'localhost' && isValidSandboxOriginKey(queryOriginKey)
      ? queryOriginKey
      : undefined
  );

  // Validate token scoped to this originKey.
  const token = url.searchParams.get(SANDBOX_AUTH_QUERY_PARAM);
  if (!effectiveOriginKey || !isSandboxTokenValidForOriginKey(token, effectiveOriginKey)) {
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
  // The in-document embedder check must accept exactly what `frame-ancestors`
  // accepts, otherwise a legitimately framed host passes the browser policy and
  // is then rejected by the proxy script itself (blank sandbox, app never boots).
  const embedderOrigins = Array.from(new Set([
    ...state.configuredHostOrigins,
    ...state.hostOrigins,
  ]));
  res.end(buildSandboxProxyHtml(
    embedderOrigins,
    hasConfiguredSandboxHostOrigins(),
    csp,
    sandboxAllowAllContent(),
  ));
}

/**
 * Ensure the singleton transport listener exists for readiness. The internal
 * empty key does not authorize HTTP requests and is never exposed as an app
 * origin. Called from instrumentation-node.ts at startup; fire-and-forget.
 */
export function startSandboxServer(): void {
  // Kick off the default listener in the background; don't await.
  ensureSandboxForOriginKey('')
    .then((result) => {
      if (result) {
        log.info(`MCP Apps sandbox listening on port ${result.port}`);
      } else {
        log.warn('MCP Apps sandbox unavailable: origin isolation prerequisites are unmet');
      }
    })
    .catch((err) => {
      log.error('MCP Apps sandbox startup error', err);
    });
}

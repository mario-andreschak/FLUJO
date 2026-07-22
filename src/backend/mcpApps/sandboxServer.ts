/**
 * MCP Apps (#97) — Phase 2 sandbox proxy origin.
 *
 * The MCP Apps spec (2026-01-26) renders an app's HTML inside a sandboxed
 * iframe, but the iframe runs `allow-scripts allow-same-origin` — so isolation
 * from FLUJO can NOT come from the sandbox attribute alone. It comes from a
 * SEPARATE ORIGIN: a tiny "sandbox proxy" document served from a different
 * origin than the FLUJO app. The proxy creates the real (inner) app iframe,
 * `document.write`s the untrusted HTML into it, and relays postMessage between
 * FLUJO (parent) and the app (inner). Because the proxy is a foreign origin,
 * the app's `allow-same-origin` grants it same-origin access only to the
 * throwaway sandbox origin — never to FLUJO's cookies/storage/DOM.
 *
 * This module runs that foreign origin as a dedicated HTTP listener on its own
 * port (default FLUJO_PORT+1). It serves exactly one document — `sandbox.html`
 * — with a Content-Security-Policy set via HTTP HEADER (tamper-proof, unlike a
 * <meta> tag) built from the resource's declared `_meta.ui.csp`, passed in via
 * the `?csp=` query param by the host.
 *
 * The proxy script is inlined (dependency-free vanilla JS) so this needs no
 * bundler step and stays in lockstep with the constants below.
 *
 * Security posture: the listener binds loopback by default and serves only the
 * sandbox document; every other path 404s. If it cannot start, MCP Apps simply
 * don't render — FLUJO itself is unaffected.
 */
import http from 'node:http';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/mcpApps/sandboxServer');

/** JSON-RPC method names shared with the host bridge (see mcpApps.ts). */
const SANDBOX_PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const SANDBOX_RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';

/** Default port for the sandbox origin. Override with FLUJO_MCP_APP_SANDBOX_PORT. */
export const DEFAULT_SANDBOX_PORT = 4201;

export function getSandboxPort(): number {
  const raw = process.env.FLUJO_MCP_APP_SANDBOX_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_SANDBOX_PORT;
}

/** Bind host for the listener. Loopback by default; set FLUJO_MCP_APP_SANDBOX_HOST to widen. */
function getSandboxBindHost(): string {
  return process.env.FLUJO_MCP_APP_SANDBOX_HOST || '127.0.0.1';
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

/**
 * Reject any CSP source token that could break out of its directive: whitespace
 * (injects extra sources), `;`/newlines (injects a new directive), or quotes
 * (injects keywords like 'unsafe-eval'). Rejected tokens are dropped, never
 * substituted — matching the spec host's sanitizer.
 */
function sanitizeCspDomains(domains?: string[]): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.filter((d) => typeof d === 'string' && d.length > 0 && !/[;\r\n'"` ]/.test(d));
}

/**
 * Build the CSP header for the sandbox document from the resource's declared
 * `_meta.ui.csp`. `'self'` here is the throwaway sandbox origin (NOT FLUJO), so
 * inline scripts/styles are safe to allow — a self-contained app document needs
 * them to run at all. Network egress is default-deny: `connect-src 'self'` plus
 * only the explicitly declared connect domains.
 */
export function buildSandboxCsp(csp?: ResourceCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(' ');
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(' ');
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(' ');
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(' ');

  const directives = [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'self' 'unsafe-inline' blob: data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `img-src 'self' data: blob:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src 'self' data: blob:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `media-src 'self' data: blob:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `connect-src 'self'${connectDomains ? ` ${connectDomains}` : ''}`,
    `worker-src 'self' blob:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ];
  return directives.join('; ');
}

/**
 * The sandbox proxy document. The inlined script is dependency-free vanilla JS:
 * it validates that it is embedded (in an iframe) by a same-hostname or
 * loopback origin, self-tests that it cannot reach `window.top` (proving the
 * sandbox is real), creates the inner app iframe, and relays postMessage in
 * both directions with strict origin checks. `sandbox-resource-ready` is
 * intercepted to load the app HTML via `document.write`.
 */
function sandboxHtml(): string {
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

  if (window.self === window.top) { throw new Error("Sandbox proxy must be embedded in an iframe."); }
  if (!document.referrer) { throw new Error("Sandbox proxy: no referrer to validate embedder."); }

  var referrerOrigin;
  try { referrerOrigin = new URL(document.referrer).origin; }
  catch (e) { throw new Error("Sandbox proxy: unparseable referrer."); }

  // The embedder must be loopback, or the SAME hostname as this sandbox (host
  // and sandbox share a hostname and differ only by port). This keeps a foreign
  // web page from embedding the sandbox, without hard-coding a port.
  var refHost = new URL(document.referrer).hostname;
  var ownHost = window.location.hostname;
  var loopback = /^(localhost|127\\.0\\.0\\.1|\\[::1\\]|::1)$/;
  if (!(loopback.test(refHost) || refHost === ownHost)) {
    throw new Error("Sandbox proxy: embedder origin not allowed: " + referrerOrigin);
  }
  var EXPECTED_HOST_ORIGIN = referrerOrigin;
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

  var inner = document.createElement("iframe");
  inner.style.cssText = "width:100%;height:100%;border:none;";
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  document.body.appendChild(inner);

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) { return; }
      var data = event.data;
      if (data && data.method === RESOURCE_READY) {
        var params = data.params || {};
        if (typeof params.sandbox === "string") { inner.setAttribute("sandbox", params.sandbox); }
        var allow = buildAllowAttribute(params.permissions);
        if (allow) { inner.setAttribute("allow", allow); }
        if (typeof params.html === "string") {
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document);
          if (doc) { doc.open(); doc.write(params.html); doc.close(); }
          else { inner.srcdoc = params.html; }
        }
      } else if (inner.contentWindow) {
        inner.contentWindow.postMessage(data, "*");
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN && event.origin !== "null") { return; }
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    }
  });

  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, EXPECTED_HOST_ORIGIN);
})();
</script>
</body>
</html>`;
}

let started = false;
let server: http.Server | undefined;

/**
 * Start the sandbox proxy listener (idempotent). Fire-and-forget from
 * instrumentation; never throws — a bind failure is logged and MCP Apps just
 * won't render.
 */
export function startSandboxServer(): void {
  if (started) return;
  started = true;
  const port = getSandboxPort();
  const host = getSandboxBindHost();

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/sandbox.html')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    let csp: ResourceCsp | undefined;
    const cspParam = url.searchParams.get('csp');
    if (cspParam) {
      try { csp = JSON.parse(cspParam); } catch { /* fall back to default-deny */ }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', buildSandboxCsp(csp));
    // Frame ancestry: only same-hostname/loopback FLUJO may embed us. Belt-and-
    // suspenders alongside the in-page referrer check.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(sandboxHtml());
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`Sandbox proxy port ${port} already in use — assuming a prior instance is serving it.`);
    } else {
      log.error('Sandbox proxy server error', err);
    }
  });

  server.listen(port, host, () => {
    log.info(`MCP Apps sandbox proxy listening on http://${host}:${port}`);
  });
}

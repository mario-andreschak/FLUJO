/**
 * MCP Apps (SEP-1865, extension `io.modelcontextprotocol/ui`) — shared, pure
 * helpers for FLUJO's sandboxed, interactive host support (issue #97):
 * classifying tool-linked `ui://` resources, validating metadata, and safely
 * extracting their HTML.
 *
 * Everything here is framework-free and side-effect-free so it can be unit
 * tested in the node-env Jest harness and reused on both the backend (link
 * extraction / opt-in gating) and the frontend (HTML extraction). Nothing in
 * this module fetches, renders, or executes server content. The interactive
 * AppBridge and foreign-origin sandbox live in McpAppFrame/sandboxServer.
 */

/** URI scheme SEP-1865 uses for UI resources, e.g. `ui://weather-dashboard`. */
export const UI_RESOURCE_SCHEME = 'ui://';

/**
 * Required media-type profile for UI resources. Parsing tolerates ordinary
 * whitespace and additional well-formed parameters such as `charset`.
 */
export const MCP_APP_MIME_PROFILE = 'profile=mcp-app';

/**
 * Sandbox attribute for the inner app View, matching the MCP Apps reference
 * host (`ext-apps/examples/basic-host/src/sandbox.ts`).
 *
 * The spec's sandbox-proxy rules require isolation from the HOST origin — the
 * proxy MUST live on a different origin than FLUJO and MUST itself carry
 * `allow-scripts allow-same-origin`; the View then reaches the host only
 * through the proxy's postMessage relay. The View is NOT required to be on an
 * opaque origin, and forcing one breaks every app that touches origin-bound
 * browser state (cookies, `localStorage`, IndexedDB, service workers) or that
 * nests a real document via `csp.frameDomains` — sandbox flags are inherited by
 * every nested browsing context regardless of its URL.
 *
 * `allow-same-origin` here means "same origin as the throwaway sandbox proxy",
 * never FLUJO's origin: `window.top` stays cross-origin, so FLUJO's session and
 * storage remain unreachable. Cross-View isolation is an origin-separation
 * problem (`_meta.ui.domain` / one origin per app), not a sandbox-flag problem.
 */
export const MCP_APP_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

/**
 * The only sandbox tokens the proxy will ever put on the View, even if a host
 * override asks for more. `allow-downloads` and `allow-popups` are deliberately
 * excluded: the spec routes those through `ui/download-file` and `ui/open-link`
 * so they stay host-mediated and auditable.
 */
export const MCP_APP_IFRAME_SANDBOX_ALLOWED_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
] as const;

/** Hard cap on a rendered UI resource's HTML size (bytes). Guards the browser. */
export const MAX_UI_RESOURCE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * The `_meta.ui.csp` block a UI resource may carry per SEP-1865. Every domain
 * list maps to a CSP directive; an omitted/empty list yields the secure default
 * (no external connections/resources).
 */
export interface UIResourceCsp {
  /** CSP `connect-src` — fetch/XHR/WebSocket targets the app may reach. */
  connectDomains?: string[];
  /** CSP `img-src`/`script-src`/`style-src`/`font-src`/`media-src` origins. */
  resourceDomains?: string[];
  /** CSP `frame-src` — origins the app may itself embed. */
  frameDomains?: string[];
  /** CSP `base-uri` — origins allowed in a `<base>` tag. */
  baseUriDomains?: string[];
}

/** The complete resource metadata block declared under `_meta.ui`. */
export interface UIResourceMeta {
  csp?: UIResourceCsp;
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  domain?: string;
  prefersBorder?: boolean;
}

/** A tool/result carries its UI link under this key per SEP-1865. */
export interface ToolUiLink {
  resourceUri?: string;
}

/** True when `uri` is a UI resource URI (`ui://…`). */
export function isUiResourceUri(uri: unknown): uri is string {
  return (
    typeof uri === 'string'
    && uri.length > UI_RESOURCE_SCHEME.length
    && uri.slice(0, UI_RESOURCE_SCHEME.length).toLowerCase() === UI_RESOURCE_SCHEME
    && !/\s/.test(uri)
  );
}

/** True when `mimeType` denotes an MCP-app HTML resource (`text/html;profile=mcp-app`). */
export function isMcpAppMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== 'string') return false;
  const [essence, ...rawParameters] = mimeType.toLowerCase().split(';');
  if (essence.trim() !== 'text/html') return false;
  let foundProfile = false;
  for (const parameter of rawParameters) {
    const equals = parameter.indexOf('=');
    if (equals <= 0) return false;
    const name = parameter.slice(0, equals).trim();
    const value = parameter.slice(equals + 1).trim();
    if (!name || !value) return false;
    if (name !== 'profile') continue;
    if (foundProfile || value !== 'mcp-app') return false;
    foundProfile = true;
  }
  return foundProfile;
}

/**
 * Extract the linked UI resource URI from an MCP `_meta` block, if any.
 *
 * The stable specification uses `_meta.ui.resourceUri` and retains the flat
 * `_meta["ui/resourceUri"]` spelling for compatibility. Some servers key the
 * extension by its full identifier
 * (`_meta["io.modelcontextprotocol/ui"].resourceUri`). Returns a link only when
 * it is a valid `ui://` string.
 */
export function extractUiResourceUri(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;
  const flatUri = record['ui/resourceUri'];
  if (isUiResourceUri(flatUri)) return flatUri;

  const candidates: unknown[] = [record['ui'], record['io.modelcontextprotocol/ui']];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const uri = (candidate as ToolUiLink).resourceUri;
      if (isUiResourceUri(uri)) return uri;
    }
  }
  return undefined;
}

/**
 * Strict per-token allow-list for a CSP source expression that originates from a
 * SERVER-controlled `_meta.ui` domain list.
 *
 * Directives are later joined with `'; '` and sources within a directive with a
 * space, so ANY token containing a CSP-special character (whitespace, `;`, `,`,
 * quotes, `$`, backtick, `<`/`>`, parentheses, backslash, or an ASCII control
 * char) could inject a brand-new directive/keyword and silently widen the policy
 * — defeating the default-deny egress boundary the whole design rests
 * on. We therefore accept ONLY:
 *   - `https://` or `wss://` origins of the form `scheme://[*.]host[:port]`
 *     where `host` is one or more DNS labels (`[a-z0-9-]`, dot-separated), an
 *     optional single `*.` wildcard prefix is allowed, and an optional `:port`
 *     is 1–5 digits.
 *
 * Everything else — bare `*`, `'unsafe-inline'`, `'unsafe-eval'`, `data:`,
 * `blob:`, non-loopback `http:`/`ws:`, URLs with credentials/paths/queries
 * — is rejected. Plain-HTTP/WS LOOPBACK origins (`http://127.0.0.1:<port>`,
 * `ws://localhost:<port>`, `http://[::1]:<port>` — explicit port required) are
 * accepted ONLY when the caller explicitly opts in via
 * `options.allowLoopback`; callers must gate that on FLUJO's `localhost`
 * exposure mode (this module stays framework-free, so the exposure decision is
 * threaded in as a parameter). Invalid tokens are dropped SILENTLY; this module
 * is deliberately framework-free and side-effect-free (no logging), and a
 * rejected token is NEVER replaced by a wildcard.
 */
export function isValidCspSourceToken(
  token: unknown,
  options?: { allowLoopback?: boolean },
): boolean {
  if (options?.allowLoopback === true && isLoopbackCspOrigin(token)) return true;
  if (typeof token !== 'string') return false;
  // Defence-in-depth: reject any control char or CSP-special char outright.
  // (control chars, space, DEL and any non-ASCII are caught by the printable
  // complement; the second class rejects CSP/HTML/regex-special printables.)
  if (/[^\x21-\x7e]/.test(token) || /[;,'"`$<>\\()]/.test(token)) return false;
  const match = /^(?:https|wss):\/\/(?:\*\.)?([^/:?#]+)(?::(\d{1,5}))?$/i.exec(token);
  if (!match) return false;
  const hostname = match[1];
  if (
    hostname.length > 253
    || hostname.split('.').some((label) => (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ))
  ) return false;
  const port = match[2] ? Number(match[2]) : undefined;
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65_535);
}

/**
 * Strict validator for a plain-HTTP/WS LOOPBACK origin declared by a local MCP
 * App server (e.g. an IDE gateway on `http://127.0.0.1:<port>` with its bridge
 * on `ws://127.0.0.1:<port>`). Accepted shape: `http://` or `ws://`, host
 * exactly `127.0.0.1`, `localhost`, or `[::1]`, and a REQUIRED explicit port —
 * so the token stays one unambiguous, non-routable origin. `[::1]` is handled
 * here explicitly because the secure-origin grammar's hostname class excludes
 * the bracketed-colon form.
 *
 * This is an opt-in exception: callers must gate it on FLUJO not being publicly
 * exposed (the `localhost` and `network` modes, where the operator's browser and
 * the MCP servers share a machine). Public/hosted deployments keep the
 * secure-origin-only policy.
 */
export function isLoopbackCspOrigin(
  token: unknown,
  allowedSchemes: ReadonlyArray<'http' | 'ws'> = ['http', 'ws'],
): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2_048) return false;
  // Same defence-in-depth as isValidCspSourceToken: no CSP-special characters.
  if (/[^\x21-\x7e]/.test(token) || /[;,'"`$<>\\()]/.test(token)) return false;
  const match = /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(token);
  if (!match || !allowedSchemes.includes(match[1].toLowerCase() as 'http' | 'ws')) return false;
  const port = Number(match[3]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Build the Content-Security-Policy string for the sandboxed app iframe from a
 * resource's `_meta.ui` block. Default-deny: with no domains declared the app
 * gets `default-src 'none'` plus inline scripts/styles (needed for a self-
 * contained `srcdoc` document) and data: images — but NO network egress.
 *
 * Declared domains widen only the specific directive they map to. This string
 * is injected as a `<meta http-equiv="Content-Security-Policy">` inside the
 * iframe document (belt-and-suspenders alongside the `sandbox` attribute).
 *
 * `options.allowLoopback` additionally admits loopback `http://`/`ws://`
 * origins (see isLoopbackCspOrigin); the scheme→directive mapping mirrors the
 * secure one: `ws:` may widen only `connect-src`, `http:` the others.
 */
export function buildAppCsp(
  meta?: UIResourceCsp | null,
  options?: { allowLoopback?: boolean },
): string {
  const allowLoopback = options?.allowLoopback === true;
  const cleanDomains = (
    domains: string[] | undefined,
    allowedSchemes: Array<'https' | 'wss' | 'http' | 'ws'>,
  ): string =>
    (domains || [])
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter((d) => (
        d !== ''
        && isValidCspSourceToken(d, { allowLoopback })
        && allowedSchemes.some((scheme) => d.toLowerCase().startsWith(`${scheme}://`))
      ))
      .join(' ');

  const connect = cleanDomains(
    meta?.connectDomains,
    allowLoopback ? ['https', 'wss', 'http', 'ws'] : ['https', 'wss'],
  );
  const resource = cleanDomains(meta?.resourceDomains, allowLoopback ? ['https', 'http'] : ['https']);
  const frame = cleanDomains(meta?.frameDomains, allowLoopback ? ['https', 'http'] : ['https']);
  const baseUri = cleanDomains(meta?.baseUriDomains, allowLoopback ? ['https', 'http'] : ['https']);

  const directives: string[] = [
    "default-src 'none'",
    // A self-contained srcdoc document needs inline script/style to run at all.
    `script-src 'self' 'unsafe-inline'${resource ? ` ${resource}` : ''}`,
    `style-src 'self' 'unsafe-inline'${resource ? ` ${resource}` : ''}`,
    `img-src 'self' data:${resource ? ` ${resource}` : ''}`,
    `font-src${resource ? ` ${resource}` : " 'none'"}`,
    `media-src 'self' data:${resource ? ` ${resource}` : ''}`,
    `connect-src${connect ? ` ${connect}` : " 'none'"}`,
    "worker-src 'none'",
    `frame-src${frame ? ` ${frame}` : " 'none'"}`,
    "object-src 'none'",
    `base-uri${baseUri ? ` ${baseUri}` : " 'self'"}`,
    "form-action 'none'",
  ];
  return directives.join('; ');
}

/**
 * Wrap a UI resource's HTML in a self-contained document that carries the CSP
 * as a `<meta http-equiv>` so the policy applies even inside a `srcdoc` iframe.
 * If the HTML already declares `<head>`, the meta is injected right after it;
 * otherwise a minimal document scaffold is added.
 */
export function buildAppSrcDoc(html: string, meta?: UIResourceCsp | null): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildAppCsp(meta)}">`;
  if (/<head[\s>]/i.test(html)) {
    // Use a FUNCTION replacer so the (server-derived) `cspMeta` is inserted
    // verbatim: a plain string replacement would let `$`-sequences ($$, $&,
    // $1, etc.) in `cspMeta` be interpreted by String.prototype.replace and
    // fail to round-trip. The replacer also re-emits the captured <head>
    // attributes (`attrs`) intact.
    return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${cspMeta}`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${cspMeta}</head><body>${html}</body></html>`;
}

/** Minimal shape of an MCP ReadResourceResult content entry we care about. */
interface ResourceContentEntry {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: {
    ui?: UIResourceMeta;
  };
}

/**
 * Pull the renderable HTML string out of a ReadResourceResult, enforcing exact
 * resource URI matching, the stable `text/html;profile=mcp-app` MIME profile,
 * valid text/base64 content, and the size cap.
 */
export function extractAppHtml(
  result: unknown,
  maxBytes: number = MAX_UI_RESOURCE_BYTES,
  requestedUri?: string,
): { html: string; meta?: UIResourceMeta } | { error: string } {
  const contents = (result as { contents?: ResourceContentEntry[] } | null | undefined)?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    return { error: 'Resource has no contents' };
  }
  const appEntry = contents.find((entry) => {
    if (!isMcpAppMimeType(entry.mimeType)) return false;
    if (requestedUri !== undefined && entry.uri !== requestedUri) return false;
    return typeof entry.text === 'string' || typeof entry.blob === 'string';
  });

  if (!appEntry) {
    return {
      error: requestedUri === undefined
        ? 'Resource has no MCP App HTML body'
        : `Resource has no MCP App HTML body matching ${requestedUri}`,
    };
  }

  let html: string;
  if (typeof appEntry.text === 'string') {
    html = appEntry.text;
  } else {
    try {
      if (typeof Buffer !== 'undefined') {
        html = Buffer.from(appEntry.blob as string, 'base64').toString('utf8');
      } else {
        const binary = atob(appEntry.blob as string);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        html = new TextDecoder().decode(bytes);
      }
    } catch {
      return { error: 'Resource contains invalid base64 HTML' };
    }
  }

  const byteLength =
    typeof Buffer !== 'undefined'
      ? Buffer.byteLength(html, 'utf8')
      : new TextEncoder().encode(html).length;
  if (byteLength > maxBytes) {
    return { error: `Resource exceeds the ${Math.round(maxBytes / 1024)} KiB size cap` };
  }
  return { html, meta: appEntry._meta?.ui };
}

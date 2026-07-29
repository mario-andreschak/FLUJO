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
 * Sandbox attribute for the inner app View. `allow-scripts` WITHOUT
 * `allow-same-origin`: the app may run JS but retains an opaque origin. The
 * foreign-origin outer proxy has a separate sandbox policy because it owns the
 * postMessage relay; do not reuse that policy for server-supplied HTML.
 */
export const MCP_APP_IFRAME_SANDBOX = 'allow-scripts';

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
 * `blob:`, `http:`/`ws:` (incl. localhost), URLs with credentials/paths/queries
 * — is rejected. Invalid tokens are dropped SILENTLY; this module is
 * deliberately framework-free and side-effect-free (no logging), and a rejected
 * token is NEVER replaced by a wildcard.
 */
export function isValidCspSourceToken(token: unknown): boolean {
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
 * Build the Content-Security-Policy string for the sandboxed app iframe from a
 * resource's `_meta.ui` block. Default-deny: with no domains declared the app
 * gets `default-src 'none'` plus inline scripts/styles (needed for a self-
 * contained `srcdoc` document) and data: images — but NO network egress.
 *
 * Declared domains widen only the specific directive they map to. This string
 * is injected as a `<meta http-equiv="Content-Security-Policy">` inside the
 * iframe document (belt-and-suspenders alongside the `sandbox` attribute).
 */
export function buildAppCsp(meta?: UIResourceCsp | null): string {
  const cleanDomains = (
    domains: string[] | undefined,
    allowedSchemes: Array<'https' | 'wss'>,
  ): string =>
    (domains || [])
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter((d) => (
        d !== ''
        && isValidCspSourceToken(d)
        && allowedSchemes.some((scheme) => d.toLowerCase().startsWith(`${scheme}://`))
      ))
      .join(' ');

  const connect = cleanDomains(meta?.connectDomains, ['https', 'wss']);
  const resource = cleanDomains(meta?.resourceDomains, ['https']);
  const frame = cleanDomains(meta?.frameDomains, ['https']);
  const baseUri = cleanDomains(meta?.baseUriDomains, ['https']);

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

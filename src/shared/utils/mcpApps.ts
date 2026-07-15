/**
 * MCP Apps (SEP-1865, extension `io.modelcontextprotocol/ui`) — shared, pure
 * helpers for FLUJO's Phase 1 support (issue #97): read-only, sandboxed
 * rendering of a tool's linked `ui://` UI resource in the chat tool-call
 * timeline.
 *
 * Everything here is framework-free and side-effect-free so it can be unit
 * tested in the node-env Jest harness and reused on both the backend (link
 * extraction / opt-in gating) and the frontend (CSP + sandbox assembly, HTML
 * extraction). NOTHING in this module fetches, renders, or executes anything —
 * it only classifies and assembles strings.
 *
 * Security note: Phase 1 is read-only. There is deliberately NO iframe→host
 * JSON-RPC bridge here; the interactive bridge is a gated Phase 2 that must
 * pass the plan's §5 security checklist first.
 */

/** URI scheme SEP-1865 uses for UI resources, e.g. `ui://weather-dashboard`. */
export const UI_RESOURCE_SCHEME = 'ui://';

/**
 * MIME type a UI resource is served as. Matched loosely (prefix + profile
 * token) so a server that adds charset/whitespace params still qualifies.
 */
export const MCP_APP_MIME_PROFILE = 'profile=mcp-app';

/**
 * Sandbox attribute for the rendering iframe. `allow-scripts` WITHOUT
 * `allow-same-origin`: the app may run JS but is denied same-origin access to
 * FLUJO (cookies, storage, DOM, same-origin fetch). This is the core Phase 1
 * isolation boundary — do NOT add `allow-same-origin` (it would defeat the
 * sandbox) without the Phase 2 security review.
 */
export const MCP_APP_IFRAME_SANDBOX = 'allow-scripts';

/** Hard cap on a rendered UI resource's HTML size (bytes). Guards the browser. */
export const MAX_UI_RESOURCE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * The `_meta.ui` security/render block a UI resource (or an app tool) may carry
 * per SEP-1865. Every domain list maps to a CSP directive; an omitted/empty
 * list yields the secure default (no external connections/resources).
 */
export interface UIResourceMeta {
  /** CSP `connect-src` — fetch/XHR/WebSocket targets the app may reach. */
  connectDomains?: string[];
  /** CSP `img-src`/`script-src`/`style-src`/`font-src`/`media-src` origins. */
  resourceDomains?: string[];
  /** CSP `frame-src` — origins the app may itself embed. */
  frameDomains?: string[];
  /** CSP `base-uri` — origins allowed in a `<base>` tag. */
  baseUriDomains?: string[];
}

/** A tool/result carries its UI link under this key per SEP-1865. */
export interface ToolUiLink {
  resourceUri?: string;
}

/** True when `uri` is a UI resource URI (`ui://…`). */
export function isUiResourceUri(uri: unknown): uri is string {
  return typeof uri === 'string' && uri.trim().toLowerCase().startsWith(UI_RESOURCE_SCHEME);
}

/** True when `mimeType` denotes an MCP-app HTML resource (`text/html;profile=mcp-app`). */
export function isMcpAppMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== 'string') return false;
  const normalized = mimeType.toLowerCase().replace(/\s+/g, '');
  return normalized.startsWith('text/html') && normalized.includes(MCP_APP_MIME_PROFILE);
}

/**
 * Extract the linked UI resource URI from an MCP `_meta` block, if any.
 *
 * SEP-1865 links a tool (and, in FLUJO's Phase 1, the tool RESULT that echoes
 * it) to its UI via `_meta.ui.resourceUri`. Some servers key the extension by
 * its full identifier (`_meta["io.modelcontextprotocol/ui"].resourceUri`) — we
 * accept both. Returns the URI only when it is a valid `ui://` string.
 */
export function extractUiResourceUri(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;
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
 * — defeating the Phase-1 default-deny egress boundary the whole design rests
 * on. We therefore accept ONLY:
 *   - the exact quoted keywords `'self'` and `'none'`;
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
  if (token === "'self'" || token === "'none'") return true;
  // Defence-in-depth: reject any control char or CSP-special char outright.
  // (control chars, space, DEL and any non-ASCII are caught by the printable
  // complement; the second class rejects CSP/HTML/regex-special printables.)
  if (/[^\x21-\x7e]/.test(token) || /[;,'"`$<>\\()]/.test(token)) return false;
  return /^(?:https|wss):\/\/(?:\*\.)?(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/i.test(token);
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
export function buildAppCsp(meta?: UIResourceMeta | null): string {
  const cleanDomains = (domains?: string[]): string =>
    (domains || [])
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter((d) => d !== '' && isValidCspSourceToken(d))
      .join(' ');

  const connect = cleanDomains(meta?.connectDomains);
  const resource = cleanDomains(meta?.resourceDomains);
  const frame = cleanDomains(meta?.frameDomains);
  const baseUri = cleanDomains(meta?.baseUriDomains);

  const directives: string[] = [
    "default-src 'none'",
    // A self-contained srcdoc document needs inline script/style to run at all.
    `script-src 'unsafe-inline'${resource ? ` ${resource}` : ''}`,
    `style-src 'unsafe-inline'${resource ? ` ${resource}` : ''}`,
    `img-src data: blob:${resource ? ` ${resource}` : ''}`,
    `font-src${resource ? ` ${resource}` : " 'none'"}`,
    `media-src data: blob:${resource ? ` ${resource}` : ''}`,
    `connect-src${connect ? ` ${connect}` : " 'none'"}`,
    `frame-src${frame ? ` ${frame}` : " 'none'"}`,
    `base-uri${baseUri ? ` ${baseUri}` : " 'none'"}`,
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
export function buildAppSrcDoc(html: string, meta?: UIResourceMeta | null): string {
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
}

/**
 * Pull the renderable HTML string out of a ReadResourceResult, enforcing the
 * size cap. Prefers a `text/html;profile=mcp-app` entry; falls back to the
 * first entry carrying `text`. Returns undefined when there is no usable text
 * body or it exceeds {@link MAX_UI_RESOURCE_BYTES}.
 */
export function extractAppHtml(
  result: unknown,
  maxBytes: number = MAX_UI_RESOURCE_BYTES
): { html: string; meta?: UIResourceMeta } | { error: string } {
  const contents = (result as { contents?: ResourceContentEntry[] } | null | undefined)?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    return { error: 'Resource has no contents' };
  }
  const appEntry =
    contents.find((c) => isMcpAppMimeType(c.mimeType) && typeof c.text === 'string') ||
    contents.find((c) => typeof c.text === 'string');

  if (!appEntry || typeof appEntry.text !== 'string') {
    return { error: 'Resource has no HTML text body' };
  }
  const byteLength =
    typeof Buffer !== 'undefined'
      ? Buffer.byteLength(appEntry.text, 'utf8')
      : new TextEncoder().encode(appEntry.text).length;
  if (byteLength > maxBytes) {
    return { error: `Resource exceeds the ${Math.round(maxBytes / 1024)} KiB size cap` };
  }
  const meta = (appEntry as { _meta?: { ui?: UIResourceMeta } })._meta?.ui;
  return { html: appEntry.text, meta };
}

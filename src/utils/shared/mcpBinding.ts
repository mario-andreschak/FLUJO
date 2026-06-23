/**
 * MCP binding pills — the human-authored references embedded in a node's prompt
 * template that point at an MCP tool or resource.
 *
 * Canonical readable format (matches the `${global:VAR}` convention already used for
 * global variables, and the `server__tool` convention the Claude adapter uses for
 * SDK-facing names):
 *
 *   tool pill:     ${tool:<server>__<tool>}
 *   resource pill: ${resource:<server>__<uri>}
 *
 * The `__` separates server from tool/uri. Server is everything up to the FIRST `__`,
 * so tool names and resource URIs may themselves contain `__` (and URIs their usual
 * `://`, `/`, etc.) — server names must NOT contain `__` (enforced on save). The pill
 * is `}`-terminated, so any `}` inside a URI would break it (not a real-world concern
 * for file://, https://, etc.).
 *
 * IMPORTANT — this is a FLUJO-internal, design-time, non-SDK-facing format. It is NOT
 * the name sent to an LLM as a callable function. The OpenAI API constrains function
 * names to ^[a-zA-Z0-9_-]{1,64}$ (no `:`, no `/`, <=64 chars), which this format
 * deliberately violates for readability — see toolNamespace.ts for the OpenAI encoder,
 * which is the one sanctioned place a name is mangled away from the canonical form.
 *
 * Legacy: tool pills used to be `${_-_-_<server>_-_-_<tool>}`. Parsing is dual-read so
 * existing flows keep working; we only ever WRITE the new format. (No flow migration.)
 */

export type BindingKind = 'tool' | 'resource';

export interface ParsedBinding {
  kind: BindingKind;
  server: string;
  /** Tool name (kind 'tool') or resource URI (kind 'resource'). */
  name: string;
}

export interface BindingMatch extends ParsedBinding {
  /** The full matched pill including the `${` … `}` delimiters. */
  fullMatch: string;
  /** Offset of the match within the scanned text. */
  index: number;
}

const LEGACY_SEP = '_-_-_';
// A pill body is the text between `${` and the next `}`. New bodies start with a
// `tool:`/`resource:` type tag; legacy bodies start with the `_-_-_` separator.
const NEW_BODY = /^(tool|resource):(.+)$/;
// Scanner for embedding-in-free-text. Only matches our three known shapes so it never
// consumes `${global:...}` or other `${...}` interpolation.
const PILL_SCAN = /\$\{((?:tool|resource):[^}]+|_-_-_[^}]+)\}/g;

/** Join a (server, name) pair into the canonical readable `server__name`. */
export function joinServerName(server: string, name: string): string {
  return `${server}__${name}`;
}

/** Split a canonical `server__name`; server is everything before the FIRST `__`. */
export function splitServerName(joined: string): { server: string; name: string } | null {
  const i = joined.indexOf('__');
  if (i <= 0) return null; // no separator, or empty server
  const name = joined.slice(i + 2);
  if (!name) return null; // empty name
  return { server: joined.slice(0, i), name };
}

/** Build the pill text (including `${` … `}`) to embed in a prompt template. */
export function encodeBindingPill(kind: BindingKind, server: string, name: string): string {
  return `\${${kind}:${joinServerName(server, name)}}`;
}

/**
 * Parse a pill BODY (the text between `${` and `}`), dual-reading the legacy tool scheme.
 * Returns null when the body is not a recognized binding (e.g. a `global:` var).
 */
export function parseBindingBody(body: string): ParsedBinding | null {
  const m = NEW_BODY.exec(body);
  if (m) {
    const kind = m[1] as BindingKind;
    const split = splitServerName(m[2]);
    return split ? { kind, server: split.server, name: split.name } : null;
  }
  if (body.startsWith(LEGACY_SEP)) {
    const parts = body.split(LEGACY_SEP);
    // ['', server, tool]
    if (parts.length === 3 && parts[1] && parts[2]) {
      return { kind: 'tool', server: parts[1], name: parts[2] };
    }
  }
  return null;
}

/** Parse a complete pill string (`${…}`). Returns null if it isn't a single pill. */
export function parsePill(full: string): ParsedBinding | null {
  if (full.startsWith('${') && full.endsWith('}')) {
    return parseBindingBody(full.slice(2, -1));
  }
  return null;
}

/** Find every binding pill in a block of text, in order. */
export function findBindings(text: string): BindingMatch[] {
  const out: BindingMatch[] = [];
  PILL_SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PILL_SCAN.exec(text)) !== null) {
    const parsed = parseBindingBody(m[1]);
    if (parsed) out.push({ ...parsed, fullMatch: m[0], index: m.index });
  }
  return out;
}

/**
 * Readable chip label for a parsed binding (no `${` … `}`), e.g. `tool:files__read`.
 * Handoff tools (pseudo-server `handoff`) are shown as `handoff:<node>` for clarity.
 */
export function bindingLabel(b: ParsedBinding): string {
  if (b.kind === 'tool' && b.server === 'handoff') {
    return `handoff:${b.name}`;
  }
  return `${b.kind}:${joinServerName(b.server, b.name)}`;
}

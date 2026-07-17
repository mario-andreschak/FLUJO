/**
 * Persistent key-value references (Tier 4 — cross-run state, `${kv:NAME}`).
 *
 * The read side of the persistent kv store. Direct analogue of
 * `resolveRunVars.ts` (`${var:NAME}`): a PURE, crypto-free map substitution that
 * runs in the browser (spec validation) and backend (ProcessNode/SubflowNode)
 * alike. The async disk read lives in the store (`services/kvStore`); the engine
 * loads a snapshot and passes it in here, keeping this resolver pure and total.
 *
 * Unlike `${var:NAME}` a kv reference may carry a scope prefix:
 *   - `NAME`         → default (flow FOLDER) board
 *   - `folder/NAME`  → the flow's folder board (explicit; same as default)
 *   - `flow/NAME`    → the per-flow board
 *   - `global/NAME`  → the instance-global board
 * The map passed to `resolveKvRefs` is keyed by the RAW token exactly as it
 * appears inside `${kv:...}` (trimmed), so mixed-scope references in one string
 * resolve correctly. `parseKvRef` splits a token into { scope, key } for the
 * engine that builds the map.
 *
 * `${kv:...}` is intentionally invisible to the MCP pill scanner (PILL_SCAN only
 * matches tool:/resource:/legacy bodies), so kv refs and tool pills never
 * interfere — same rule as `${var:}` / `${res:}`.
 */

/** The `${kv:NAME}` pattern. Body is everything up to the first `}`. */
export const KV_SCAN = /\$\{kv:([^}]+)\}/g;

/** Scope kinds a `${kv:...}` token may target. */
export const KV_SCOPE_KINDS = ['global', 'flow', 'folder'] as const;
export type KvRefScope = (typeof KV_SCOPE_KINDS)[number];

/** Default scope when a token carries no recognised prefix. */
export const DEFAULT_KV_SCOPE: KvRefScope = 'folder';

/**
 * Split a raw `${kv:...}` body into its scope and key. A leading
 * `global/`, `flow/` or `folder/` selects the board; anything else defaults to
 * the folder board with the whole (trimmed) token as the key.
 */
export function parseKvRef(raw: string): { scope: KvRefScope; key: string } {
  const token = (raw ?? '').trim();
  const slash = token.indexOf('/');
  if (slash > 0) {
    const prefix = token.slice(0, slash);
    if ((KV_SCOPE_KINDS as readonly string[]).includes(prefix)) {
      return { scope: prefix as KvRefScope, key: token.slice(slash + 1).trim() };
    }
  }
  return { scope: DEFAULT_KV_SCOPE, key: token };
}

/**
 * Replace every `${kv:NAME}` in `text` with `map[rawToken]`. An UNKNOWN token
 * resolves to '' (empty string), NOT the literal — mirrors resolveRunVars, so a
 * small model never parrots a raw `${kv:...}`. Pure and total: never throws.
 * `map` is keyed by the trimmed raw token (e.g. 'counter', 'global/counter').
 */
export function resolveKvRefs(text: string, map: Record<string, string> | undefined | null): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!KV_SCAN.test(text)) return text; // fast path
  const lookup = map ?? {};
  return text.replace(KV_SCAN, (_full, rawName: string) => {
    const token = rawName.trim();
    const value = lookup[token];
    if (typeof value === 'string') return value;
    console.warn(`[resolveKvRefs] unknown kv reference "${token}"; substituting empty string`);
    return '';
  });
}

/** True when `text` contains at least one `${kv:NAME}` reference. */
export function hasKvRef(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  KV_SCAN.lastIndex = 0;
  return KV_SCAN.test(text);
}

/** Every RAW token referenced by `${kv:...}` in `text`, de-duplicated, trimmed. */
export function referencedKvKeys(text: string | undefined | null): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = new Set<string>();
  KV_SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KV_SCAN.exec(text)) !== null) {
    const token = m[1].trim();
    if (token) tokens.add(token);
  }
  return [...tokens];
}

/** A syntactically valid kv KEY (sane identifier; no scope prefix / slash). */
export const KV_NAME_RE = /^[A-Za-z_][\w-]*$/;

/** True when `name` is a sane kv key identifier. */
export function isValidKvName(name: unknown): name is string {
  return typeof name === 'string' && KV_NAME_RE.test(name);
}

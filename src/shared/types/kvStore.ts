/**
 * Persistent (cross-run) key-value store — Tier 4 state (`${kv:NAME}`).
 *
 * The missing companion to the run-scoped `${var:NAME}` (Tier 2c) and run
 * resources (Tier 3): a small, engine-managed store of plain scalar strings
 * that SURVIVES ACROSS FLOW RUNS. Long-lived scheduled/agent flows use it to
 * carry loop counters, pagination cursors, rate-limit stamps and flags between
 * pulses without smuggling that state through the filesystem or memory MCP
 * servers (which force a model round-trip per read/write and are the wrong
 * shape for simple scalars).
 *
 * Scope model (resolved by the engine at the node render/capture point):
 *   - `${kv:NAME}`         → the flow's FOLDER board (falls back to a per-flow
 *                            board when the flow has no folder). A "package" of
 *                            related flows in one folder shares a board.
 *   - `${kv:flow/NAME}`    → an explicit per-flow board (keyed by flow id).
 *   - `${kv:global/NAME}`  → the instance-global board, shared by everything.
 * The internal `flujo` MCP tools (`kv_get`/`kv_set`) operate on the `global`
 * board by default (they have no flow context) and accept an explicit scope id.
 *
 * SECURITY: kv values are PLAINTEXT and NEVER secrets. Like `${var:NAME}`, they
 * are resolved by a pure, crypto-free resolver (`resolveKvRefs`) and must NOT be
 * routed through `resolveGlobalVars` (server-only, decrypting — for `${global:}`
 * API keys). Secrets stay in `${global:}` / encrypted env vars.
 *
 * Shared (browser + backend) so the frontend can render entries; only the store
 * implementation (`services/kvStore`) is backend-only.
 */

/** A concrete kv board id on disk (already resolved from a scope kind). */
export type KvScopeId = string;

export interface KvEntry {
  /** Resolved board id this entry lives on (e.g. 'global', 'flow-<id>'). */
  scope: KvScopeId;
  /** Key within the board (a sane identifier — see isValidKvName). */
  name: string;
  /** Plain string value. */
  value: string;
  /** Byte length of `value` (utf8). */
  size: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Reserved for optional TTL. v1 stores it but does NOT sweep; a later version
   * can add lazy expiry-on-read. Undefined means "never expires".
   */
  expiresAt?: number;
}

export interface KvStoreSettings {
  /** Master switch. When false, reads resolve to '' and writes are skipped. */
  enabled: boolean;
  /** Per-value byte cap; larger writes are refused (returns a skip marker). */
  maxValueBytes: number;
  /** Max number of keys per board; writes beyond it are refused. */
  maxKeysPerScope: number;
  /** Total byte budget per board (sum of value sizes); writes beyond it refused. */
  maxScopeBytes: number;
}

export const DEFAULT_KV_STORE_SETTINGS: KvStoreSettings = {
  enabled: true,
  maxValueBytes: 64 * 1024,
  maxKeysPerScope: 512,
  maxScopeBytes: 8 * 1024 * 1024,
};

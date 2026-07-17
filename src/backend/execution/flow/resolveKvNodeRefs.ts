import { createHash } from 'crypto';
import { createLogger } from '@/utils/logger';
import {
  referencedKvKeys,
  resolveKvRefs,
  parseKvRef,
  isValidKvName,
  type KvRefScope,
} from '@/utils/shared/resolveKvRefs';
import { kvGet, kvSet, type KvSetResult } from '@/backend/services/kvStore';

/**
 * `${kv:NAME}` — inject a PERSISTENT (cross-run) value into prompt text, and the
 * `captureKv` write side. This is the backend glue between the pure resolver
 * (`resolveKvRefs`, which does map substitution) and the disk-backed store
 * (`services/kvStore`), mirroring how `resolveRunResourceRefs` bridges
 * `${res:NAME}` to the run-resource store.
 *
 * Scope resolution needs the flow context (its id + folder), which only the
 * engine has — the node passes it in. `${kv:NAME}` defaults to the flow's
 * FOLDER board; a `folder/`, `flow/` or `global/` prefix selects explicitly.
 * The board id fed to the store is always SAFE_ID-shaped (uuid flow id or a
 * hash of the folder string), so an arbitrary user folder name can never escape
 * the store directory.
 */

const log = createLogger('backend/flow/execution/resolveKvNodeRefs');

export interface KvFlowContext {
  flowId?: string;
  /** The flow's optional user-assigned folder (Flow.folder). */
  folder?: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Resolve a scope KIND (+ flow context) to a concrete, SAFE_ID board id. */
export function kvScopeId(scope: KvRefScope, ctx: KvFlowContext): string {
  if (scope === 'global') return 'global';

  const flowBoard = () => {
    const id = ctx.flowId;
    return id && SAFE_ID.test(id) ? `flow-${id}` : 'global';
  };

  if (scope === 'flow') return flowBoard();

  // folder (default): a package of flows sharing one folder shares a board.
  const folder = ctx.folder?.trim();
  if (folder) {
    const hash = createHash('sha256').update(folder).digest('hex').slice(0, 32);
    return `folder-${hash}`;
  }
  // No folder → fall back to the per-flow board so `${kv:NAME}` still works.
  return flowBoard();
}

/**
 * Resolve every `${kv:...}` in `text` against the store for `ctx`. Loads only
 * the referenced keys (grouped by scope), then does a pure substitution.
 * Unknown/invalid references resolve to '' — total, never throws, never blocks a
 * run. Cheap no-op when the text has no `${kv:` at all.
 */
export async function resolveKvNodeRefs(text: string, ctx: KvFlowContext): Promise<string> {
  if (typeof text !== 'string' || !text.includes('${kv:')) return text;
  const tokens = referencedKvKeys(text);
  const map: Record<string, string> = {};
  for (const token of tokens) {
    const { scope, key } = parseKvRef(token);
    if (!isValidKvName(key)) {
      log.warn(`\${kv:${token}} has an invalid key; resolving to ''`);
      map[token] = '';
      continue;
    }
    try {
      const value = await kvGet(kvScopeId(scope, ctx), key);
      map[token] = value ?? '';
    } catch (error) {
      log.error(`Failed to resolve \${kv:${token}}; resolving to ''`, error);
      map[token] = '';
    }
  }
  return resolveKvRefs(text, map);
}

export type CaptureKvResult = KvSetResult | { skipped: 'invalid-name' };

/**
 * The write side of `captureKv: "NAME"` (or `"folder/NAME"`, `"flow/NAME"`,
 * `"global/NAME"`). Persists `value` to the resolved board. Never throws; a bad
 * name / cap refusal comes back as a `{ skipped }` marker the caller logs.
 */
export async function captureKvValue(
  captureToken: string,
  value: string,
  ctx: KvFlowContext
): Promise<CaptureKvResult> {
  const { scope, key } = parseKvRef(captureToken);
  if (!isValidKvName(key)) return { skipped: 'invalid-name' };
  return kvSet(kvScopeId(scope, ctx), key, value ?? '');
}

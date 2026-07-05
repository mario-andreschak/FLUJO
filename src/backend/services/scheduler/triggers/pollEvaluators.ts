import { createHash } from 'crypto';
import { PlannedExecutionState } from '@/shared/types/plannedExecution';

/**
 * Pure evaluation logic for MCP polling triggers: given a tool result and the
 * persisted trigger state, decide whether to fire and what the next state is.
 * Kept free of I/O so the semantics (priming, dedup across restarts, caps)
 * are unit-testable.
 */

/** Cap the remembered ids so an ever-growing feed can't grow state unboundedly. */
const MAX_SEEN_IDS = 1000;
/** Cap how many new items are handed to the flow in one fire. */
const MAX_NEW_ITEMS = 50;
/** Cap the serialized result embedded into a fire's context. */
const MAX_CONTEXT_CHARS = 8192;

export interface PollEvaluation {
  fire: boolean;
  /** Context for the run prompt when firing. */
  context?: unknown;
  /** Sticky summary for the RunRecord when firing. */
  summary?: string;
  /** State fields to persist (merged over the existing state). */
  newState: Partial<PlannedExecutionState>;
  /** Configuration-level problem (e.g. itemsPath doesn't resolve to a list). */
  error?: string;
}

/** JSON.stringify with recursively sorted object keys (deterministic). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      result[key] = sortKeys(entryValue);
    }
    return result;
  }
  return value;
}

export function hashResult(value: unknown): string {
  return createHash('sha256').update(stableStringify(value) ?? 'undefined').digest('hex');
}

/** Resolve a dot path ('a.b.0.c'; '' = the value itself) into a value. */
export function getPath(value: unknown, dotPath: string): unknown {
  if (!dotPath) {
    return value;
  }
  let current: unknown = value;
  for (const segment of dotPath.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Shrink a result for prompt context: full when small, labeled preview when big. */
export function capForContext(value: unknown): unknown {
  const serialized = stableStringify(value) ?? '';
  if (serialized.length <= MAX_CONTEXT_CHARS) {
    return value;
  }
  return {
    truncated: true,
    note: `Result too large to include fully (${serialized.length} chars); this is a preview.`,
    preview: serialized.slice(0, MAX_CONTEXT_CHARS),
  };
}

/** Fire whenever the (normalized) result differs from the last poll. */
export function evaluateOnChange(
  result: unknown,
  state: PlannedExecutionState
): PollEvaluation {
  const hash = hashResult(result);
  if (!state.lastHash) {
    // First poll primes the baseline without firing.
    return { fire: false, newState: { lastHash: hash } };
  }
  if (state.lastHash === hash) {
    return { fire: false, newState: {} };
  }
  return {
    fire: true,
    summary: 'Tool result changed',
    context: { result: capForContext(result) },
    newState: { lastHash: hash },
  };
}

/**
 * Fire when items with unseen ids appear in the list at `itemsPath`.
 * Items without a usable id fall back to a content hash, so id-less feeds
 * still dedup correctly.
 */
export function evaluateNewItems(
  result: unknown,
  itemsPath: string,
  idField: string,
  state: PlannedExecutionState
): PollEvaluation {
  const items = getPath(result, itemsPath);
  if (!Array.isArray(items)) {
    return {
      fire: false,
      newState: {},
      error: `"${itemsPath || '(root)'}" did not resolve to a list in the tool result`,
    };
  }

  const withIds = items.map(item => {
    const raw = getPath(item, idField);
    const id =
      raw === null || raw === undefined || typeof raw === 'object'
        ? `hash:${hashResult(item)}`
        : String(raw);
    return { id, item };
  });

  const seen = state.seenIds;
  const mergeSeen = (previous: string[] | undefined): string[] => {
    const merged = [...(previous ?? [])];
    const known = new Set(merged);
    for (const { id } of withIds) {
      if (!known.has(id)) {
        known.add(id);
        merged.push(id);
      }
    }
    return merged.slice(-MAX_SEEN_IDS);
  };

  if (!seen) {
    // First poll primes the seen-set without firing.
    return { fire: false, newState: { seenIds: mergeSeen(undefined) } };
  }

  const knownIds = new Set(seen);
  const fresh = withIds.filter(({ id }) => !knownIds.has(id));
  if (fresh.length === 0) {
    return { fire: false, newState: {} };
  }
  return {
    fire: true,
    summary: fresh.length === 1 ? '1 new item' : `${fresh.length} new items`,
    context: {
      newItems: capForContext(fresh.slice(0, MAX_NEW_ITEMS).map(({ item }) => item)),
      ...(fresh.length > MAX_NEW_ITEMS ? { omitted: fresh.length - MAX_NEW_ITEMS } : {}),
    },
    newState: { seenIds: mergeSeen(seen) },
  };
}

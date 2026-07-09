import { createHash } from 'crypto';
import { PlannedExecutionState, RunRecordStatus } from '@/shared/types/plannedExecution';

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

/**
 * Commit-after-success (issue #75): after this many consecutive fired-but-not
 * -completed deliveries of the SAME detected change, give up and advance the
 * baseline anyway (surfacing a trigger error) so a change that reliably breaks
 * the flow can't re-fire forever.
 */
export const MAX_PENDING_DELIVERY_FAILURES = 3;

export interface PollEvaluation {
  fire: boolean;
  /** Context for the run prompt when firing. */
  context?: unknown;
  /** Sticky summary for the RunRecord when firing. */
  summary?: string;
  /**
   * State fields to persist IMMEDIATELY (merged over the existing state),
   * regardless of any fired run's outcome: priming baselines, no-change
   * bookkeeping, and gate budget counters.
   */
  newState: Partial<PlannedExecutionState>;
  /**
   * Baseline advance to persist ONLY after a fired run COMPLETES successfully
   * (issue #75). Present only when `fire` is true and the change should be
   * retried until it's actually processed (on-change hash / new-items ids).
   * The caller holds this pending and commits it on success — or, after
   * MAX_PENDING_DELIVERY_FAILURES failures, commits it to stop a re-fire loop.
   */
  pendingState?: Partial<PlannedExecutionState>;
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

/**
 * Commit-after-success baseline transition, shared by mcp-poll and url-watch
 * (issue #75). Given a fired run's outcome and the baseline advance that was
 * held pending, decide what to persist:
 *   - completed  → advance the baseline and clear the failure counter.
 *   - skipped    → overlap (the run was never attempted): change nothing, so
 *                  the next poll re-fires the still-unprocessed change. Does
 *                  NOT count toward the retry cap.
 *   - error/etc. → leave the baseline unadvanced and bump the failure counter
 *                  so the change is retried; after MAX_PENDING_DELIVERY_FAILURES
 *                  consecutive failures, advance the baseline anyway (dropping
 *                  the change) and surface a trigger error, so a change that
 *                  reliably breaks the flow can't re-fire forever.
 * Returns a human-readable trigger error when the retry cap is hit, else null.
 */
export async function commitPendingAfterOutcome(params: {
  status: RunRecordStatus;
  pendingState: Partial<PlannedExecutionState>;
  priorFailures: number;
  saveState: (patch: Partial<PlannedExecutionState>) => Promise<void>;
}): Promise<{ giveUpError: string | null }> {
  const { status, pendingState, priorFailures, saveState } = params;
  if (status === 'completed') {
    await saveState({ ...pendingState, ...(priorFailures > 0 ? { pendingFailures: 0 } : {}) });
    return { giveUpError: null };
  }
  if (status === 'skipped') {
    // Overlap: nothing consumed, nothing failed. Retry on the next poll.
    return { giveUpError: null };
  }
  // A genuine processing failure (error/crash): retry, but bounded.
  const failures = priorFailures + 1;
  if (failures >= MAX_PENDING_DELIVERY_FAILURES) {
    await saveState({ ...pendingState, pendingFailures: 0 });
    return {
      giveUpError: `Detected a change but the flow failed to process it ${MAX_PENDING_DELIVERY_FAILURES}× — skipping it to avoid a loop`,
    };
  }
  await saveState({ pendingFailures: failures });
  return { giveUpError: null };
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
    // Hold the new hash pending: advance the baseline only once a fired run
    // actually processes this change (commit-after-success, issue #75).
    newState: {},
    pendingState: { lastHash: hash },
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
    // Hold the freshly-seen ids pending: only remember them once a fired run
    // actually processes them, so a skipped/failed run retries them (#75).
    newState: {},
    pendingState: { seenIds: mergeSeen(seen) },
  };
}

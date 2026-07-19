/**
 * Live lane-row model for parallel subflow fan-outs (issue #157).
 *
 * Chat's SSE consumer folds lane-stamped execution events (laneIndex/laneCount,
 * issue #102) into this structure; LiveRunIndicator renders it as one progress
 * row per lane. Pure data + pure reducer — kept in utils/shared so the lane
 * logic is unit-testable (node-env Jest) and stays out of the component.
 *
 * Depth semantics: lane rows are created ONLY from subflow:start at depth 1.
 * The emit wrappers compose by stamping `{...raw, depth, ...laneFields}`, so a
 * grandchild lane's events arrive with the PARENT lane's index at depth ≥ 2 —
 * those may only animate the owning lane's activity text, never create or
 * terminate rows. Accepted limitation of the same overwrite semantics: a
 * fan-out nested inside a single-child subflow keeps its own laneIndex but
 * arrives at depth 2 (byte-identical to grandchild events), so it degrades to
 * activity-text updates with no rows of its own.
 */

import type { ExecutionEvent } from '@/shared/types/execution/events';

export interface LiveLane {
  laneIndex: number;
  laneCount: number;
  /** Brief / map item title (backend falls back to the subflow name). */
  label: string;
  /** The lane's persisted sidebar conversation, when saveConversation is on. */
  laneConversationId?: string;
  /** pending = known from laneCount but not yet started (bounded worker pool). */
  status: 'pending' | 'running' | 'completed' | 'error';
  /** Current node/tool inside the lane, shown as secondary text while running. */
  activity?: string;
  lastEventAt: number;
}

export interface LiveLanes {
  /** The parallel SubflowNode these rows belong to. A depth-1 subflow:start
   *  from a DIFFERENT node means a second fan-out started in the same run —
   *  all rows are cleared so sequential fan-outs never collide on laneIndex. */
  ownerNodeId?: string;
  byIndex: Record<number, LiveLane>;
}

export const EMPTY_LIVE_LANES: LiveLanes = { byIndex: {} };

export function hasLanes(lanes: LiveLanes): boolean {
  for (const _ in lanes.byIndex) return true;
  return false;
}

export function laneList(lanes: LiveLanes): LiveLane[] {
  return Object.values(lanes.byIndex).sort((a, b) => a.laneIndex - b.laneIndex);
}

function fallbackLabel(event: { subflowName?: string; subflowId?: string }, index: number, count: number): string {
  const name = event.subflowName || event.subflowId;
  return name ? `${name} ${index + 1}/${count}` : `Lane ${index + 1}/${count}`;
}

/** Derive the lane's activity text the same way the single-run view derives
 *  activeNode. Returns undefined for events that carry no activity signal. */
function deriveActivity(event: ExecutionEvent): string | undefined {
  switch (event.type) {
    case 'node:enter':
      return event.node?.nodeName || event.node?.nodeId || undefined;
    case 'tool:call':
      return event.name;
    case 'tool:progress':
      return event.message ? `${event.name} — ${event.message}` : event.name;
    case 'subflow:start':
      return `↳ ${event.subflowName || event.subflowId}`;
    case 'handoff':
      return `→ ${event.toNodeId}`;
    default:
      return undefined;
  }
}

/** Every lane event carries laneCount, and lane indices are dense 0..n-1 for
 *  all three lane kinds — so the expected pool size is known from the FIRST
 *  lane event. Pre-create missing rows as `pending` ("queued"): the bounded
 *  worker pool (and the sequential-spawn path) starts lanes staggered, and
 *  rows-only-on-start would misrepresent a fan-out whose size is known. */
function ensureRows(byIndex: Record<number, LiveLane>, laneCount: number, now: number): void {
  for (let i = 0; i < laneCount; i++) {
    if (!byIndex[i]) {
      byIndex[i] = {
        laneIndex: i,
        laneCount,
        label: `Lane ${i + 1}/${laneCount}`,
        status: 'pending',
        lastEventAt: now,
      };
    }
  }
}

/**
 * Fold one lane-stamped event into the lane state. Returns `prev` unchanged
 * (same reference) when nothing applies, so callers can setState without
 * spurious re-renders (model:delta et al. carry no activity signal).
 */
export function applyLaneEvent(prev: LiveLanes, event: ExecutionEvent, now: number = Date.now()): LiveLanes {
  const index = event.laneIndex;
  const count = event.laneCount;
  if (index == null || count == null) return prev;

  const boundaryAtLaneDepth =
    (event.type === 'subflow:start' || event.type === 'subflow:done') && event.depth === 1;

  if (boundaryAtLaneDepth && event.type === 'subflow:start') {
    const ownerNodeId = event.node?.nodeId;
    // Fan-out-group switch: a depth-1 start from a different parallel node
    // means the previous fan-out's rows are stale — drop them wholesale.
    const sameOwner = !prev.ownerNodeId || !ownerNodeId || prev.ownerNodeId === ownerNodeId;
    const byIndex = sameOwner ? { ...prev.byIndex } : {};
    ensureRows(byIndex, count, now);
    byIndex[index] = {
      laneIndex: index,
      laneCount: count,
      label: event.laneTitle || fallbackLabel(event, index, count),
      laneConversationId: event.laneConversationId ?? byIndex[index]?.laneConversationId,
      status: 'running',
      lastEventAt: now,
    };
    return { ownerNodeId: ownerNodeId ?? prev.ownerNodeId, byIndex };
  }

  if (boundaryAtLaneDepth && event.type === 'subflow:done') {
    const byIndex = { ...prev.byIndex };
    ensureRows(byIndex, count, now);
    const row = byIndex[index];
    byIndex[index] = {
      ...row,
      // Backfill label/link for a late-joining client that missed start.
      label: row.label && row.status !== 'pending' ? row.label : event.laneTitle || row.label,
      laneConversationId: row.laneConversationId ?? event.laneConversationId,
      status: event.status,
      activity: undefined,
      lastEventAt: now,
    };
    return { ownerNodeId: prev.ownerNodeId ?? event.node?.nodeId, byIndex };
  }

  // Everything else — any lane event at any depth, including subflow:* at
  // depth ≥ 2 (grandchild lanes carry the PARENT's index by construction) —
  // may only update the owning lane's activity text.
  const activity = deriveActivity(event);
  if (activity === undefined) return prev;
  const existing = prev.byIndex[index];
  if (existing && existing.activity === activity && existing.status !== 'pending') return prev;
  // Terminal rows stay terminal: a straggler grandchild event must not make a
  // finished lane look busy again.
  if (existing && (existing.status === 'completed' || existing.status === 'error')) return prev;
  const byIndex = { ...prev.byIndex };
  ensureRows(byIndex, count, now);
  const row = byIndex[index];
  byIndex[index] = {
    ...row,
    // Activity implies the lane is live even if its start was missed.
    status: row.status === 'pending' ? 'running' : row.status,
    activity,
    lastEventAt: now,
  };
  return { ownerNodeId: prev.ownerNodeId, byIndex };
}

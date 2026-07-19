/**
 * Tests for the live lane-row reducer (issue #157).
 *
 * Pins the lane-state contract the Chat SSE consumer relies on: pending
 * pre-creation from laneCount, row lifecycle from depth-1 subflow boundaries,
 * activity-only updates for everything else (including the nested-lane guard:
 * subflow:* at depth ≥ 2 carries the PARENT's laneIndex by construction and
 * must never create or terminate rows), the fan-out-group switch keyed on the
 * owning node, and reference-stability (no spurious re-renders).
 */

import { applyLaneEvent, EMPTY_LIVE_LANES, laneList, hasLanes, LiveLanes } from '@/utils/shared/liveLanes';
import type { ExecutionEvent } from '@/shared/types/execution/events';

const NOW = 1_000;

function ev(partial: Record<string, unknown>): ExecutionEvent {
  return {
    conversationId: 'conv-parent',
    seq: 1,
    timestamp: NOW,
    ...partial,
  } as unknown as ExecutionEvent;
}

const laneStart = (index: number, count: number, extra: Record<string, unknown> = {}) =>
  ev({
    type: 'subflow:start',
    depth: 1,
    laneIndex: index,
    laneCount: count,
    subflowId: 'child-flow',
    subflowName: 'worker',
    node: { nodeId: 'fanout-node' },
    laneTitle: `Brief ${index}`,
    laneConversationId: `lane-conv-${index}`,
    ...extra,
  });

const laneDone = (index: number, count: number, status: 'completed' | 'error', extra: Record<string, unknown> = {}) =>
  ev({
    type: 'subflow:done',
    depth: 1,
    laneIndex: index,
    laneCount: count,
    subflowId: 'child-flow',
    status,
    node: { nodeId: 'fanout-node' },
    laneTitle: `Brief ${index}`,
    laneConversationId: `lane-conv-${index}`,
    ...extra,
  });

describe('applyLaneEvent (issue #157)', () => {
  it('pre-creates pending rows for the whole pool from the first lane event', () => {
    const lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 3), NOW);
    const rows = laneList(lanes);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ laneIndex: 0, status: 'running', label: 'Brief 0', laneConversationId: 'lane-conv-0' });
    expect(rows[1].status).toBe('pending');
    expect(rows[2].status).toBe('pending');
    expect(lanes.ownerNodeId).toBe('fanout-node');
  });

  it('subflow:done sets terminal status and clears activity', () => {
    let lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 2), NOW);
    lanes = applyLaneEvent(lanes, laneDone(0, 2, 'error'), NOW + 1);
    expect(lanes.byIndex[0].status).toBe('error');
    expect(lanes.byIndex[0].activity).toBeUndefined();
  });

  it('subflow:done backfills label and conversation id for a late-joining client that missed start', () => {
    const lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneDone(1, 2, 'completed'), NOW);
    expect(lanes.byIndex[1]).toMatchObject({
      status: 'completed',
      label: 'Brief 1',
      laneConversationId: 'lane-conv-1',
    });
    // The rest of the pool is still visible as pending.
    expect(lanes.byIndex[0].status).toBe('pending');
  });

  it('activity events update the owning lane and promote pending to running', () => {
    let lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 2), NOW);
    lanes = applyLaneEvent(
      lanes,
      ev({ type: 'tool:call', laneIndex: 1, laneCount: 2, toolCallId: 't1', name: 'search' }),
      NOW + 1,
    );
    expect(lanes.byIndex[1]).toMatchObject({ status: 'running', activity: 'search' });
    lanes = applyLaneEvent(
      lanes,
      ev({ type: 'node:enter', laneIndex: 0, laneCount: 2, node: { nodeId: 'n1', nodeName: 'Research' } }),
      NOW + 2,
    );
    expect(lanes.byIndex[0].activity).toBe('Research');
    expect(lanes.byIndex[0].label).toBe('Brief 0'); // label untouched by activity
  });

  it('nested guard: subflow:* at depth ≥ 2 (grandchild lanes carry the parent lane index) only animates activity', () => {
    let lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 2), NOW);
    // Grandchild fan-out inside lane 0: arrives at depth 2 stamped with the
    // PARENT's laneIndex (wrapper-composition overwrite). Also pins the
    // accepted limitation for a fan-out wrapped in a single-child subflow.
    lanes = applyLaneEvent(
      lanes,
      ev({
        type: 'subflow:start',
        depth: 2,
        laneIndex: 0,
        laneCount: 2,
        subflowId: 'grandchild',
        subflowName: 'inner',
        node: { nodeId: 'inner-fanout-node' },
        laneTitle: 'Inner brief',
      }),
      NOW + 1,
    );
    expect(lanes.byIndex[0]).toMatchObject({ status: 'running', label: 'Brief 0', activity: '↳ inner' });
    expect(laneList(lanes)).toHaveLength(2); // no new rows, no group switch
    expect(lanes.ownerNodeId).toBe('fanout-node');

    // A grandchild's subflow:done must not terminate the parent lane's row.
    lanes = applyLaneEvent(
      lanes,
      ev({ type: 'subflow:done', depth: 2, laneIndex: 0, laneCount: 2, subflowId: 'grandchild', status: 'error' }),
      NOW + 2,
    );
    expect(lanes.byIndex[0].status).toBe('running');
  });

  it('fan-out-group switch: a depth-1 start from a different node clears the previous rows', () => {
    let lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 3), NOW);
    lanes = applyLaneEvent(lanes, laneDone(0, 3, 'completed'), NOW + 1);
    lanes = applyLaneEvent(
      lanes,
      laneStart(0, 2, { node: { nodeId: 'second-fanout-node' }, laneTitle: 'Second 0' }),
      NOW + 2,
    );
    const rows = laneList(lanes);
    expect(rows).toHaveLength(2); // stale 3-lane block dropped wholesale
    expect(rows[0]).toMatchObject({ label: 'Second 0', status: 'running' });
    expect(rows[1].status).toBe('pending');
    expect(lanes.ownerNodeId).toBe('second-fanout-node');
  });

  it('terminal rows stay terminal under straggler activity', () => {
    let lanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 1), NOW);
    lanes = applyLaneEvent(lanes, laneDone(0, 1, 'completed'), NOW + 1);
    const after = applyLaneEvent(
      lanes,
      ev({ type: 'tool:call', laneIndex: 0, laneCount: 1, toolCallId: 't', name: 'late' }),
      NOW + 2,
    );
    expect(after).toBe(lanes); // same reference: nothing applied
    expect(after.byIndex[0].status).toBe('completed');
  });

  it('returns prev unchanged for events with no lane or no activity signal', () => {
    const seeded = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 2), NOW);
    // Non-lane event.
    expect(applyLaneEvent(seeded, ev({ type: 'node:enter', node: { nodeId: 'x' } }), NOW + 1)).toBe(seeded);
    // Lane event with no activity derivation (streaming deltas).
    expect(
      applyLaneEvent(seeded, ev({ type: 'model:delta', laneIndex: 0, laneCount: 2, delta: 'x' }), NOW + 1),
    ).toBe(seeded);
    // Same activity twice → same reference.
    const a = applyLaneEvent(
      seeded,
      ev({ type: 'tool:call', laneIndex: 0, laneCount: 2, toolCallId: 't', name: 'grep' }),
      NOW + 1,
    );
    const b = applyLaneEvent(
      a,
      ev({ type: 'tool:call', laneIndex: 0, laneCount: 2, toolCallId: 't2', name: 'grep' }),
      NOW + 2,
    );
    expect(b).toBe(a);
  });

  it('hasLanes distinguishes empty from populated state', () => {
    expect(hasLanes(EMPTY_LIVE_LANES)).toBe(false);
    const lanes: LiveLanes = applyLaneEvent(EMPTY_LIVE_LANES, laneStart(0, 1), NOW);
    expect(hasLanes(lanes)).toBe(true);
  });

  it('falls back to subflow name for the label when no laneTitle is present', () => {
    const lanes = applyLaneEvent(
      EMPTY_LIVE_LANES,
      laneStart(1, 3, { laneTitle: undefined, laneConversationId: undefined }),
      NOW,
    );
    expect(lanes.byIndex[1].label).toBe('worker 2/3');
    expect(lanes.byIndex[1].laneConversationId).toBeUndefined();
  });
});

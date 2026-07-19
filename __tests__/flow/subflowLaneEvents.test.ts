/**
 * Tests for the lane-identity event contract (issue #157).
 *
 * runFlow and the flow service are mocked (same harness as the #102 parallel
 * tests). Pinned here: the synthesized subflow:start / subflow:done carry
 * laneTitle + laneConversationId (and ONLY those two events do — forwarded
 * events stay {laneIndex, laneCount}); the lane's runFlow call receives the
 * SAME pre-generated conversationId and the title falls back to the subflow
 * name for static fan-out lanes; saveConversation: false suppresses the id;
 * and a lane whose runFlow THROWS still yields a synthetic error subflow:done.
 */

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...a: unknown[]) => runFlowMock(...a),
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: `flow-${id}` })) },
}));

import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import type { SharedState, SubflowNodeParams } from '@/backend/execution/flow/types';

function makeShared(overrides: Record<string, unknown> = {}): SharedState {
  return {
    conversationId: 'conv-1',
    runDepth: 0,
    messages: [],
    trackingInfo: { nodeExecutionTracker: [] },
    ...overrides,
  } as unknown as SharedState;
}

function makeParams(properties: Record<string, unknown>): SubflowNodeParams {
  return {
    id: 'sub-1',
    type: 'subflow',
    properties: { promptTemplate: 'GO', ...properties },
  } as unknown as SubflowNodeParams;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

/** A well-behaved child: emits its run boundaries and succeeds. */
function respondingChild() {
  runFlowMock.mockImplementation(
    async ({ flowId, emit }: { flowId: string; emit?: (e: Record<string, unknown>) => void }) => {
      emit?.({ type: 'run:start', flowId });
      emit?.({ type: 'message', message: { role: 'assistant', content: `m-${flowId}`, id: 'x', timestamp: 1 } });
      emit?.({ type: 'run:done', status: 'completed' });
      return { status: 'completed', outputText: `OUT_${flowId}` };
    },
  );
}

beforeEach(() => {
  runFlowMock.mockReset();
});

describe('lane identity on subflow boundary events (issue #157)', () => {
  it('stamps laneTitle (subflow-name fallback) + laneConversationId on start/done, and matches the runFlow input', async () => {
    respondingChild();

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(shared, makeParams({ parallelSubflowIds: ['a', 'b'], concurrencyLimit: 2 }));
    await node.execCore(prep);

    const starts = events.filter((e) => e.type === 'subflow:start');
    const dones = events.filter((e) => e.type === 'subflow:done');
    expect(starts).toHaveLength(2);
    expect(dones).toHaveLength(2);

    for (const boundary of [...starts, ...dones]) {
      // Static fan-out lanes have no brief → the flow name labels the lane.
      expect(boundary.laneTitle).toMatch(/^flow-(a|b)$/);
      expect(typeof boundary.laneConversationId).toBe('string');
    }
    // start and done of the same lane agree on the identity fields.
    for (const start of starts) {
      const done = dones.find((d) => d.laneIndex === start.laneIndex)!;
      expect(done.laneConversationId).toBe(start.laneConversationId);
      expect(done.laneTitle).toBe(start.laneTitle);
    }
    // Distinct lanes → distinct conversations.
    expect(new Set(starts.map((e) => e.laneConversationId)).size).toBe(2);

    // The runFlow call for each lane received the SAME pre-generated id and
    // the fallback title — this is what makes the live-view deep-link land on
    // the lane's persisted sidebar conversation.
    const inputs = runFlowMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    for (const start of starts) {
      const input = inputs.find((i) => i.conversationId === start.laneConversationId)!;
      expect(input).toBeDefined();
      expect(input.mode).toBe('conversation');
      expect(input.title).toBe(start.laneTitle);
    }
  });

  it('keeps identity OFF the forwarded per-event stream (lane fields only)', async () => {
    respondingChild();

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(shared, makeParams({ parallelSubflowIds: ['a', 'b'], concurrencyLimit: 2 }));
    await node.execCore(prep);

    const msgs = events.filter((e) => e.type === 'message');
    expect(msgs.length).toBeGreaterThan(0);
    for (const msg of msgs) {
      expect(typeof msg.laneIndex).toBe('number'); // separability preserved
      expect(msg.laneTitle).toBeUndefined();
      expect(msg.laneConversationId).toBeUndefined();
    }
  });

  it('saveConversation: false → ephemeral lanes, no laneConversationId, no caller-supplied id', async () => {
    respondingChild();

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(
      shared,
      makeParams({ parallelSubflowIds: ['a', 'b'], concurrencyLimit: 2, saveConversation: false }),
    );
    await node.execCore(prep);

    const boundaries = events.filter((e) => e.type === 'subflow:start' || e.type === 'subflow:done');
    expect(boundaries.length).toBe(4);
    expect(boundaries.every((e) => e.laneConversationId === undefined)).toBe(true);
    // Labels still flow (the live view needs them regardless of persistence).
    expect(boundaries.every((e) => typeof e.laneTitle === 'string')).toBe(true);

    const inputs = runFlowMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(inputs.every((i) => i.mode === 'ephemeral' && i.conversationId === undefined)).toBe(true);
  });

  it('a lane whose runFlow THROWS still emits a synthetic subflow:done with status error', async () => {
    runFlowMock.mockImplementation(
      async ({ flowId, emit }: { flowId: string; emit?: (e: Record<string, unknown>) => void }) => {
        emit?.({ type: 'run:start', flowId });
        if (flowId === 'b') {
          // Crash BEFORE the child could emit run:done — without the synthetic
          // event this lane's live-view row would spin until run end.
          throw new Error('socket hang up');
        }
        emit?.({ type: 'run:done', status: 'completed' });
        return { status: 'completed', outputText: `OUT_${flowId}` };
      },
    );

    const events: Array<Record<string, unknown>> = [];
    const node = makeNode();
    const shared = makeShared({ emit: (e: Record<string, unknown>) => events.push(e) });
    const prep = await node.prep(
      shared,
      makeParams({ parallelSubflowIds: ['a', 'b'], concurrencyLimit: 2, errorStrategy: 'collect-all' }),
    );
    const exec = await node.execCore(prep);

    expect(exec.success).toBe(true); // collect-all: partial success
    const dones = events.filter((e) => e.type === 'subflow:done');
    expect(dones).toHaveLength(2); // one real, one synthetic
    const failed = dones.find((e) => e.status === 'error')!;
    expect(failed).toBeDefined();
    expect(typeof failed.laneIndex).toBe('number');
    expect(typeof failed.laneConversationId).toBe('string'); // identity survives the crash
    // No raw run:done leaked while synthesizing.
    expect(events.some((e) => e.type === 'run:done')).toBe(false);
  });
});

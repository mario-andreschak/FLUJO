/**
 * Signal node (issue #117): deterministic in-flow event emission.
 *
 * Pins the node contract:
 *  - on traversal it publishes exactly ONE FlowSignalEvent onto the process-global
 *    bus, with the payload template resolved through run variables (${var:NAME});
 *  - it is TRANSPARENT: it never mutates the conversation and always returns its
 *    first successor action (pass-through), so it is safe to drop inline;
 *  - it stamps the EMITTING run's chainDepth onto the event (loop safety);
 *  - it fires even inside a subflow (runDepth > 0), unlike completion events;
 *  - with no topic it emits nothing but still passes through.
 */
import { SignalNode } from '@/backend/execution/flow/nodes/SignalNode';
import {
  getFlowRunEventBus,
  FlowEvent,
  FlowSignalEvent,
  isFlowSignalEvent,
} from '@/backend/services/scheduler/flowRunEventBus';
import type { SharedState, SignalNodeParams } from '@/backend/execution/flow/types';

function makeState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'e', startTime: 0, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-emitter',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as SharedState;
}

const params = (properties: Record<string, unknown>): SignalNodeParams => ({
  id: 'sig',
  label: 'Signal',
  type: 'signal',
  properties: properties as SignalNodeParams['properties'],
});

/** Build a SignalNode wired to a successor so post() has an action to return. */
function nodeWithSuccessor(): SignalNode {
  const node = new SignalNode();
  node.addSuccessor(new SignalNode(), 'next');
  return node;
}

beforeEach(() => {
  (global as unknown as { __flujo_flow_run_event_bus?: unknown }).__flujo_flow_run_event_bus =
    undefined;
});

describe('SignalNode', () => {
  it('emits one signal with the resolved payload and passes through to its successor', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((e) => events.push(e));
    const node = nodeWithSuccessor();
    const p = params({ topic: 'review-blocked', payloadTemplate: 'Blocked: ${var:reason}' });
    const state = makeState({ variables: { reason: 'flaky test' }, chainDepth: 2 });

    const prep = await node.prep(state, p);
    const action = await node.post(prep, {}, state, p);
    unsub();

    expect(events).toHaveLength(1);
    expect(isFlowSignalEvent(events[0])).toBe(true);
    const sig = events[0] as FlowSignalEvent;
    expect(sig.topic).toBe('review-blocked');
    expect(sig.payload).toBe('Blocked: flaky test');
    expect(sig.emitterFlowId).toBe('flow-emitter');
    expect(sig.conversationId).toBe('conv-1');
    expect(sig.chainDepth).toBe(2); // the EMITTING run's depth (listener increments)
    expect(action).toBe('next'); // transparent: first successor
  });

  it('never mutates the conversation messages', async () => {
    const node = nodeWithSuccessor();
    const p = params({ topic: 't', payloadTemplate: 'x' });
    const state = makeState();
    await node.post(await node.prep(state, p), {}, state, p);
    expect(state.messages).toEqual([]);
  });

  it('emits even inside a subflow (runDepth > 0) and carries the inherited chainDepth', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((e) => events.push(e));
    const node = nodeWithSuccessor();
    const p = params({ topic: 'nested', payloadTemplate: 'from subflow' });
    const state = makeState({ runDepth: 2, chainDepth: 1 });

    await node.post(await node.prep(state, p), {}, state, p);
    unsub();

    expect(events).toHaveLength(1);
    expect((events[0] as FlowSignalEvent).chainDepth).toBe(1);
  });

  it('emits nothing when no topic is set but still passes through', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((e) => events.push(e));
    const node = nodeWithSuccessor();
    const p = params({ topic: '   ', payloadTemplate: 'ignored' });
    const state = makeState();

    const action = await node.post(await node.prep(state, p), {}, state, p);
    unsub();

    expect(events).toHaveLength(0);
    expect(action).toBe('next');
  });
});

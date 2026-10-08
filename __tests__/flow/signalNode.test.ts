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

  it('uses a Process handoff body as the payload and resolves run variables', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((e) => events.push(e));
    const node = nodeWithSuccessor();
    const p = params({ topic: 'review-blocked', payloadTemplate: 'authored fallback' });
    const state = makeState({
      variables: { reason: 'missing approval' },
      handoffInput: {
        targetNodeId: 'sig',
        prompt: '',
        fromHandoffTool: true,
        signalBody: 'Caller says: ${var:reason}',
      },
    });

    await node.post(await node.prep(state, p), {}, state, p);
    unsub();

    expect((events[0] as FlowSignalEvent).payload).toBe('Caller says: missing approval');
    expect(state.handoffInput).toBeUndefined();
  });

  it('rejects a malformed Process handoff without a non-empty body', async () => {
    const node = nodeWithSuccessor();
    const p = params({ topic: 'review-blocked', payloadTemplate: 'must not be used' });
    const state = makeState({
      handoffInput: { targetNodeId: 'sig', prompt: '', fromHandoffTool: true },
    });

    await expect(node.prep(state, p)).rejects.toThrow('requires a non-empty body');
    expect(state.handoffInput).toBeUndefined();
  });

  it('ignores handoff input scoped to a different node', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((e) => events.push(e));
    const node = nodeWithSuccessor();
    const p = params({ topic: 't', payloadTemplate: 'authored' });
    const state = makeState({
      handoffInput: {
        targetNodeId: 'other-signal',
        prompt: '',
        fromHandoffTool: true,
        signalBody: 'wrong payload',
      },
    });

    await node.post(await node.prep(state, p), {}, state, p);
    unsub();

    expect((events[0] as FlowSignalEvent).payload).toBe('authored');
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

  it('suppresses a stale Persona signal at the publication boundary while the successor emits', async () => {
    const events: FlowEvent[] = [];
    const unsub = getFlowRunEventBus().subscribe((event) => events.push(event));
    const node = nodeWithSuccessor();
    const p = params({ topic: 'generation-safe', payloadTemplate: '${var:value}' });
    let currentGeneration = 1;
    let releaseAssertion!: () => void;
    const assertionGate = new Promise<void>((resolve) => {
      releaseAssertion = resolve;
    });
    const staleAuthority = {
      signal: new AbortController().signal,
      assertCurrent: jest.fn(async () => {
        await assertionGate;
        if (currentGeneration !== 1) throw new Error('old Persona Activity lost its lease');
      }),
    };
    const attribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    };

    const stalePost = node.post(
      await node.prep(makeState(), p),
      {},
      makeState({
        variables: { value: 'stale' },
        executionAuthority: staleAuthority,
        personaAttribution: attribution,
      }),
      p,
    );
    currentGeneration = 2;
    releaseAssertion();

    await expect(stalePost).resolves.toBe('next');
    expect(staleAuthority.assertCurrent).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    const successorAuthority = {
      signal: new AbortController().signal,
      assertCurrent: jest.fn(async () => {
        if (currentGeneration !== 2) throw new Error('successor lost authority');
      }),
    };
    await node.post(
      await node.prep(makeState(), p),
      {},
      makeState({
        variables: { value: 'successor' },
        executionAuthority: successorAuthority,
        personaAttribution: { ...attribution, activityId: 'activity-2' },
      }),
      p,
    );
    unsub();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'signal',
      topic: 'generation-safe',
      payload: 'successor',
    });
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

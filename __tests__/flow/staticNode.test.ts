/**
 * Static node (issue #358): deterministic conversation injection.
 *
 * Pins the node contract:
 *  - authored `message` entries are appended to sharedState.messages in order;
 *  - a `toolCall` entry expands into a well-formed PAIR: an assistant turn with
 *    tool_calls, then a role:'tool' result carrying the SAME tool_call_id;
 *  - `${var:NAME}` run variables are resolved at injection time;
 *  - invalid JSON arguments fail loudly (providers would reject the history);
 *  - `injectOnce` suppresses a second traversal;
 *  - it always passes through to its first successor.
 */
import { StaticNode } from '@/backend/execution/flow/nodes/StaticNode';
import type { SharedState, StaticNodeParams } from '@/backend/execution/flow/types';

jest.mock('@/backend/execution/flow/resolveRunResourceRefs', () => ({
  resolveRunResourceRefs: jest.fn(async (value: string) => value),
}));

function makeState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'e', startTime: 0, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as SharedState;
}

const params = (properties: Record<string, unknown>): StaticNodeParams => ({
  id: 'stat',
  label: 'Static',
  type: 'static',
  properties: properties as StaticNodeParams['properties'],
});

function nodeWithSuccessor(): StaticNode {
  const node = new StaticNode();
  node.addSuccessor(new StaticNode(), 'next');
  return node;
}

async function run(node: StaticNode, state: SharedState, p: StaticNodeParams): Promise<string> {
  const prep = await node.prep(state, p);
  return node.post(prep, {}, state, p);
}

describe('StaticNode', () => {
  it('appends authored messages in order, resolving run variables', async () => {
    const node = nodeWithSuccessor();
    const p = params({
      entries: [
        { kind: 'message', role: 'system', content: 'You are ${var:persona}' },
        { kind: 'message', role: 'user', content: 'hello' },
      ],
    });
    const state = makeState({ variables: { persona: 'a helper' } });

    const action = await run(node, state, p);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: 'system', content: 'You are a helper' });
    expect(state.messages[1]).toMatchObject({ role: 'user', content: 'hello' });
    expect(action).toBe('next');
  });

  it('expands a tool-call entry into a well-formed assistant + tool pair', async () => {
    const node = nodeWithSuccessor();
    const p = params({
      entries: [{ kind: 'toolCall', toolName: 'read_file', argumentsJson: '{"path":"a.txt"}', result: 'contents' }],
    });
    const state = makeState();

    await run(node, state, p);

    expect(state.messages).toHaveLength(2);
    const assistant = state.messages[0] as any;
    const tool = state.messages[1] as any;
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function).toEqual({ name: 'read_file', arguments: '{"path":"a.txt"}' });
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(tool.content).toBe('contents');
  });

  it('rejects invalid JSON arguments', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'toolCall', toolName: 'x', argumentsJson: '{oops', result: '' }] });
    const state = makeState();
    const prep = await node.prep(state, p);

    await expect(node.post(prep, {}, state, p)).rejects.toThrow('invalid JSON arguments');
    expect(state.messages).toHaveLength(0);
  });

  it('rejects a tool-call entry without a tool name', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'toolCall', toolName: '  ', argumentsJson: '{}', result: '' }] });
    const state = makeState();
    const prep = await node.prep(state, p);

    await expect(node.post(prep, {}, state, p)).rejects.toThrow('requires a tool name');
  });

  it('appends again on re-entry by default, but only once with injectOnce', async () => {
    const entries = [{ kind: 'message', role: 'user', content: 'again' }];

    const looping = nodeWithSuccessor();
    const loopState = makeState();
    const loopParams = params({ entries });
    await run(looping, loopState, loopParams);
    await run(looping, loopState, loopParams);
    expect(loopState.messages).toHaveLength(2);

    const onceNode = nodeWithSuccessor();
    const onceState = makeState();
    const onceParams = params({ entries, injectOnce: true });
    await run(onceNode, onceState, onceParams);
    await run(onceNode, onceState, onceParams);
    expect(onceState.messages).toHaveLength(1);
  });

  it('injects nothing but still passes through with no entries', async () => {
    const node = nodeWithSuccessor();
    const state = makeState();

    const action = await run(node, state, params({ entries: [] }));

    expect(state.messages).toHaveLength(0);
    expect(action).toBe('next');
  });

  it('falls back to the default action with no successors', async () => {
    const node = new StaticNode();
    const state = makeState();

    const action = await run(node, state, params({ entries: [] }));

    expect(action).toBe('default');
  });
  it('uses per-run staticInjected bookkeeping across re-entry and state serialization', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'message', role: 'user', content: 'once' }], injectOnce: true });
    const state = makeState();

    await run(node, state, p);
    // No logicalRunId on this bare state, so the marker falls back to 'no-run'.
    expect(state.staticInjected).toEqual({ stat: 'no-run' });

    const restored = JSON.parse(JSON.stringify(state)) as SharedState;
    await run(node, restored, p);
    expect(restored.messages).toHaveLength(1);

    const freshState = makeState();
    await run(node, freshState, p);
    expect(freshState.messages).toHaveLength(1);
  });

  it('treats non-true injectOnce values as append and re-resolves variables', async () => {
    const node = nodeWithSuccessor();
    const state = makeState({ variables: { attempt: 'one' } });
    const p = params({
      entries: [{ kind: 'message', role: 'user', content: 'attempt ${var:attempt}' }],
      injectOnce: 'true',
    });

    await run(node, state, p);
    state.variables = { attempt: 'two' };
    await run(node, state, p);

    expect(state.messages.map((message) => message.content)).toEqual(['attempt one', 'attempt two']);
  });

  it('does not mark an empty once-only node and mints fresh tool-call ids on re-entry', async () => {
    const node = nodeWithSuccessor();
    const state = makeState();
    const empty = params({ entries: [], injectOnce: true });
    await run(node, state, empty);
    expect(state.staticInjected).toBeUndefined();

    const tool = params({ entries: [{ kind: 'toolCall', toolName: 'lookup', argumentsJson: '{}', result: 'ok' }] });
    await run(node, state, tool);
    await run(node, state, tool);
    const first = (state.messages[0] as any).tool_calls[0].id;
    const second = (state.messages[2] as any).tool_calls[0].id;
    expect(first).not.toBe(second);
    expect((state.messages[1] as any).tool_call_id).toBe(first);
    expect((state.messages[3] as any).tool_call_id).toBe(second);
  });

  it('injectOnce dedupes within one logical run but injects again on the next one (#381)', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'message', role: 'user', content: 'primer' }], injectOnce: true });
    const state = makeState({ logicalRunId: 'run-1' });

    await run(node, state, p);
    await run(node, state, p);
    expect(state.messages).toHaveLength(1);
    expect(state.staticInjected).toEqual({ stat: 'run-1' });

    // A new user turn keeps the persisted state but assigns a fresh logical run id.
    state.logicalRunId = 'run-2';
    await run(node, state, p);
    expect(state.messages).toHaveLength(2);
    expect(state.staticInjected).toEqual({ stat: 'run-2' });
  });

  it('appends on every traversal by default, regardless of the logical run', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'message', role: 'user', content: 'again' }] });
    const state = makeState({ logicalRunId: 'run-1' });

    await run(node, state, p);
    await run(node, state, p);
    state.logicalRunId = 'run-2';
    await run(node, state, p);

    expect(state.messages).toHaveLength(3);
  });

  it('keys the marker per node, so two once-only nodes each inject in the same run', async () => {
    const first = nodeWithSuccessor();
    const second = nodeWithSuccessor();
    const state = makeState({ logicalRunId: 'run-1' });
    const entries = [{ kind: 'message', role: 'user', content: 'x' }];
    const a = { ...params({ entries, injectOnce: true }), id: 'a' } as StaticNodeParams;
    const b = { ...params({ entries, injectOnce: true }), id: 'b' } as StaticNodeParams;

    await run(first, state, a);
    await run(second, state, b);
    await run(first, state, a);
    await run(second, state, b);

    expect(state.messages).toHaveLength(2);
    expect(state.staticInjected).toEqual({ a: 'run-1', b: 'run-1' });
  });

  it('prunes markers left behind by an earlier logical run', async () => {
    const node = nodeWithSuccessor();
    const p = params({ entries: [{ kind: 'message', role: 'user', content: 'x' }], injectOnce: true });
    const state = makeState({ logicalRunId: 'run-2', staticInjected: { stale: 'run-1' } });

    await run(node, state, p);

    expect(state.staticInjected).toEqual({ stat: 'run-2' });
  });
});

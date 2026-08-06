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
});

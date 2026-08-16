/**
 * Executable examples for docs/features/flows/static-node.md.
 */
import { StaticNode } from '@/backend/execution/flow/nodes/StaticNode';
import type { SharedState, StaticNodeParams } from '@/backend/execution/flow/types';

jest.mock('@/backend/execution/flow/resolveRunResourceRefs', () => ({
  resolveRunResourceRefs: jest.fn(async (value: string) =>
    value.replace('${res:customerProfile}', 'profile from run resource'),
  ),
}));

function state(): SharedState {
  return {
    trackingInfo: { executionId: 'e', startTime: 0, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as SharedState;
}

async function inject(properties: Record<string, unknown>, sharedState = state()) {
  const node = new StaticNode();
  node.addSuccessor(new StaticNode(), 'next');
  const params = {
    id: 'static-doc-example',
    label: 'Static',
    type: 'static',
    properties,
  } as StaticNodeParams;
  const prepared = await node.prep(sharedState, params);
  await node.post(prepared, {}, sharedState, params);
  return sharedState;
}

describe('Static node documentation examples', () => {
  it('injects ordered system-prompt scaffolding', async () => {
    const sharedState = await inject({
      entries: [
        { kind: 'message', role: 'system', content: 'Answer concisely and cite supplied evidence.' },
        { kind: 'message', role: 'user', content: 'Use the following request as the task.' },
      ],
    });

    expect(sharedState.messages.map((message) => message.content)).toEqual([
      'Answer concisely and cite supplied evidence.',
      'Use the following request as the task.',
    ]);
  });

  it('creates the documented synthetic read_file exchange', async () => {
    const sharedState = await inject({
      entries: [
        {
          kind: 'toolCall',
          toolName: 'read_file',
          argumentsJson: '{"path":"README.md"}',
          result: '# Project README\\n...',
        },
      ],
    });

    const [assistant, tool] = sharedState.messages as any[];
    expect(assistant.tool_calls[0].function).toEqual({
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
    expect(tool).toMatchObject({ role: 'tool', content: '# Project README\\n...' });
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('substitutes variables and resources in a tool-call example', async () => {
    const sharedState = state();
    sharedState.variables = { customerId: 'cust_123' };
    await inject(
      {
        entries: [
          {
            kind: 'toolCall',
            toolName: 'lookup_customer',
            argumentsJson: '{"id":"${var:customerId}"}',
            result: 'Profile: ${res:customerProfile}',
          },
        ],
      },
      sharedState,
    );

    const [assistant, tool] = sharedState.messages as any[];
    expect(assistant.tool_calls[0].function.arguments).toBe('{"id":"cust_123"}');
    expect(tool.content).toBe('Profile: profile from run resource');
  });

  it('documents default re-entry and injectOnce behavior', async () => {
    const entries = [{ kind: 'message', role: 'user', content: 'repeatable context' }];
    const repeatable = state();
    await inject({ entries }, repeatable);
    await inject({ entries }, repeatable);
    expect(repeatable.messages).toHaveLength(2);

    const once = state();
    await inject({ entries, injectOnce: true }, once);
    await inject({ entries, injectOnce: true }, once);
    expect(once.messages).toHaveLength(1);
  });
});

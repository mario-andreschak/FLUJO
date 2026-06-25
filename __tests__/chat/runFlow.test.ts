/**
 * Tests for the flow-as-callable keystone (runFlow).
 *
 * runFlow is the extracted core that the OpenAI route, subflows (#13), and the
 * scheduler (#10) all share. The two behaviors these tests pin down are the
 * ones consumers depend on and that the legacy OpenAI path never had:
 *   1. `prompt` maps to a single user message and the flow runs to completion,
 *      returning the final assistant content as `outputText`.
 *   2. `mode: 'ephemeral'` runs the flow in transient state and writes NOTHING
 *      to the conversations/* store, and the transient state is dropped from the
 *      in-memory map once the run reaches a terminal status.
 *
 * Like the other chat tests, the engine (FlowExecutor) is stubbed with a tiny
 * start->process->finish state machine, so there is no network/model call.
 */
import type { SharedState } from '@/backend/execution/flow/types';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const FLOW_ID = 'flow-1';

// Records every state handed to persistConversationState, so we can assert that
// an ephemeral run persists nothing while a conversation run does.
const persistedStates: SharedState[] = [];

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = '077cfac0-start';
  const P = 'ef2a3c01-process';
  const EDGE = `${S}->${P}`;
  const FINAL = 'FINAL_RESPONSE';
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      // start hands off to process; process produces a final answer.
      executeStep: jest.fn(async (sharedState: any) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        if (nodeId === S) {
          return { sharedState, action: EDGE };
        }
        sharedState.lastResponse = 'Hello from the process node';
        sharedState.messages.push({
          role: 'assistant',
          content: 'Hello from the process node',
          id: 'assistant-1',
          timestamp: 1,
          processNodeId: P,
        });
        return { sharedState, action: FINAL };
      }),
      resolveHandoff: jest.fn(async (sharedState: any, action: string) => {
        if (sharedState.currentNodeId === S && action === EDGE) {
          return { isSuccessorEdge: true, targetNodeId: P };
        }
        return { isSuccessorEdge: false, targetNodeId: null };
      }),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? S),
    },
  };
});

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async (_key: string, state: any) => {
    persistedStates.push(JSON.parse(JSON.stringify(state)));
  }),
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
}));

// runFlow resolves a "flow-<name>" model via flowService.getFlowByName; give it
// a flow with a known id. flowId-based runs skip this entirely.
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [{ id: 'flow-1', name: 'TestFlow' }]),
    getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'TestFlow' })),
  },
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

beforeEach(() => {
  persistedStates.length = 0;
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('runFlow keystone', () => {
  it('maps `prompt` to a user message and runs to completion (flowId input)', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'hi there',
      mode: 'conversation',
    });

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Hello from the process node');
    // The prompt became the first user message.
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'hi there' });
    // flowId was used directly (no model-name resolution needed).
    expect(result.sharedState.flowId).toBe(FLOW_ID);
  });

  it('resolves a "flow-<name>" model when no flowId is given', async () => {
    const result = await runFlow({
      modelName: 'flow-TestFlow',
      prompt: 'hi',
      mode: 'conversation',
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.flowId).toBe(FLOW_ID);
  });

  it('returns flowNotFound for an unknown flow name', async () => {
    const result = await runFlow({
      modelName: 'flow-DoesNotExist',
      prompt: 'hi',
      mode: 'conversation',
    });

    expect(result.status).toBe('error');
    expect(result.flowNotFound).toEqual({ name: 'DoesNotExist' });
  });

  it('ephemeral mode persists nothing and leaves no state in the in-memory map', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'ephemeral run',
      mode: 'ephemeral',
    });

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Hello from the process node');
    // The single most important keystone guarantee: nothing reached the
    // conversations/* store, so this run never shows up in the chat sidebar.
    expect(persistedStates.length).toBe(0);
    // And the transient state was cleaned out of the in-memory map at terminal.
    expect(conversationStates.has(result.conversationId)).toBe(false);
  });

  it('rejects a run past the subflow depth limit (re-entrancy guard)', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'too deep',
      mode: 'ephemeral',
      depth: 99,
    });

    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/recursion limit/i);
    // The guard fires before any step runs.
    expect(FlowExecutor.executeStep as jest.Mock).not.toHaveBeenCalled();
  });

  it('conversation mode DOES persist (contrast with ephemeral)', async () => {
    await runFlow({
      flowId: FLOW_ID,
      prompt: 'persisted run',
      mode: 'conversation',
    });

    expect(persistedStates.length).toBeGreaterThan(0);
    expect(persistedStates[persistedStates.length - 1].status).toBe('completed');
  });
});

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

// Mock the storage layer BELOW persistConversationState, so the ephemeral
// guarantee is exercised through the REAL chokepoint (which refuses states
// with `ephemeral: true`) rather than through a mock of it.
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async (_key: string, value: any) => {
    persistedStates.push(JSON.parse(JSON.stringify(value)));
  }),
  // issue #126: persist/load choke points now validate the conversation id.
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

// runFlow resolves a "flow-<name>" model via flowService.getFlowByName; give it
// a flow with a known id. flowId-based runs skip this entirely.
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [{ id: 'flow-1', name: 'TestFlow' }]),
    getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'TestFlow' })),
  },
}));

// The pre-run consistency check runs at the start of every fresh run. The
// stub flows here have no nodes (the engine is stubbed too), so let the check
// pass by default; the preflight test overrides this per-call.
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { validateFlowForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow/index';

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

  it('blocks a fresh run when pre-run validation finds errors (before any step)', async () => {
    (validateFlowForRun as jest.Mock).mockResolvedValueOnce({
      issues: [{ severity: 'error', code: 'model_missing', message: 'Node "agent" references a deleted model' }],
      errorCount: 1,
      warningCount: 0,
      isRunnable: false,
    });

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'should be blocked',
      mode: 'ephemeral',
    });

    expect(result.status).toBe('error');
    expect(result.error?.statusCode).toBe(400);
    expect(result.error?.message).toMatch(/deleted model/);
    // Blocked BEFORE any node executed.
    expect(FlowExecutor.executeStep as jest.Mock).not.toHaveBeenCalled();
  });

  it("resets a pre-created conversation's undefined status to 'running' for its first run", async () => {
    // The create route seeds conversations with status undefined; without the
    // reset, the whole FIRST run reported undefined to the list route — the
    // sidebar never showed the running dot / stop button for it.
    const convId = 'conv-fresh-status-1';
    conversationStates.set(convId, {
      trackingInfo: { executionId: 'e-fresh', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      conversationId: convId,
      title: 'New Conversation',
      createdAt: 1,
      updatedAt: 1,
      status: undefined,
    } as unknown as SharedState);

    const statusesDuringSteps: Array<string | undefined> = [];
    const stub = FlowExecutor.executeStep as jest.Mock;
    const impl = stub.getMockImplementation()!;
    stub.mockImplementation(async (sharedState: any) => {
      statusesDuringSteps.push(sharedState.status);
      return impl(sharedState);
    });
    try {
      const result = await runFlow({
        flowId: FLOW_ID,
        prompt: 'first run',
        mode: 'conversation',
        conversationId: convId,
      });
      expect(result.status).toBe('completed');
      // While the run executed, the state said 'running' (what the list serves).
      expect(statusesDuringSteps[0]).toBe('running');
    } finally {
      stub.mockImplementation(impl);
    }
  });

  it('a validator crash does not block the run (check is advisory infrastructure)', async () => {
    (validateFlowForRun as jest.Mock).mockRejectedValueOnce(new Error('validator exploded'));

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'still runs',
      mode: 'ephemeral',
    });

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Hello from the process node');
  });
});

describe('message emission (live view feed)', () => {
  it('preserves caller-provided message ids on a NEW conversation', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      messages: [{ role: 'user', content: 'hi there', id: 'client-uuid-1', timestamp: 123 }],
      mode: 'conversation',
    });

    expect(result.status).toBe('completed');
    // The optimistic client id survives — the live view can merge the
    // canonical copy into the optimistic bubble instead of duplicating it.
    expect(result.messages[0]).toMatchObject({ role: 'user', id: 'client-uuid-1' });
  });

  it('does not re-emit the user message when a node REPLACES the transcript (dup-bubble regression)', async () => {
    // Reproduces ProcessNode.post's write-back: prep builds a system-prefixed
    // copy of the history and post REPLACES sharedState.messages with it. The
    // old index-based emission cursor shifted by one and re-emitted the last
    // pre-step message (the user's) as a live `message` event.
    const S = '077cfac0-start';
    const P = 'ef2a3c01-process';
    (FlowExecutor.executeStep as jest.Mock)
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.currentNodeId = sharedState.currentNodeId ?? S;
        return { sharedState, action: `${S}->${P}` };
      })
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.messages = [
          { role: 'system', content: 'NODE SYSTEM PROMPT', id: 'sys-1', timestamp: 2 },
          ...sharedState.messages,
          { role: 'assistant', content: 'answer', id: 'assistant-1', timestamp: 3, processNodeId: P },
        ];
        sharedState.lastResponse = 'answer';
        return { sharedState, action: 'FINAL_RESPONSE' };
      });

    const events: any[] = [];
    const result = await runFlow({
      flowId: FLOW_ID,
      messages: [{ role: 'user', content: 'call two tools', id: 'user-1', timestamp: 1 }],
      mode: 'conversation',
      emit: (e: any) => { events.push(e); },
    });

    expect(result.status).toBe('completed');
    const messageEvents = events.filter(e => e.type === 'message');
    // The user message was present at run start (the client already shows it):
    // it must NOT come back as a live event under any id.
    expect(messageEvents.filter(e => e.message.role === 'user')).toHaveLength(0);
    // The node's system prompt is model plumbing, never streamed.
    expect(messageEvents.filter(e => e.message.role === 'system')).toHaveLength(0);
    // The genuinely new assistant answer is emitted exactly once.
    const assistantEvents = messageEvents.filter(e => e.message.role === 'assistant');
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0].message.id).toBe('assistant-1');
  });
});

describe('Tier 2c — named-variable seeding + persistence', () => {
  it('seeds SharedState.variables from FlowRunInput.variables (values coerced to string)', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'seed me',
      mode: 'conversation',
      variables: { plan: 'do X', count: 3, skip: null as unknown as string },
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.variables).toEqual({ plan: 'do X', count: '3' }); // null skipped, number coerced
  });

  it('a top-level (conversation) run PERSISTS the variables map', async () => {
    await runFlow({
      flowId: FLOW_ID,
      prompt: 'persist vars',
      mode: 'conversation',
      variables: { keep: 'this' },
    });

    const last = persistedStates[persistedStates.length - 1];
    expect(last.variables).toEqual({ keep: 'this' });
  });

  it('an ephemeral run persists nothing, so seeded variables never reach the store', async () => {
    await runFlow({
      flowId: FLOW_ID,
      prompt: 'ephemeral vars',
      mode: 'ephemeral',
      variables: { secretish: 'gone' },
    });
    expect(persistedStates.length).toBe(0);
  });
});

describe('persistConversationState chokepoint (ephemeral policy)', () => {
  // The policy is enforced INSIDE the persist function, not at call sites, so
  // even persist paths outside the run loop (e.g. the Claude adapter's
  // incremental persistStreamedMessage — the suspected leak vector) cannot
  // write an ephemeral run to the conversations store.
  const { persistConversationState } = jest.requireActual('@/backend/execution/flow/persistConversationState');

  it('refuses a state marked ephemeral, persists an unmarked one', async () => {
    const base = {
      trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      title: 't',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SharedState;

    await persistConversationState('conversations/child-1', { ...base, ephemeral: true });
    expect(persistedStates.length).toBe(0);

    await persistConversationState('conversations/parent-1', base);
    expect(persistedStates.length).toBe(1);
  });
});

describe('resume after error — turn replay (issue #151)', () => {
  // The reported bug: Retrying an errored conversation whose parked node uses
  // `latest-message` re-runs that node directly, so it sees only the current
  // turn's tail and "loses all context about the conversation as a whole". The
  // fix (P1) re-enters the turn at its ENTRY node (the last user message's
  // processNodeId; the flow start node when unstamped) so a full-history entry
  // node rebuilds context before routing forward — but ONLY on an
  // error-recovery resume, so normal resumes are untouched.
  const ERRORED_CONV = 'conv-resume-after-error';

  // Errored conversation parked at the (latest-message) PROCESS node that
  // failed. The errored node wrote no message, so history ends on interim
  // output from the entry node.
  function seedErrored(status: 'error' | 'completed') {
    conversationStates.set(ERRORED_CONV, {
      trackingInfo: { executionId: 'e-err', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      conversationId: ERRORED_CONV,
      currentNodeId: PROCESS,
      status,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SharedState);
  }

  // What the client re-sends on Retry: a user turn stamped with the ENTRY node
  // (START) + interim assistant output from it; NO fresh trailing user turn.
  const retryMessages = [
    { role: 'user', content: 'question', id: 'u1', timestamp: 1, processNodeId: START },
    { role: 'assistant', content: 'interim from start node', id: 'a1', timestamp: 2, processNodeId: START },
  ];

  // Record which node currentNodeId held when each step began.
  function captureStepNodes(): { seen: Array<string | undefined>; restore: () => void } {
    const seen: Array<string | undefined> = [];
    const stub = FlowExecutor.executeStep as jest.Mock;
    const impl = stub.getMockImplementation()!;
    stub.mockImplementation(async (sharedState: any) => {
      seen.push(sharedState.currentNodeId);
      return impl(sharedState);
    });
    return { seen, restore: () => stub.mockImplementation(impl) };
  }

  it('re-enters at the turn ENTRY node instead of the errored node on Retry', async () => {
    seedErrored('error');
    const { seen, restore } = captureStepNodes();
    try {
      const result = await runFlow({
        flowId: FLOW_ID,
        conversationId: ERRORED_CONV,
        messages: retryMessages, // Retry re-sends history; no new user turn
        userTurn: true,
        mode: 'conversation',
      });
      expect(result.status).toBe('completed');
      // Restarted at START (full-history entry node), NOT the parked
      // latest-message PROCESS node.
      expect(seen[0]).toBe(START);
    } finally {
      restore();
    }
  });

  it('does NOT redirect on a normal (non-error) resume', async () => {
    seedErrored('completed');
    const { seen, restore } = captureStepNodes();
    try {
      const result = await runFlow({
        flowId: FLOW_ID,
        conversationId: ERRORED_CONV,
        messages: retryMessages,
        userTurn: true,
        mode: 'conversation',
      });
      expect(result.status).toBe('completed');
      // Stays parked at PROCESS: the error-recovery redirect is dormant.
      expect(seen[0]).toBe(PROCESS);
    } finally {
      restore();
    }
  });

  it('falls back to the flow start node when the last user message is unstamped', async () => {
    seedErrored('error');
    (flowService.getFlow as jest.Mock).mockResolvedValueOnce({
      id: FLOW_ID,
      name: 'TestFlow',
      nodes: [{ id: START, type: 'start' }, { id: PROCESS, type: 'process' }],
    });
    const { seen, restore } = captureStepNodes();
    try {
      const result = await runFlow({
        flowId: FLOW_ID,
        conversationId: ERRORED_CONV,
        // Unstamped user turn + interim assistant output: the entry-node lookup
        // misses, so the start-node fallback (via flowService.getFlow) supplies START.
        messages: [
          { role: 'user', content: 'question', id: 'u1', timestamp: 1 },
          { role: 'assistant', content: 'interim', id: 'a1', timestamp: 2 },
        ],
        userTurn: true,
        mode: 'conversation',
      });
      expect(result.status).toBe('completed');
      expect(seen[0]).toBe(START);
    } finally {
      restore();
    }
  });

  it('an ephemeral error-resume is NOT redirected (persisted conversations only)', async () => {
    // Ephemeral runs never adopt a persisted conversation, so seed via memory
    // and confirm the guard's !ephemeral clause keeps it parked at PROCESS.
    seedErrored('error');
    conversationStates.get(ERRORED_CONV)!.ephemeral = true as any;
    const { seen, restore } = captureStepNodes();
    try {
      const result = await runFlow({
        flowId: FLOW_ID,
        conversationId: ERRORED_CONV,
        messages: retryMessages,
        userTurn: true,
        mode: 'ephemeral',
      });
      expect(result.status).toBe('completed');
      expect(seen[0]).toBe(PROCESS);
    } finally {
      restore();
    }
  });
});

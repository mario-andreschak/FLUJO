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
import type { FlowExecutionAuthority, SharedState } from '@/backend/execution/flow/types';
import { IMPLICIT_SUBFLOW_RETURN_ACTION } from '@/backend/execution/flow/types';
import type { PersonaInstructionContext } from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import { hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const FLOW_ID = 'flow-1';

function behaviorFlow(id: string, marker: string): Flow {
  return {
    id,
    name: `Persona Behavior ${marker}`,
    nodes: [],
    edges: [],
  } as Flow;
}

function personaInstructionContext(
  activityId = 'activity-1',
  overrides: Partial<PersonaInstructionContext> = {},
): PersonaInstructionContext {
  return {
    schemaVersion: 1,
    personaId: 'persona-1',
    activityId,
    behaviorRevisionId: 'behavior-revision-1',
    behaviorContentHash: 'a'.repeat(64),
    behaviorSlotKey: 'primary',
    rootFlowId: FLOW_ID,
    roleVersionId: 'role-version-1',
    personaName: 'Ada',
    personaMission: 'Help the user.',
    roleName: 'Developer',
    roleMission: 'Follow the authored Behavior.',
    instruction: '# TRUSTED PERSONA CONTEXT\nFrozen identity instructions.',
    ...overrides,
  };
}

// Records every state handed to persistConversationState, so we can assert that
// an ephemeral run persists nothing while a conversation run does.
const persistedStates: SharedState[] = [];
const mockLoadItem = jest.fn(async (..._args: unknown[]) => (
  undefined as SharedState | undefined
));

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
  loadItem: (...args: unknown[]) => mockLoadItem(...args),
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

jest.mock('@/backend/services/statistics', () => {
  const actual = jest.requireActual('@/backend/services/statistics');
  return { ...actual, recordStatisticsEvent: jest.fn() };
});

import { runFlow as runFlowWithContext, type FlowRunInput } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { validateFlowForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow/index';
import { getFlowRunEventBus, type FlowEvent } from '@/backend/services/scheduler/flowRunEventBus';
import { recordStatisticsEvent } from '@/backend/services/statistics';

const runFlow = (input: Omit<FlowRunInput, 'source'>) =>
  runFlowWithContext({ ...input, source: 'api' });

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

beforeEach(() => {
  persistedStates.length = 0;
  mockLoadItem.mockReset();
  mockLoadItem.mockResolvedValue(undefined);
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
  (recordStatisticsEvent as jest.Mock).mockClear();
});

describe('runFlow keystone', () => {
  it('rejects a caller that omits the invocation context', async () => {
    await expect(runFlowWithContext({
      flowId: FLOW_ID,
      prompt: 'ambiguous origin',
      mode: 'ephemeral',
    } as FlowRunInput)).rejects.toThrow(/explicit invocation source/i);
    expect(FlowExecutor.executeStep as jest.Mock).not.toHaveBeenCalled();
  });

  it('preserves conversation origin while deriving attendance from the current invocation', async () => {
    const conversationId = 'scheduled-resume';
    conversationStates.set(conversationId, {
      trackingInfo: { executionId: 'scheduled-run', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      conversationId,
      currentNodeId: PROCESS,
      status: 'completed',
      source: 'schedule',
      unattended: true,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SharedState);

    const result = await runFlowWithContext({
      flowId: FLOW_ID,
      conversationId,
      messages: [],
      mode: 'conversation',
      source: 'chat',
    });

    expect(result.status).toBe('completed');
    expect(result.sharedState.source).toBe('schedule');
    expect(result.sharedState.unattended).toBe(false);
    expect(persistedStates[persistedStates.length - 1]).toMatchObject({
      source: 'schedule',
      unattended: false,
    });
  });

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

  it('appends a resumable-subflow follow-up and restarts the saved child from Start', async () => {
    const conversationId = 'saved-child';
    conversationStates.set(conversationId, {
      trackingInfo: { executionId: 'old-run', startTime: 1, nodeExecutionTracker: [] },
      messages: [
        { role: 'user', content: 'Draft section one', id: 'old-user', timestamp: 1 },
        { role: 'assistant', content: 'First draft', id: 'old-answer', timestamp: 2, processNodeId: PROCESS },
      ],
      flowId: FLOW_ID,
      conversationId,
      currentNodeId: PROCESS,
      status: 'completed',
      title: 'Writer',
      createdAt: 1,
      updatedAt: 2,
    } as unknown as SharedState);

    const result = await runFlowWithContext({
      flowId: FLOW_ID,
      conversationId,
      prompt: 'Now apply the review notes',
      resumeAsNewTurn: true,
      mode: 'conversation',
      source: 'subflow',
      parentRunId: 'parent-conversation',
    });

    expect(result.messages.map((message) => message.content)).toEqual(expect.arrayContaining([
      'Draft section one',
      'First draft',
      'Now apply the review notes',
    ]));
    // Re-entering at the old terminal Process would execute once; Start ->
    // Process proves the continuation reset the child graph entry point.
    expect(FlowExecutor.executeStep as jest.Mock).toHaveBeenCalledTimes(2);
    expect(result.sharedState.status).toBe('completed');
  });

  it('returns the most recent assistant media when a later final message is text-only', async () => {
    const media = [{
      type: 'video' as const,
      mimeType: 'video/mp4',
      resourceUri: 'flujo://run/child-conv/final-video',
      localPath: 'C:\\artifacts\\final-video.mp4',
    }];

    (FlowExecutor.executeStep as jest.Mock)
      .mockImplementationOnce(async (sharedState: SharedState) => {
        sharedState.currentNodeId = START;
        return { sharedState, action: `${START}->${PROCESS}` };
      })
      .mockImplementationOnce(async (sharedState: SharedState) => {
        sharedState.messages.push({
          role: 'assistant',
          content: 'Generated the video.',
          media,
          id: 'media-result',
          timestamp: 2,
          processNodeId: PROCESS,
        } as any);
        sharedState.lastResponse = 'Finished verification.';
        sharedState.messages.push({
          role: 'assistant',
          content: 'Finished verification.',
          id: 'text-final',
          timestamp: 3,
          processNodeId: PROCESS,
        } as any);
        return { sharedState, action: 'FINAL_RESPONSE' };
      });

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'generate and verify media',
      mode: 'conversation',
    });

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Finished verification.');
    expect(result.outputMedia).toEqual(media);
  });

  it('stores and clears the caller-aware return marker around a terminal one-way Subflow', async () => {
    const SUBFLOW = 'terminal-worker';
    const START_TO_PROCESS = `${START}->${PROCESS}`;
    const PROCESS_TO_SUBFLOW = `${PROCESS}->${SUBFLOW}`;
    const visited: string[] = [];
    const markerSeenBySubflow: Array<SharedState['pendingSubflowReturn']> = [];

    (FlowExecutor.executeStep as jest.Mock)
      .mockImplementationOnce(async (sharedState: SharedState) => {
        sharedState.currentNodeId = START;
        visited.push(START);
        return { sharedState, action: START_TO_PROCESS };
      })
      .mockImplementationOnce(async (sharedState: SharedState) => {
        visited.push(sharedState.currentNodeId!);
        sharedState.handoffNameMap = { handoff_to_worker: SUBFLOW };
        sharedState.messages.push({
          role: 'assistant',
          content: 'Delegating the test.',
          id: 'delegate-1',
          timestamp: 2,
          processNodeId: PROCESS,
          tool_calls: [{
            id: 'handoff-1',
            type: 'function',
            function: { name: 'handoff_to_worker', arguments: '{}' },
          }],
        } as any);
        return { sharedState, action: PROCESS_TO_SUBFLOW };
      })
      .mockImplementationOnce(async (sharedState: SharedState) => {
        visited.push(sharedState.currentNodeId!);
        markerSeenBySubflow.push(sharedState.pendingSubflowReturn);
        sharedState.messages.push({
          role: 'assistant',
          content: 'Returned result from sub-agent: tests passed.',
          id: 'worker-result-1',
          timestamp: 3,
          processNodeId: SUBFLOW,
        } as any);
        return { sharedState, action: IMPLICIT_SUBFLOW_RETURN_ACTION };
      })
      .mockImplementationOnce(async (sharedState: SharedState) => {
        visited.push(sharedState.currentNodeId!);
        sharedState.lastResponse = 'Caller received the report.';
        sharedState.messages.push({
          role: 'assistant',
          content: 'Caller received the report.',
          id: 'caller-final-1',
          timestamp: 4,
          processNodeId: PROCESS,
        } as any);
        return { sharedState, action: 'FINAL_RESPONSE' };
      });

    (FlowExecutor.resolveHandoff as jest.Mock)
      .mockImplementationOnce(async () => ({
        isSuccessorEdge: true,
        targetNodeId: PROCESS,
        targetNodeType: 'process',
      }))
      .mockImplementationOnce(async () => ({
        isSuccessorEdge: true,
        targetNodeId: SUBFLOW,
        targetNodeType: 'subflow',
        implicitSubflowReturn: {
          subflowNodeId: SUBFLOW,
          callerNodeId: PROCESS,
        },
      }))
      .mockImplementationOnce(async () => ({
        isSuccessorEdge: true,
        targetNodeId: PROCESS,
        targetNodeType: 'process',
      }));

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'run tests',
      mode: 'conversation',
    });

    expect(visited).toEqual([START, PROCESS, SUBFLOW, PROCESS]);
    expect(markerSeenBySubflow).toEqual([{
      subflowNodeId: SUBFLOW,
      callerNodeId: PROCESS,
    }]);
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Caller received the report.');
    expect(result.sharedState.pendingSubflowReturn).toBeUndefined();
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
      personaCoreAppRefs: ['must-not-persist'],
    } as unknown as SharedState;

    await persistConversationState('conversations/child-1', { ...base, ephemeral: true });
    expect(persistedStates.length).toBe(0);

    await persistConversationState('conversations/parent-1', base);
    expect(persistedStates.length).toBe(1);
    expect(persistedStates[0].personaCoreAppRefs).toBeUndefined();
  });

  it('does not write a Persona snapshot when its commit fence is no longer current', async () => {
    const leaseLost = new Error('Persona lease is no longer current');
    const commitWhileCurrent = jest.fn(async () => {
      throw leaseLost;
    });
    const state = {
      trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      conversationId: 'stale-persona-snapshot',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      executionAuthority: {
        assertCurrent: jest.fn(async () => undefined),
        signal: new AbortController().signal,
        commitWhileCurrent,
      },
    } as unknown as SharedState;

    await expect(persistConversationState(
      'conversations/stale-persona-snapshot',
      state,
    )).rejects.toBe(leaseLost);
    expect(commitWhileCurrent).toHaveBeenCalledTimes(1);
    expect(persistedStates).toEqual([]);
  });

  it('fails closed when a persisted Persona snapshot has attribution but no live authority', async () => {
    const state = {
      trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: FLOW_ID,
      conversationId: 'unfenced-persona-snapshot',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
      title: 't',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SharedState;

    await expect(persistConversationState(
      'conversations/unfenced-persona-snapshot',
      state,
    )).rejects.toThrow('requires current execution authority');
    expect(persistedStates).toEqual([]);
  });
});

describe('Persona execution authority', () => {
  it('treats a Persona draft marker as immutable intent, then replaces it with trusted attribution', async () => {
    const conversationId = 'persona-draft-target';
    conversationStates.set(conversationId, {
      trackingInfo: { executionId: 'draft', startTime: 1, nodeExecutionTracker: [] },
      messages: [],
      flowId: '',
      conversationId,
      personaTargetId: 'persona-1',
      title: 'Persona draft',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SharedState);

    await expect(runFlow({
      flowId: FLOW_ID,
      prompt: 'legacy bypass',
      mode: 'conversation',
      conversationId,
    })).rejects.toThrow('must start through the Persona dispatcher');

    const attribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    };
    const behavior = behaviorFlow(FLOW_ID, 'draft-v1');
    const instructionContext = personaInstructionContext('activity-1', {
      behaviorContentHash: hashBehaviorFlow(behavior),
    });
    const result = await runFlow({
      flowDefinition: behavior,
      prompt: 'trusted dispatch',
      mode: 'conversation',
      conversationId,
      personaAttribution: attribution,
      personaInstructionContext: instructionContext,
      executionAuthority: {
        assertCurrent: jest.fn(async () => undefined),
        signal: new AbortController().signal,
      },
    });

    expect(result.sharedState.personaTargetId).toBeUndefined();
    expect(result.sharedState.personaAttribution).toEqual(attribution);
    expect(result.sharedState.flowId).toBe(behavior.id);
    expect(result.sharedState.flowSnapshot).toEqual(behavior);
    expect(result.sharedState.personaInstructionContext).toEqual(instructionContext);
    expect(persistedStates[persistedStates.length - 1]).not.toHaveProperty('personaTargetId');
  });

  it('rejects attributed execution when no Activity fence was supplied', async () => {
    await expect(runFlow({
      flowId: FLOW_ID,
      prompt: 'unsafe Persona run',
      mode: 'conversation',
      conversationId: 'persona-unfenced',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
    })).rejects.toThrow('require execution authority');
  });

  it('keeps Persona Core App bindings runtime-only and requires full dispatcher context', async () => {
    const behavior = behaviorFlow(FLOW_ID, 'apps-v1');
    const attribution = {
      personaId: 'persona-1',
      activityId: 'activity-apps',
      behaviorRevisionId: 'behavior-revision-1',
    };
    const instructionContext = personaInstructionContext('activity-apps', {
      behaviorContentHash: hashBehaviorFlow(behavior),
    });
    const authority = {
      assertCurrent: jest.fn(async () => undefined),
      signal: new AbortController().signal,
      authorizePersonaCoreMcp: jest.fn(async () => undefined),
    };

    const result = await runFlow({
      flowDefinition: behavior,
      prompt: 'use the assigned app',
      mode: 'conversation',
      conversationId: 'persona-core-app-runtime-only',
      personaAttribution: attribution,
      personaInstructionContext: instructionContext,
      personaCoreAppRefs: ['personal-computer', 'personal-computer'],
      executionAuthority: authority,
    });

    expect(result.sharedState.personaCoreAppRefs).toEqual(['personal-computer']);
    expect(Object.prototype.propertyIsEnumerable.call(
      result.sharedState,
      'personaCoreAppRefs',
    )).toBe(false);
    expect(persistedStates[persistedStates.length - 1].personaCoreAppRefs).toBeUndefined();

    await expect(runFlow({
      flowDefinition: behavior,
      prompt: 'missing trusted context',
      mode: 'conversation',
      conversationId: 'persona-core-app-untrusted',
      personaAttribution: attribution,
      personaCoreAppRefs: ['personal-computer'],
      executionAuthority: authority,
    })).rejects.toThrow('require top-level dispatcher authority, App authorization, and instruction context');

    const coldSnapshot = structuredClone(persistedStates[persistedStates.length - 1]);
    conversationStates.clear();
    mockLoadItem.mockResolvedValueOnce(coldSnapshot);
    const resumed = await runFlow({
      flowDefinition: behavior,
      prompt: 'continue after restart',
      mode: 'conversation',
      conversationId: 'persona-core-app-runtime-only',
      personaAttribution: attribution,
      personaInstructionContext: instructionContext,
      personaCoreAppRefs: ['personal-computer'],
      executionAuthority: authority,
    });
    expect(mockLoadItem).toHaveBeenCalled();
    expect(resumed.sharedState.personaCoreAppRefs).toEqual(['personal-computer']);
    expect(Object.prototype.propertyIsEnumerable.call(
      resumed.sharedState,
      'personaCoreAppRefs',
    )).toBe(false);
  });

  it('persists safe attribution but never the execution capability', async () => {
    const controller = new AbortController();
    const assertCurrent = jest.fn(async () => undefined);

    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'fenced Persona run',
      mode: 'conversation',
      conversationId: 'persona-fenced',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
      executionAuthority: { assertCurrent, signal: controller.signal },
    });

    expect(result.status).toBe('completed');
    expect(assertCurrent).toHaveBeenCalled();
    const persisted = persistedStates[persistedStates.length - 1] as SharedState & {
      executionAuthority?: unknown;
    };
    expect(persisted.personaAttribution).toEqual({
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    });
    expect(persisted.executionAuthority).toBeUndefined();
    // Legacy attributed runs remain context-free; runFlow never guesses or
    // backfills mutable Persona/Role metadata.
    expect(persisted.personaInstructionContext).toBeUndefined();
    const lifecycleEvents = (recordStatisticsEvent as jest.Mock).mock.calls
      .map(([event]) => event)
      .filter((event) => event.runId === result.runId && event.type.startsWith('run.'));
    expect(lifecycleEvents.map((event) => event.type)).toEqual(['run.started', 'run.finished']);
    expect(lifecycleEvents).toEqual(lifecycleEvents.map((event) => expect.objectContaining({
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
    })));
  });

  it('installs each Activity-pinned Behavior snapshot, rejects same-Activity drift, and refreezes its context', async () => {
    const authority = {
      assertCurrent: jest.fn(async () => undefined),
      signal: new AbortController().signal,
    };
    const firstAttribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    };
    const firstBehavior = {
      ...behaviorFlow(FLOW_ID, 'v1'),
      nodes: [{
        id: 'old-mcp-node',
        type: 'mcp',
        data: {
          type: 'mcp',
          label: 'Old MCP authority',
          properties: { boundServer: 'old-server', enabledTools: ['old_tool'] },
        },
        position: { x: 0, y: 0 },
      }],
    } as Flow;
    const firstContext = personaInstructionContext('activity-1', {
      behaviorContentHash: hashBehaviorFlow(firstBehavior),
    });
    const conversationId = 'persona-instruction-context';

    const first = await runFlow({
      flowDefinition: firstBehavior,
      prompt: 'first Activity',
      mode: 'conversation',
      conversationId,
      personaAttribution: firstAttribution,
      personaInstructionContext: firstContext,
      executionAuthority: authority,
    });
    expect(first.sharedState.personaInstructionContext).toEqual(firstContext);
    expect(first.sharedState.flowSnapshot).toEqual(firstBehavior);
    expect(persistedStates[persistedStates.length - 1].personaInstructionContext).toEqual(firstContext);

    const resumed = await runFlow({
      flowDefinition: firstBehavior,
      messages: [],
      mode: 'conversation',
      conversationId,
      personaAttribution: firstAttribution,
      personaInstructionContext: firstContext,
      executionAuthority: authority,
    });
    expect(resumed.sharedState.personaInstructionContext).toEqual(firstContext);

    await expect(runFlow({
      flowDefinition: firstBehavior,
      messages: [],
      mode: 'conversation',
      conversationId,
      personaAttribution: firstAttribution,
      personaInstructionContext: { ...firstContext, personaName: 'Changed' },
      executionAuthority: authority,
    })).rejects.toThrow('changed within one Activity');

    resumed.sharedState.frozenSystemPrompts = { [PROCESS]: 'old Persona prefix' };
    resumed.sharedState.codexSessions = {
      [PROCESS]: { sessionId: 'old-session' },
    } as unknown as SharedState['codexSessions'];
    Object.assign(resumed.sharedState, {
      mcpContext: {
        server: 'old-server',
        availableTools: [{
          name: 'old_tool',
          originalName: 'old_tool',
          server: 'old-server',
          description: 'Old Behavior tool',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
      currentMCPNodes: [{
        id: 'old-mcp-node',
        properties: { boundServer: 'old-server', enabledTools: ['old_tool'] },
      }],
      armedSyntheticTools: ['read_resource'],
      toolNameMap: { old_tool: { server: 'old-server', tool: 'old_tool' } },
      behaviorRules: [{ action: 'old_tool', resource: '*', effect: 'allow' }],
      savedBehaviorRules: [{ action: 'old_tool', resource: '*', effect: 'allow' }],
      handoffRequested: { edgeId: 'old-edge', targetNodeId: 'old-target' },
      handoffInput: { targetNodeId: 'old-target', prompt: 'stale handoff' },
      handoffNameMap: { handoff_to_old: 'old-target' },
      handoffTargetTypes: { old_target: 'process' },
      pendingSubflowReturn: { subflowNodeId: 'old-subflow', callerNodeId: PROCESS },
      subflowToolNameMap: { call_subflow_old: 'old-subflow' },
      subflowDetachedToolNameMap: { start_subflow_old: 'old-subflow' },
      subflowInvocations: { old: { id: 'old' } },
      activeSubflowInvocationByNode: { old: 'old' },
      subflowSessions: { old: { conversationId: 'old-child' } },
      subflowLane: { parentConversationId: 'old-parent' },
      launchedTaskIds: ['old-task'],
      staticInjected: { old: 'old-run' },
      pendingToolCalls: [{
        id: 'old-call',
        type: 'function',
        function: { name: 'old_tool', arguments: '{}' },
      }],
      debugPendingToolCalls: [{
        id: 'old-debug-call',
        type: 'function',
        function: { name: 'old_tool', arguments: '{}' },
      }],
      debugPendingAction: { action: 'old-edge', nodeId: PROCESS, phase: 'after-model' },
      debugPauseRequested: true,
      debugResumeAfterDetach: true,
      breakpoints: [PROCESS, 'tool:old_tool'],
      lastBreakNodeId: PROCESS,
      debugMode: true,
      executionTrace: [{ nodeId: PROCESS, nodeType: 'process' }],
      variables: { stale: 'v1' },
      todos: [{ id: 'old-todo', content: 'Old Behavior plan', status: 'pending', createdAt: 1, updatedAt: 1 }],
      mcpAppContexts: { old_app: { content: 'Old app context' } },
      turnBudgets: { [PROCESS]: 99 },
      forceSummaryTurn: true,
      capped: true,
      cappedReason: 'maxTurns',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, byNode: {} },
      logicalRunId: 'old-run',
      recovery: { version: 1, runId: 'old-run' },
      runDepth: 7,
      chainDepth: 7,
      onApprovalRequired: 'auto',
      status: 'paused_debug',
      lastResponse: 'old response',
      lastError: { message: 'old error' },
      errorEventEmitted: true,
      isCancelled: true,
      statisticsFlowName: firstBehavior.name,
      statisticsFlowRevisionId: 'old-flow-fingerprint',
    });
    const retainedRevertOperations = {
      message: {
        messageId: 'message',
        root: 'workspace',
        snapshotId: 'snapshot',
        paths: ['kept.txt'],
        createdAt: 1,
      },
    };
    resumed.sharedState.revertOperations = retainedRevertOperations;
    const messagesBeforeSuccessor = structuredClone(resumed.sharedState.messages);

    // Deliberately retain the root id while changing all authored content. The
    // compiled PocketFlow cache is id-keyed, so serialized-state cleanup alone
    // is insufficient to install this revision.
    const successorBehavior = behaviorFlow(FLOW_ID, 'v2-with-no-tools');
    const successorAttribution = {
      ...firstAttribution,
      activityId: 'activity-2',
      behaviorRevisionId: 'behavior-revision-2',
    };
    const successorContext = personaInstructionContext('activity-2', {
      behaviorRevisionId: successorAttribution.behaviorRevisionId,
      rootFlowId: successorBehavior.id,
      behaviorContentHash: hashBehaviorFlow(successorBehavior),
    });
    const executeStep = FlowExecutor.executeStep as jest.Mock;
    const previousExecuteStep = executeStep.getMockImplementation()!;
    const observedEntries: Array<{
      nodeId: string | undefined;
      flowId: string | undefined;
      staleTools: string[];
      pendingToolCalls: unknown;
      staleHandoffTarget: string | undefined;
    }> = [];
    executeStep.mockImplementation(async (state: SharedState, ...args: unknown[]) => {
      observedEntries.push({
        nodeId: state.currentNodeId,
        flowId: state.flowSnapshot?.id,
        staleTools: state.mcpContext?.availableTools.map((tool) => tool.name) ?? [],
        pendingToolCalls: state.pendingToolCalls,
        staleHandoffTarget: state.handoffNameMap?.handoff_to_old,
      });
      return previousExecuteStep(state, ...args);
    });
    const clearFlowCache = FlowExecutor.clearFlowCache as jest.Mock;
    clearFlowCache.mockClear();
    const successor = await runFlow({
      flowDefinition: successorBehavior,
      messages: [],
      variables: { fresh: 'v2' },
      mode: 'conversation',
      conversationId,
      personaAttribution: successorAttribution,
      personaInstructionContext: successorContext,
      executionAuthority: authority,
    }).finally(() => executeStep.mockImplementation(previousExecuteStep));
    expect(successor.sharedState.personaInstructionContext).toEqual(successorContext);
    expect(successor.sharedState.flowId).toBe(successorBehavior.id);
    expect(successor.sharedState.flowSnapshot).toEqual(successorBehavior);
    expect(observedEntries[0]).toEqual({
      nodeId: undefined,
      flowId: successorBehavior.id,
      staleTools: [],
      pendingToolCalls: undefined,
      staleHandoffTarget: undefined,
    });
    expect(clearFlowCache).toHaveBeenCalledTimes(1);
    expect(clearFlowCache).toHaveBeenCalledWith(FLOW_ID);
    expect(successor.sharedState.frozenSystemPrompts).toBeUndefined();
    expect(successor.sharedState.codexSessions).toBeUndefined();
    for (const key of [
      'mcpContext',
      'currentMCPNodes',
      'armedSyntheticTools',
      'toolNameMap',
      'handoffRequested',
      'handoffInput',
      'handoffNameMap',
      'handoffTargetTypes',
      'pendingSubflowReturn',
      'subflowToolNameMap',
      'subflowDetachedToolNameMap',
      'subflowInvocations',
      'activeSubflowInvocationByNode',
      'subflowSessions',
      'subflowLane',
      'launchedTaskIds',
      'staticInjected',
      'pendingToolCalls',
      'debugPendingToolCalls',
      'debugPendingAction',
      'lastBreakNodeId',
      'mcpAppContexts',
      'todos',
      'turnBudgets',
      'forceSummaryTurn',
      'capped',
      'cappedReason',
      'usage',
    ] as const) {
      expect(successor.sharedState[key]).toBeUndefined();
    }
    expect(successor.sharedState.behaviorRules).toEqual(successorBehavior.behaviorRules ?? []);
    expect(successor.sharedState.savedBehaviorRules).toEqual(successorBehavior.behaviorRules ?? []);
    expect(successor.sharedState.variables).toEqual({ fresh: 'v2' });
    expect(successor.sharedState.breakpoints).toEqual([]);
    expect(successor.sharedState.revertOperations).toEqual(retainedRevertOperations);
    expect(successor.sharedState.messages.slice(0, messagesBeforeSuccessor.length))
      .toEqual(messagesBeforeSuccessor);
    expect(successor.sharedState.logicalRunId).not.toBe('old-run');
    expect(successor.sharedState.recovery?.runId).toBe(successor.sharedState.logicalRunId);
    expect(successor.sharedState.statisticsFlowName).toBe(successorBehavior.name);
    expect(successor.sharedState.statisticsFlowRevisionId).not.toBe('old-flow-fingerprint');

    await expect(runFlow({
      flowDefinition: { ...successorBehavior, name: 'tampered same-Activity Behavior' },
      messages: [],
      mode: 'conversation',
      conversationId,
      personaAttribution: successorAttribution,
      personaInstructionContext: successorContext,
      executionAuthority: authority,
    })).rejects.toThrow('does not match the attributed immutable revision');
  });

  it('rejects Persona identity instructions on a subflow child input', async () => {
    const context = personaInstructionContext();
    await expect(runFlowWithContext({
      flowId: FLOW_ID,
      prompt: 'child',
      mode: 'ephemeral',
      source: 'subflow',
      parentRunId: 'parent-conversation',
      personaAttribution: {
        personaId: context.personaId,
        activityId: context.activityId,
        behaviorRevisionId: context.behaviorRevisionId,
      },
      personaInstructionContext: context,
      executionAuthority: {
        assertCurrent: jest.fn(async () => undefined),
        signal: new AbortController().signal,
      },
    })).rejects.toThrow('confined to its top-level Behavior run');
  });

  it('suppresses a stale terminal flow event after delayed flow lookup while the successor publishes', async () => {
    (global as unknown as { __flujo_flow_run_event_bus?: unknown }).__flujo_flow_run_event_bus = undefined;
    const events: FlowEvent[] = [];
    const unsubscribe = getFlowRunEventBus().subscribe((event) => events.push(event));
    const getFlowMock = flowService.getFlow as jest.Mock;
    const executeStepMock = FlowExecutor.executeStep as jest.Mock;
    const previousGetFlow = getFlowMock.getMockImplementation()!;
    const previousExecuteStep = executeStepMock.getMockImplementation()!;
    let executionFinished = false;
    let terminalLookupCount = 0;
    let announceTerminalLookup!: () => void;
    const terminalLookupStarted = new Promise<void>((resolve) => {
      announceTerminalLookup = resolve;
    });
    let releaseStaleLookup!: (flow: { id: string; name: string; nodes: never[]; edges: never[] }) => void;
    const staleLookup = new Promise<{ id: string; name: string; nodes: never[]; edges: never[] }>((resolve) => {
      releaseStaleLookup = resolve;
    });
    const flow = { id: FLOW_ID, name: 'TestFlow', nodes: [] as never[], edges: [] as never[] };
    let currentGeneration = 1;
    const authorityFor = (generation: number): FlowExecutionAuthority => {
      const assertCurrent = jest.fn(async () => {
        if (currentGeneration !== generation) {
          throw new Error(`generation ${generation} lost terminal publication authority`);
        }
      });
      const commitWhileCurrent = jest.fn(async (task: () => Promise<unknown>) => {
        await assertCurrent();
        return task();
      }) as unknown as NonNullable<FlowExecutionAuthority['commitWhileCurrent']>;
      return {
        assertCurrent,
        signal: new AbortController().signal,
        commitWhileCurrent,
      };
    };
    const attribution = {
      personaId: 'persona-terminal',
      activityId: 'activity-old',
      behaviorRevisionId: 'revision-1',
    };

    getFlowMock.mockImplementation(async () => {
      if (executionFinished && terminalLookupCount++ === 0) {
        announceTerminalLookup();
        return staleLookup;
      }
      return flow;
    });
    executeStepMock.mockImplementation(async (sharedState: SharedState) => {
      const nodeId = sharedState.currentNodeId ?? START;
      sharedState.currentNodeId = nodeId;
      if (nodeId === START) {
        return { sharedState, action: `${START}->${PROCESS}` };
      }
      sharedState.lastResponse = 'generation-safe result';
      sharedState.messages.push({
        role: 'assistant',
        content: 'generation-safe result',
        id: `assistant-${currentGeneration}`,
        timestamp: currentGeneration,
        processNodeId: PROCESS,
      });
      executionFinished = true;
      return { sharedState, action: 'FINAL_RESPONSE' };
    });

    try {
      const staleRun = runFlow({
        flowId: FLOW_ID,
        prompt: 'old generation',
        mode: 'ephemeral',
        conversationId: 'persona-terminal-old',
        personaAttribution: attribution,
        executionAuthority: authorityFor(1),
      });
      await terminalLookupStarted;
      currentGeneration = 2;
      releaseStaleLookup(flow);
      await staleRun;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(events).toEqual([]);

      executionFinished = false;
      await runFlow({
        flowId: FLOW_ID,
        prompt: 'successor generation',
        mode: 'ephemeral',
        conversationId: 'persona-terminal-successor',
        personaAttribution: { ...attribution, activityId: 'activity-successor' },
        executionAuthority: authorityFor(2),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        flowId: FLOW_ID,
        conversationId: 'persona-terminal-successor',
        status: 'completed',
        outputText: 'generation-safe result',
      });
    } finally {
      unsubscribe();
      getFlowMock.mockImplementation(previousGetFlow);
      executeStepMock.mockImplementation(previousExecuteStep);
    }
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
    // A run fetches the flow more than once (e.g. the statistics flow-name
    // snapshot before the replay guard), so serve the node-bearing flow for
    // EVERY call rather than just the first one.
    const getFlowMock = flowService.getFlow as jest.Mock;
    const previousGetFlow = getFlowMock.getMockImplementation()!;
    getFlowMock.mockImplementation(async () => ({
      id: FLOW_ID,
      name: 'TestFlow',
      nodes: [{ id: START, type: 'start' }, { id: PROCESS, type: 'process' }],
    }));
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
      getFlowMock.mockImplementation(previousGetFlow);
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

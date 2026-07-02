/**
 * execution-core-v2 Phase 3, slice B — dual-write through runFlow.
 *
 * The append-only conversation log is fed two ways:
 *  - the ExecutionEventBus tap (every emitted event, incl. the run loop's
 *    message emissions), and
 *  - runFlow's turn-start reconcile (this turn's input, edits and pruned
 *    messages — the chat client sends its FULL history each turn and runFlow
 *    replaces the state's messages with it).
 *
 * These tests pin the Phase 3 invariants at the runFlow level:
 *  1. after a conversation run, the log's projection equals the state's
 *     messages MINUS system-role messages;
 *  2. an ephemeral run leaves NO log file (policy chokepoint end-to-end);
 *  3. a pruned/edited resume produces message:removed / upsert events;
 *  4. a legacy conversation (state on disk, no log) bootstraps its full
 *     history into the log on first resume.
 *
 * Engine/storage mocking mirrors runFlow.test.ts: the engine is a tiny
 * start->process->finish stub, storage is mocked BELOW the chokepoints.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { SharedState } from '@/backend/execution/flow/types';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const FLOW_ID = 'flow-1';

const storedStates = new Map<string, SharedState>();

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const S = '077cfac0-start';
  const P = 'ef2a3c01-process';
  const EDGE = `${S}->${P}`;
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep: jest.fn(async (sharedState: any) => {
        const nodeId = sharedState.currentNodeId ?? S;
        sharedState.currentNodeId = nodeId;
        if (nodeId === S) {
          return { sharedState, action: EDGE };
        }
        sharedState.lastResponse = 'answer';
        sharedState.messages.push({
          role: 'assistant',
          content: 'answer',
          id: `assistant-${sharedState.messages.length}`,
          timestamp: 10,
          processNodeId: P,
        });
        return { sharedState, action: 'FINAL_RESPONSE' };
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

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string) => storedStates.get(key)),
  saveItem: jest.fn(async (key: string, value: any) => {
    storedStates.set(key, JSON.parse(JSON.stringify(value)));
  }),
}));

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    loadFlows: jest.fn(async () => [{ id: 'flow-1', name: 'TestFlow' }]),
    getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'TestFlow' })),
  },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: jest.fn(async () => ({ issues: [], errorCount: 0, warningCount: 0, isRunnable: true })),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  readConversationLog,
  projectMessages,
  flushConversationLog,
  hasConversationLog,
  _setConversationLogDirForTests,
} from '@/backend/execution/flow/conversationLog';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-dualwrite-'));
  previousDir = _setConversationLogDirForTests(tmpDir);
});

afterAll(async () => {
  _setConversationLogDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  storedStates.clear();
  conversationStates.clear();
});

const nonSystem = (messages: SharedState['messages']) => messages.filter(m => m.role !== 'system');

describe('dual-write: run events land in the conversation log', () => {
  it('projection equals the run transcript minus system messages (new conversation)', async () => {
    const convId = 'dw-new-conversation';
    const result = await runFlow({
      flowId: FLOW_ID,
      conversationId: convId,
      messages: [{ role: 'user', content: 'hi', id: 'user-1', timestamp: 1 }],
      mode: 'conversation',
    });
    expect(result.status).toBe('completed');
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    expect(events).toBeDefined();
    // Structural events from the bus tap made it too (run:start before run:done).
    const types = events!.map(e => e.type);
    expect(types).toContain('run:start');
    expect(types).toContain('run:done');

    const projected = projectMessages(events!);
    expect(projected.map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual(
      nonSystem(result.sharedState.messages).map(m => ({ id: m.id, role: m.role, content: m.content }))
    );
  });

  it('projection excludes a node system prompt written into the transcript', async () => {
    const convId = 'dw-system-excluded';
    (FlowExecutor.executeStep as jest.Mock)
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.currentNodeId = START;
        return { sharedState, action: `${START}->${PROCESS}` };
      })
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.currentNodeId = PROCESS;
        sharedState.messages = [
          { role: 'system', content: 'NODE PROMPT', id: 'sys-1', timestamp: 2 },
          ...sharedState.messages,
          { role: 'assistant', content: 'answer', id: 'assistant-1', timestamp: 3, processNodeId: PROCESS },
        ];
        sharedState.lastResponse = 'answer';
        return { sharedState, action: 'FINAL_RESPONSE' };
      });

    const result = await runFlow({
      flowId: FLOW_ID,
      conversationId: convId,
      messages: [{ role: 'user', content: 'task', id: 'user-1', timestamp: 1 }],
      mode: 'conversation',
    });
    expect(result.status).toBe('completed');
    await flushConversationLog(convId);

    const projected = projectMessages((await readConversationLog(convId))!);
    expect(projected.map(m => m.id)).toEqual(['user-1', 'assistant-1']);
    expect(projected.some(m => m.role === 'system')).toBe(false);
  });

  it('an ephemeral run leaves NO log file (policy chokepoint end-to-end)', async () => {
    const result = await runFlow({
      flowId: FLOW_ID,
      prompt: 'ephemeral',
      mode: 'ephemeral',
    });
    expect(result.status).toBe('completed');
    await flushConversationLog(result.conversationId);
    expect(await hasConversationLog(result.conversationId)).toBe(false);
  });
});

describe('turn-start reconcile: pruned/edited client history', () => {
  it('records removals and upserts when the client sends a reduced/edited history', async () => {
    const convId = 'dw-reconcile-prune';
    // Turn 1: normal run → [user-1, assistant-1].
    const first = await runFlow({
      flowId: FLOW_ID,
      conversationId: convId,
      messages: [{ role: 'user', content: 'first ask', id: 'user-1', timestamp: 1 }],
      mode: 'conversation',
      userTurn: true,
    });
    expect(first.status).toBe('completed');
    const assistantId = nonSystem(first.sharedState.messages).find(m => m.role === 'assistant')!.id;

    // Turn 2: the client disabled the assistant turn (pruned) and edited the
    // user message, then sent the full remaining history plus a new turn.
    (FlowExecutor.executeStep as jest.Mock)
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.currentNodeId = START;
        return { sharedState, action: `${START}->${PROCESS}` };
      })
      .mockImplementationOnce(async (sharedState: any) => {
        sharedState.currentNodeId = PROCESS;
        sharedState.messages.push({
          role: 'assistant', content: 'second answer', id: 'assistant-turn2', timestamp: 20, processNodeId: PROCESS,
        });
        sharedState.lastResponse = 'second answer';
        return { sharedState, action: 'FINAL_RESPONSE' };
      });
    const second = await runFlow({
      flowId: FLOW_ID,
      conversationId: convId,
      messages: [
        { role: 'user', content: 'first ask (edited)', id: 'user-1', timestamp: 1 },
        { role: 'user', content: 'second ask', id: 'user-2', timestamp: 15 },
      ],
      mode: 'conversation',
      userTurn: true,
    });
    expect(second.status).toBe('completed');
    await flushConversationLog(convId);

    const events = await readConversationLog(convId);
    const removed = events!.filter(e => e.type === 'message:removed');
    expect(removed.map(e => (e as any).messageId)).toEqual([assistantId]);

    const projected = projectMessages(events!);
    expect(projected.map(m => ({ id: m.id, content: m.content }))).toEqual([
      { id: 'user-1', content: 'first ask (edited)' },
      { id: 'user-2', content: 'second ask' },
      { id: 'assistant-turn2', content: 'second answer' },
    ]);
    // The projection tracks the state's transcript exactly.
    expect(projected.map(m => m.id)).toEqual(nonSystem(second.sharedState.messages).map(m => m.id));
  });
});

describe('legacy bootstrap: conversations from before the log existed', () => {
  it('bootstraps the full history (minus system) into the log on first resume', async () => {
    const convId = 'dw-legacy-bootstrap';
    // A legacy persisted state: leading node system prompt, prior exchange.
    storedStates.set(`conversations/${convId}`, {
      trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] },
      messages: [
        { role: 'system', content: 'OLD NODE PROMPT', id: 'sys-legacy', timestamp: 1 },
        { role: 'user', content: 'old question', id: 'user-old', timestamp: 2 },
        { role: 'assistant', content: 'old answer', id: 'assistant-old', timestamp: 3, processNodeId: PROCESS },
      ],
      flowId: FLOW_ID,
      conversationId: convId,
      currentNodeId: PROCESS,
      status: 'completed',
      title: 'legacy',
      createdAt: 1,
      updatedAt: 3,
    } as unknown as SharedState);

    (FlowExecutor.executeStep as jest.Mock).mockImplementationOnce(async (sharedState: any) => {
      sharedState.currentNodeId = PROCESS;
      sharedState.messages.push({
        role: 'assistant', content: 'fresh answer', id: 'assistant-new', timestamp: 30, processNodeId: PROCESS,
      });
      sharedState.lastResponse = 'fresh answer';
      return { sharedState, action: 'FINAL_RESPONSE' };
    });

    const result = await runFlow({
      flowId: FLOW_ID,
      conversationId: convId,
      messages: [
        // The client's view of the history (it round-trips what GET returned).
        { role: 'system', content: 'OLD NODE PROMPT', id: 'sys-legacy', timestamp: 1 },
        { role: 'user', content: 'old question', id: 'user-old', timestamp: 2 },
        { role: 'assistant', content: 'old answer', id: 'assistant-old', timestamp: 3, processNodeId: PROCESS },
        { role: 'user', content: 'new question', id: 'user-new', timestamp: 20 },
      ],
      mode: 'conversation',
      userTurn: true,
    });
    expect(result.status).toBe('completed');
    await flushConversationLog(convId);

    const projected = projectMessages((await readConversationLog(convId))!);
    expect(projected.map(m => m.id)).toEqual(['user-old', 'assistant-old', 'user-new', 'assistant-new']);
    expect(projected.some(m => m.role === 'system')).toBe(false);
  });
});

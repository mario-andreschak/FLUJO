/**
 * Mid-run steering: a user message submitted while a run is ALREADY in flight is
 * folded into that run at its next safe boundary, so a correction reaches the
 * model that is going the wrong way instead of waiting for the whole run to
 * finish and then starting a separate turn.
 *
 * What these tests pin down:
 *   1. A waiting message is folded in BEFORE the next step (so the next model
 *      call sees it), not after the run ends.
 *   2. The drain never splits an assistant `tool_calls` turn from its results —
 *      the shape every provider 400s on (the same invariant issue #256 repairs
 *      after a crash). It defers to the next iteration instead.
 *   3. A message that lands as the run is completing keeps the run going to
 *      answer it, rather than being stranded in the inbox.
 *
 * As in the sibling chat tests the engine is stubbed with a scripted
 * executeStep, so there is no network/model call.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

const START = '077cfac0-start';
const PROCESS = 'ef2a3c01-process';
const EDGE = `${START}->${PROCESS}`;
const FINAL = 'FINAL_RESPONSE';
const FLOW_ID = 'flow-1';

/** Scripted steps, consumed one per executeStep call by the stubbed engine. */
type Step = (s: SharedState) => string;
const script: Step[] = [];

jest.mock('@/backend/execution/flow/FlowExecutor', () => {
  const conversationStates = new Map();
  return {
    FlowExecutor: {
      conversationStates,
      clearFlowCache: jest.fn(),
      executeStep: jest.fn(async (sharedState: any) => {
        const step = (global as any).__steeringScript.shift();
        if (!step) throw new Error('executeStep called more times than the script provides');
        const action = step(sharedState);
        return { sharedState, action };
      }),
      resolveHandoff: jest.fn(async (_sharedState: any, action: string) =>
        action === '077cfac0-start->ef2a3c01-process'
          ? { isSuccessorEdge: true, targetNodeId: 'ef2a3c01-process' }
          : { isSuccessorEdge: false, targetNodeId: null }
      ),
      peekNextNodeId: jest.fn(async (sharedState: any) => sharedState.currentNodeId ?? '077cfac0-start'),
    },
  };
});

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(async () => undefined),
  assertSafeCollectionId: () => undefined,
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

// The append-only log does real filesystem IO; steering only needs to know that
// the fold-in is recorded, so capture the appends instead of writing files.
const loggedMessages: FlujoChatMessage[] = [];
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  reconcileConversationLog: jest.fn(async () => undefined),
  recoverMessagesFromLog: jest.fn(async () => undefined),
  repairDanglingToolCalls: jest.fn(() => []),
  appendRawForState: jest.fn(async (_state: any, raws: any[]) => {
    for (const raw of raws) if (raw?.message) loggedMessages.push(raw.message);
  }),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  enqueueSteeringMessage,
  peekSteeringMessages,
  clearSteeringInbox,
} from '@/backend/execution/flow/steeringInbox';

(global as any).__steeringScript = script;

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const steering = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'user', content, id, timestamp: 1, injected: true } as FlujoChatMessage);

/** A step that answers with plain text and ends the run. */
const finalStep = (text: string): Step => (s) => {
  s.currentNodeId = PROCESS;
  s.lastResponse = text;
  s.messages.push({ role: 'assistant', content: text, id: `a-${text}`, timestamp: 1, processNodeId: PROCESS } as FlujoChatMessage);
  return FINAL;
};

/** A step that just advances an edge (the run keeps looping). */
const advanceStep = (): Step => (s) => {
  s.currentNodeId = PROCESS;
  return EDGE;
};

beforeEach(() => {
  script.length = 0;
  loggedMessages.length = 0;
  conversationStates.clear();
  (FlowExecutor.executeStep as jest.Mock).mockClear();
});

describe('mid-run steering', () => {
  it('folds a waiting message in BEFORE the next step, not after the run', async () => {
    const convId = 'conv-steer-basic';
    clearSteeringInbox(convId);
    enqueueSteeringMessage(convId, steering('actually, use Python', 's1'));

    // The single step asserts what the model would see when it is invoked.
    let seenAtStepTime: string[] = [];
    script.push((s) => {
      seenAtStepTime = s.messages.map((m) => String(m.content));
      return finalStep('done')(s);
    });

    const result = await runFlow({ flowId: FLOW_ID, prompt: 'do the thing', conversationId: convId, mode: 'conversation' });

    expect(result.status).toBe('completed');
    // The correction was already in context when the step ran — the whole point.
    expect(seenAtStepTime).toEqual(['do the thing', 'actually, use Python']);
    expect(peekSteeringMessages(convId)).toHaveLength(0);
    // ...and it was recorded in the append-only log, not just held in memory.
    expect(loggedMessages.map((m) => m.id)).toContain('s1');
  });

  it('delivers a message that arrives MID-run on the very next step', async () => {
    const convId = 'conv-steer-midrun';
    clearSteeringInbox(convId);

    const seen: string[][] = [];
    // Step 1 runs with no steering message, and enqueues one while "working".
    script.push((s) => {
      seen.push(s.messages.map((m) => String(m.content)));
      enqueueSteeringMessage(convId, steering('stop — wrong direction', 's1'));
      return advanceStep()(s);
    });
    // Step 2 must already see it.
    script.push((s) => {
      seen.push(s.messages.map((m) => String(m.content)));
      return finalStep('ok, corrected')(s);
    });

    await runFlow({ flowId: FLOW_ID, prompt: 'start', conversationId: convId, mode: 'conversation' });

    expect(seen[0]).toEqual(['start']);
    expect(seen[1]).toEqual(['start', 'stop — wrong direction']);
  });

  it('defers the fold-in while a tool exchange is unresolved, then delivers it', async () => {
    const convId = 'conv-steer-toolgap';
    clearSteeringInbox(convId);

    const seen: string[][] = [];
    // Step 1 leaves an assistant tool_calls turn with NO result yet.
    script.push((s) => {
      s.currentNodeId = PROCESS;
      s.messages.push({
        role: 'assistant',
        content: '',
        id: 'a-call',
        timestamp: 1,
        processNodeId: PROCESS,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      } as FlujoChatMessage);
      enqueueSteeringMessage(convId, steering('never mind, skip it', 's1'));
      return EDGE;
    });
    // Step 2 sees the unanswered call still unanswered — the steering message
    // must NOT have been wedged between the call and its result.
    script.push((s) => {
      seen.push(s.messages.map((m) => m.id));
      s.messages.push({ role: 'tool', tool_call_id: 'call_1', content: 'r', id: 't-1', timestamp: 1 } as FlujoChatMessage);
      return EDGE;
    });
    // Step 3: the exchange is settled, so the message lands now.
    script.push((s) => {
      seen.push(s.messages.map((m) => m.id));
      return finalStep('done')(s);
    });

    await runFlow({ flowId: FLOW_ID, prompt: 'go', conversationId: convId, mode: 'conversation' });

    // Deferred: still just the user turn + the dangling call.
    expect(seen[0]).not.toContain('s1');
    expect(seen[0][seen[0].length - 1]).toBe('a-call');
    // Delivered once the result closed the exchange, and ordered AFTER it.
    expect(seen[1]).toEqual([expect.any(String), 'a-call', 't-1', 's1']);
  });

  it('keeps the run going when a message arrives as it completes', async () => {
    const convId = 'conv-steer-lastgasp';
    clearSteeringInbox(convId);

    const seen: string[][] = [];
    // Step 1 produces the final answer AND a message arrives during it.
    script.push((s) => {
      enqueueSteeringMessage(convId, steering('one more thing', 's1'));
      return finalStep('first answer')(s);
    });
    // Because the message was waiting, the run must not stop here.
    script.push((s) => {
      seen.push(s.messages.map((m) => String(m.content)));
      return finalStep('second answer')(s);
    });

    const result = await runFlow({ flowId: FLOW_ID, prompt: 'go', conversationId: convId, mode: 'conversation' });

    expect(FlowExecutor.executeStep).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual(['go', 'first answer', 'one more thing']);
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('second answer');
  });
});

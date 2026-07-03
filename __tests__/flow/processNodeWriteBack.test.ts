/**
 * execution-core-v2 Phase 3, slice D — no node system prompt in the transcript.
 *
 * ProcessNode.prep prepends the node's freshly rendered system prompt to the
 * model's WIRE view (buildNodeContext); post used to write that whole list back
 * to SharedState.messages, so every persisted conversation led with a system
 * message (displayed in the chat, round-tripped by the client, special-cased in
 * the emitter and GET). post now writes back the transcript WITHOUT system
 * messages. Nothing is lost: prep re-renders the prompt every step and
 * buildNodeContext drops stale system messages anyway.
 */
import type { SharedState, ProcessNodePrepResult, ProcessNodeExecResult } from '@/backend/execution/flow/types';
import { FINAL_RESPONSE_ACTION } from '@/backend/execution/flow/types';
import { ProcessNode } from '@/backend/execution/flow/nodes';
import type { FlujoChatMessage } from '@/shared/types/chat';

const makeState = (): SharedState =>
  ({
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
  } as SharedState);

const msg = (role: FlujoChatMessage['role'], content: string, id: string): FlujoChatMessage =>
  ({ role, content, id, timestamp: 1 } as FlujoChatMessage);

describe('ProcessNode.post write-back (system prompt excluded)', () => {
  it('writes the exec transcript back WITHOUT system messages', async () => {
    const node = new ProcessNode();
    const state = makeState();

    const prepResult: ProcessNodePrepResult = {
      nodeId: 'p1',
      nodeType: 'process',
      currentPrompt: 'NODE PROMPT',
      boundModel: 'model-1',
      messages: [],
    };
    const execResult: ProcessNodeExecResult = {
      success: true,
      content: 'answer',
      messages: [
        msg('system', 'NODE PROMPT', 'sys-1'), // prep's wire-view system message
        msg('user', 'task', 'u1'),
        msg('assistant', 'answer', 'a1'),
      ],
    };

    const action = await node.post(prepResult, execResult, state, {
      id: 'p1',
      label: 'P',
      type: 'process',
      properties: {},
    });

    expect(action).toBe(FINAL_RESPONSE_ACTION);
    expect(state.messages.map(m => ({ role: m.role, id: m.id }))).toEqual([
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1' },
    ]);
    expect(state.lastResponse).toBe('answer');
  });
});

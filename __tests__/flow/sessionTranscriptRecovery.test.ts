import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

const loadState = jest.fn();
const replaceTranscript = jest.fn();
const summarize = jest.fn();

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadState(...args),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  replaceConversationTranscript: (...args: unknown[]) => replaceTranscript(...args),
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: jest.fn().mockResolvedValue({
      id: 'child',
      name: 'Child',
      nodes: [{ id: 'process', type: 'process', data: { properties: { boundModel: 'model-1' } } }],
      edges: [],
    }),
  },
}));
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    summarizeSessionHistory: (...args: unknown[]) => summarize(...args),
  },
}));

import { prepareResumedSessionTranscript } from '@/backend/execution/flow/sessionTranscriptPolicy';

const message = (id: string, role: FlujoChatMessage['role'], content: string): FlujoChatMessage => ({
  id,
  role,
  content,
  timestamp: 1,
} as FlujoChatMessage);

const state = (messages: FlujoChatMessage[]): SharedState => ({
  trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
  messages,
  flowId: 'child',
  conversationId: 'conversation-1',
  title: 'Child',
  createdAt: 1,
  updatedAt: 1,
} as SharedState);

describe('resumed Subflow transcript recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies a missing registered child without mutating persistence', async () => {
    loadState.mockResolvedValue(undefined);

    await expect(prepareResumedSessionTranscript({
      conversationId: 'missing',
      childFlowId: 'child',
      inputMode: 'resume',
    })).resolves.toEqual({ kind: 'recovery', reason: 'missing' });
    expect(replaceTranscript).not.toHaveBeenCalled();
  });

  it('classifies corrupt tool ordering without rewriting the child', async () => {
    loadState.mockResolvedValue(state([
      message('u', 'user', 'task'),
      { ...message('t', 'tool', 'orphan'), tool_call_id: 'missing' } as FlujoChatMessage,
    ]));

    const result = await prepareResumedSessionTranscript({
      conversationId: 'conversation-1',
      childFlowId: 'child',
      inputMode: 'resume',
    });
    expect(result).toMatchObject({ kind: 'recovery', reason: 'corrupt' });
    expect(replaceTranscript).not.toHaveBeenCalled();
  });

  it('keeps resume history on empty summary but still applies the hard cap', async () => {
    const messages = [
      message('u1', 'user', 'one'),
      message('a1', 'assistant', 'done one'),
      message('u2', 'user', 'two'),
      message('a2', 'assistant', 'done two'),
    ];
    const child = state(messages);
    loadState.mockResolvedValue(child);
    summarize.mockResolvedValue('');

    const result = await prepareResumedSessionTranscript({
      conversationId: 'conversation-1',
      childFlowId: 'child',
      inputMode: 'summary',
      sessionTurnCap: 1,
    });

    expect(result).toMatchObject({ kind: 'valid', summarized: false, trimmedTurns: 2 });
    expect(replaceTranscript).toHaveBeenCalledWith(child, []);
  });
});

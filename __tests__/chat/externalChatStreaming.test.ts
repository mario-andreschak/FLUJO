jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn() }));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));

import { createStreamingResponse, processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';

const turn = () => ({
  messages: [],
  remember: jest.fn(async () => undefined),
  release: jest.fn(async () => undefined),
});

async function readAll(response: Response): Promise<string> {
  return new Response(response.body).text();
}

afterEach(() => FlowExecutor.conversationStates.clear());
beforeEach(() => jest.mocked(runFlow).mockReset());

describe('recording a finished turn for an outside chat app', () => {
  it('records exactly the text the app was streamed, across every message', async () => {
    const id = 'external-stream';
    const externalTurn = turn();
    FlowExecutor.conversationStates.set(id, {
      conversationId: id,
      status: 'running',
      messages: [{ id: 'second', role: 'assistant', content: 'Second' }],
    } as never);

    const response = createStreamingResponse('flow-Test', id, undefined, undefined, undefined, undefined, externalTurn);
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'first', delta: 'Fir' });
    executionEventBus.emit(id, { type: 'model:delta', messageId: 'first', delta: 'st ' });
    executionEventBus.emit(id, { type: 'message', message: { id: 'first', role: 'assistant', content: 'First ', timestamp: 1 } });
    executionEventBus.emit(id, { type: 'message', message: { id: 'second', role: 'assistant', content: 'Second', timestamp: 2 } });
    executionEventBus.emit(id, { type: 'run:done', status: 'completed' });
    await readAll(response);

    expect(externalTurn.remember).toHaveBeenCalledWith('First Second', id, 'second');
  });

  it('records nothing when a streamed run fails', async () => {
    const id = 'external-stream-error';
    const externalTurn = turn();
    FlowExecutor.conversationStates.set(id, { conversationId: id, status: 'running', messages: [] } as never);

    const response = createStreamingResponse('flow-Test', id, undefined, undefined, undefined, undefined, externalTurn);
    executionEventBus.emit(id, { type: 'run:start', flowId: 'f' });
    executionEventBus.emit(id, { type: 'run:done', status: 'error' });
    await readAll(response);

    expect(externalTurn.remember).not.toHaveBeenCalled();
  });

  const request = { model: 'flow-Test', messages: [{ role: 'user', content: 'hello' }], stream: false };
  const finished = (status: string) => ({
    status,
    conversationId: 'conversation-a',
    outputText: 'hi there',
    messages: [],
    finalAction: 'FINAL_RESPONSE',
    sharedState: { status, messages: [{ id: 'last', role: 'assistant' }] },
  });

  it('records a finished reply that was not streamed', async () => {
    const externalTurn = turn();
    jest.mocked(runFlow).mockResolvedValue(finished('completed') as never);

    await processChatCompletion(request as never, false, false, false, undefined, false, true, undefined, undefined, externalTurn);

    expect(externalTurn.remember).toHaveBeenCalledWith('hi there', 'conversation-a', 'last');
  });

  it('records nothing for a turn waiting on approval', async () => {
    const externalTurn = turn();
    jest.mocked(runFlow).mockResolvedValue(finished('awaiting_tool_approval') as never);

    await processChatCompletion(request as never, false, false, false, undefined, false, true, undefined, undefined, externalTurn);

    expect(externalTurn.remember).not.toHaveBeenCalled();
  });
});

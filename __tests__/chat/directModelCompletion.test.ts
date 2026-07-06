/**
 * Tests for issue #53 — /v1/chat/completions routing between `flow-` and
 * `model-` requests.
 *
 *  - `model-<id>` requests go to ModelService.generateChatCompletion (single
 *    turn) and NEVER touch runFlow.
 *  - `flow-` and legacy/unprefixed ids keep going to runFlow with identical
 *    arguments (regression guard).
 *  - non-streaming `model-` requests return the OpenAI-shaped completion /
 *    error envelope with the mapped status.
 *  - streaming `model-` requests emit the emulated SSE framing: role chunk →
 *    content chunk → finish chunk → [DONE].
 *
 * FlowExecutor / runFlow / modelService are mocked so importing the service
 * doesn't pull the whole engine.
 */
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));

jest.mock('@/backend/services/model', () => ({
  modelService: { generateChatCompletion: jest.fn() },
}));

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { modelService } from '@/backend/services/model';

const generateChatCompletion = modelService.generateChatCompletion as jest.Mock;
const runFlowMock = runFlow as jest.Mock;

const completionFixture = () => ({
  id: 'chatcmpl-direct-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'model-GPT Test',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello from the model' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
});

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  generateChatCompletion.mockReset();
  runFlowMock.mockReset();
});

describe('model- routing on /v1/chat/completions', () => {
  it('routes a non-streaming model- request to ModelService and returns the completion', async () => {
    generateChatCompletion.mockResolvedValue({ success: true, completion: completionFixture() });

    const res = await processChatCompletion(
      {
        model: 'model-GPT Test',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.3,
        tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
      } as any,
      // Flow-only flags must be ignored on this path.
      true, true, true, 'conv-should-be-ignored'
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(completionFixture());

    expect(generateChatCompletion).toHaveBeenCalledWith({
      modelIdentifier: 'GPT Test',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.3,
      tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
    });
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('maps a resolution failure to the OpenAI error envelope with the given status', async () => {
    generateChatCompletion.mockResolvedValue({
      success: false,
      statusCode: 404,
      error: { message: 'Model not found: model-nope', type: 'invalid_request_error', code: 'model_not_found', param: 'model' },
    });

    const res = await processChatCompletion(
      { model: 'model-nope', messages: [{ role: 'user', content: 'Hi' }] } as any,
      false, false, false
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.type).toBe('invalid_request_error');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('emulates SSE streaming: role chunk → content chunk → finish chunk → [DONE]', async () => {
    generateChatCompletion.mockResolvedValue({ success: true, completion: completionFixture() });

    const res = await processChatCompletion(
      { model: 'model-GPT Test', messages: [{ role: 'user', content: 'Hi' }], stream: true } as any,
      false, false, false
    );

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const raw = await readAll(res as unknown as Response);

    const chunks = raw
      .split('\n\n')
      .filter(l => l.startsWith('data: '))
      .map(l => l.slice('data: '.length));
    expect(chunks[chunks.length - 1]).toBe('[DONE]');

    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c));
    // 1) role announcement
    expect(parsed[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(parsed[0].object).toBe('chat.completion.chunk');
    expect(parsed[0].model).toBe('model-GPT Test');
    // 2) full assistant text as one content chunk
    expect(parsed[1].choices[0].delta).toEqual({ content: 'Hello from the model' });
    expect(parsed[1].choices[0].finish_reason).toBeNull();
    // 3) empty-delta terminator carrying the finish reason
    expect(parsed[2].choices[0].delta).toEqual({});
    expect(parsed[2].choices[0].finish_reason).toBe('stop');

    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('streams tool_calls as an indexed delta when the model answers with tools', async () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
    ];
    generateChatCompletion.mockResolvedValue({
      success: true,
      completion: {
        ...completionFixture(),
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
      },
    });

    const res = await processChatCompletion(
      { model: 'model-GPT Test', messages: [{ role: 'user', content: 'Hi' }], stream: true } as any,
      false, false, false
    );
    const raw = await readAll(res as unknown as Response);
    const parsed = raw
      .split('\n\n')
      .filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map(l => JSON.parse(l.slice('data: '.length)));

    const toolChunk = parsed.find(p => p.choices[0].delta.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls).toEqual([{ index: 0, ...toolCalls[0] }]);
    const finishChunk = parsed[parsed.length - 1];
    expect(finishChunk.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('flow- regression on /v1/chat/completions', () => {
  it.each(['flow-Test', 'Test'])('still routes %s into runFlow with identical arguments', async (modelId) => {
    // flowNotFound is the cheapest complete runFlow result — the assertion is
    // about the arguments reaching runFlow, not about flow execution itself.
    runFlowMock.mockResolvedValue({ flowNotFound: { name: modelId } });

    const res = await processChatCompletion(
      { model: modelId, messages: [{ role: 'user', content: 'Hi' }] } as any,
      true, false, true, 'conv-1'
    );

    expect(runFlowMock).toHaveBeenCalledWith({
      modelName: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      processNodeId: undefined,
      mode: 'conversation',
      conversationId: 'conv-1',
      flujo: true,
      requireApproval: false,
      debug: true,
      continueDebug: false,
      userTurn: false,
    });
    expect(generateChatCompletion).not.toHaveBeenCalled();
    expect(res.status).toBe(400); // flow_not_found behavior unchanged
  });
});

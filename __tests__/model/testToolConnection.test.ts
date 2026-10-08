const mockChatCreate = jest.fn();
const mockResponsesCreate = jest.fn();
jest.mock('@/backend/services/model/openaiClient', () => ({
  ...jest.requireActual('@/backend/services/model/openaiClient'),
  createOpenAIClient: jest.fn(() => ({
    chat: { completions: { create: mockChatCreate } },
    responses: { create: mockResponsesCreate },
  })),
}));
jest.mock('@/backend/utils/transientRetry', () => ({ withTransientRetry: (fn: () => Promise<unknown>) => fn() }));

import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { testModelToolConnection } from '@/backend/services/model/testToolConnection';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import * as adapters from '@/backend/services/model/adapters';
import type { CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';

const model: Model = { id: 'test-model', name: 'test/model', provider: 'openai', adapter: 'openai', ApiKey: '' };
const completion = (message: Record<string, unknown>) => ({
  id: 'completion-1', object: 'chat.completion', created: 1, model: 'test/model',
  choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const response = (output: unknown[]) => ({ id: 'response-1', created_at: 1, status: 'completed', output });
const argsFor = (prompt: string) => ({ requestId: /requestId "([^"]+)"/.exec(prompt)![1], payload: { values: [2, 3] } });
const receiptFrom = (output: string) => JSON.parse(JSON.parse(output).content[0].text).receipt;

beforeEach(() => {
  jest.restoreAllMocks();
  mockChatCreate.mockReset();
  mockResponsesCreate.mockReset();
  jest.mocked(createOpenAIClient).mockClear();
});

function arrangeChat(options: { args?: string; wrongName?: boolean; wrongReceipt?: boolean } = {}) {
  mockChatCreate.mockImplementation(async (request) => {
    const result = request.messages.find((message: { role: string }) => message.role === 'tool');
    if (result) return completion({ content: options.wrongReceipt ? 'made-up-receipt' : receiptFrom(result.content) });
    return completion({ tool_calls: [{
      id: 'call-1', type: 'function', function: {
        name: options.wrongName ? 'unregistered_tool' : request.tools[0].function.name,
        arguments: options.args ?? JSON.stringify(argsFor(request.messages[0].content)),
      },
    }] });
  });
}

describe('FLUJO model tool diagnostic', () => {
  it('prepares a real MCP schema, dispatches validated arguments, and returns the matching tool result', async () => {
    arrangeChat();
    const result = await testModelToolConnection(model, 'test-key');
    expect(result.ok).toBe(true);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    const first = mockChatCreate.mock.calls[0][0];
    expect(first.tools[0].function).toMatchObject({
      name: 'flujo-model-test_verify_tool_round_trip',
      parameters: {
        type: 'object', required: ['requestId', 'payload'],
        properties: {
          requestId: { type: 'string', description: expect.stringContaining('format: uuid') },
          payload: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } } },
          note: { type: 'string' },
        },
      },
    });
    expect(first.tools[0].function.parameters.properties.requestId).not.toHaveProperty('format');
    const second = mockChatCreate.mock.calls[1][0];
    expect(second.messages[1].tool_calls[0].id).toBe('call-1');
    expect(second.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    const output = JSON.parse(JSON.parse(second.messages[2].content).content[0].text);
    expect(output).toEqual({ sum: 5, receipt: expect.stringMatching(/^flujo-tool-/) });
    expect(JSON.stringify(first)).not.toContain(output.receipt);
  });

  it.each(['requesty', 'openrouter'] as const)('runs saved %s connections through Responses and keeps tool-call IDs paired', async (provider) => {
    mockResponsesCreate.mockImplementation(async (request) => {
      const result = request.input.find((item: { type: string }) => item.type === 'function_call_output');
      if (result) return response([{ type: 'message', content: [{ type: 'output_text', text: receiptFrom(result.output) }] }]);
      return response([{ type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'encrypted-reasoning' }, {
        type: 'function_call', id: 'item-1', call_id: 'call-1', name: request.tools[0].name,
        arguments: JSON.stringify(argsFor(request.input[0].content)),
      }]);
    });
    const baseUrl = provider === 'requesty' ? 'https://router.requesty.ai/v1' : 'https://openrouter.ai/api/v1';
    const result = await testModelToolConnection({ ...model, provider, baseUrl }, 'test-key');
    expect(result.ok).toBe(true);
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
    expect(mockResponsesCreate.mock.calls[0][0].tools[0]).toMatchObject({ type: 'function', strict: false, parameters: { required: ['requestId', 'payload'] } });
    expect(mockResponsesCreate.mock.calls[1][0].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-reasoning' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
    ]));
    expect(createOpenAIClient).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: baseUrl, defaultHeaders: { 'HTTP-Referer': 'https://flujo.com.co', 'X-Title': 'FLUJO' },
    }));
  });

  it('fails a plain text response that never calls the tool', async () => {
    mockChatCreate.mockResolvedValue(completion({ content: 'pong' }));
    const result = await testModelToolConnection(model, 'test-key');
    expect(result).toMatchObject({ ok: false, error: { code: 'tool_test_call_failed', message: expect.stringContaining('without calling') } });
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', { args: '{' }],
    ['invalid nested arguments', { args: JSON.stringify({ requestId: 'bad', payload: { values: 'bad' } }) }],
    ['unknown tool', { wrongName: true }],
    ['invented receipt', { wrongReceipt: true }],
  ])('fails on %s', async (_label, options) => {
    arrangeChat(options as Parameters<typeof arrangeChat>[0]);
    expect((await testModelToolConnection(model, 'test-key')).ok).toBe(false);
  });

  it.each(['claude-cli', 'codex-cli'] as const)('supplies the executor for the %s MCP bridge and verifies its result', async (adapter) => {
    const createCompletion = jest.fn(async (input: CompletionInput) => {
      const name = input.tools![0].function.name;
      expect(name).toMatch(/^mcp_/);
      const result = await input.localToolExecutors![name](argsFor(input.messages[0].content as string));
      return { completion: completion({ content: receiptFrom(JSON.stringify(result)) }) as OpenAI.ChatCompletion };
    });
    const Adapter = adapter === 'claude-cli' ? adapters.ClaudeSubscriptionAdapter : adapters.CodexAdapter;
    jest.spyOn(Adapter.prototype, 'createCompletion').mockImplementation(createCompletion);
    expect((await testModelToolConnection({ ...model, adapter }, '')).ok).toBe(true);
    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0].maxTurns).toBe(3);
  });

  it('fails when a self-orchestrating adapter swallows an executor error', async () => {
    jest.spyOn(adapters.ClaudeSubscriptionAdapter.prototype, 'createCompletion').mockImplementation(
      async (input): Promise<CompletionResult> => {
        await input.localToolExecutors![input.tools![0].function.name]({}).catch(() => undefined);
        return { completion: completion({ content: 'ok' }) as OpenAI.ChatCompletion };
      },
    );
    const result = await testModelToolConnection({ ...model, adapter: 'claude-cli' }, 'test-key');
    expect(result).toMatchObject({ ok: false, error: { code: 'tool_test_execution_failed' } });
  });
});

import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { OpenRouterAgentAdapter } from '@/backend/services/model/adapters/openrouterAgentAdapter';
import { __resetReasoningStore } from '@/backend/services/model/adapters/openaiResponsesAdapter';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { ModelTurnArchiveMemoryError } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { getCompletionAdapter } from '@/backend/services/model/adapters';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
jest.mock('@openrouter/agent', () => ({
  OpenRouter: jest.fn(),
  tool: jest.fn(config => ({ type: 'function', function: config })),
  stepCountIs: jest.fn(count => ({ count })),
}));

const sdk = jest.requireMock('@openrouter/agent');
const schema = { type: 'object', properties: { command: { type: 'string', minLength: 1 } },
  required: ['command'], additionalProperties: false };
const model = { id: 'test', name: 'anthropic/claude-opus-5.5', ApiKey: 'stored',
  provider: 'openrouter' as const, adapter: 'openrouter-agent' as const,
  baseUrl: 'https://openrouter.ai/api/v1', reasoningEffort: 'medium' as const, contextWindow: 10000 };
const input = (): CompletionInput => ({ model, apiKey: 'secret-never-archive',
  messages: [{ role: 'user', content: 'Run printf OK' }],
  tools: [{ type: 'function', function: { name: 'mcp:bash:run', parameters: schema } }],
  toolNameMap: { 'mcp:bash:run': { server: 'bash', tool: 'run' } }, maxTokens: 200,
});
const response = () => ({ id: 'resp-1', model: model.name, createdAt: 100, status: 'completed',
  output: [{ type: 'function_call', id: 'item-1', callId: 'call-1', name: 'bash_run', arguments: '{"command":"printf OK"}' }],
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120,
    inputTokensDetails: { cachedTokens: 80 }, outputTokensDetails: { reasoningTokens: 10 } },
});
let requestBody: any;
let callModel: jest.Mock;
let events: any[];
let nativeResponse: any;
let failure: Error | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningStore();
  events = [];
  failure = undefined;
  nativeResponse = response();
  sdk.OpenRouter.mockImplementation((options: any) => {
    callModel = jest.fn((request: any) => {
      const finish = async () => {
        const outgoing = await options.hooks.beforeRequest({}, new Request('https://openrouter.ai/api/v1/responses', {
          method: 'POST', headers: { authorization: 'Bearer secret-never-archive' },
          body: JSON.stringify({ model: request.model, input: request.input, reasoning: request.reasoning,
            max_output_tokens: request.maxOutputTokens, stream: true, tools: [{ name: 'bash_run', parameters: {} }] }),
        }));
        requestBody = await outgoing.json();
        if (failure) throw failure;
        return nativeResponse;
      };
      let promise: Promise<any> | undefined;
      return { getResponse: () => promise ??= finish(),
        getFullResponsesStream: async function* () {
          promise ??= finish();
          await promise;
          for (const event of events) yield event;
        },
      };
    });
    return { callModel };
  });
});

it('uses one SDK turn, preserves MCP schemas, returns canonical calls, and archives no credentials', async () => {
  const data = input();
  data.signal = new AbortController().signal;
  data.onSdkRequest = jest.fn(async () => 'dispatch');
  data.onSdkRequestResult = jest.fn(async () => undefined);
  const result = await new OpenRouterAgentAdapter().createCompletion(data);
  expect(callModel).toHaveBeenCalledTimes(1);
  expect(callModel.mock.calls[0][0]).toMatchObject({ allowFinalResponse: false, stopWhen: { count: 1 },
    reasoning: { effort: 'medium' }, maxOutputTokens: 200, signal: data.signal, store: false });
  expect(sdk.tool).toHaveBeenCalledWith(expect.objectContaining({ execute: false }));
  expect(requestBody.tools[0]).toMatchObject({ name: 'bash_run', parameters: schema, strict: false });
  expect(result.completion.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: {
    tool_calls: [{ id: 'call-1', function: { name: 'mcp:bash:run', arguments: '{"command":"printf OK"}' } }],
  } });
  expect(result.completion.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } });
  expect(result.contextUsage).toMatchObject({ promptTokens: 100, completionTokens: 20, contextWindow: 10000 });
  expect(JSON.stringify((data.onSdkRequest as jest.Mock).mock.calls)).not.toContain(data.apiKey);
  expect(data.onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'dispatch', outcome: 'completed' });
});

it('emits live text and separate parallel tool argument deltas with stable ids', async () => {
  events = [
    { type: 'response.output_text.delta', delta: 'Working' },
    { type: 'response.output_item.added', outputIndex: 2, item: nativeResponse.output[0] },
    { type: 'response.output_item.added', outputIndex: 4, item: { ...nativeResponse.output[0], callId: 'call-2', arguments: '' } },
    { type: 'response.function_call_arguments.delta', outputIndex: 4, delta: '{"command":' },
    { type: 'response.function_call_arguments.delta', outputIndex: 4, delta: '"printf TWO"}' },
  ];
  const onModelDelta = jest.fn();
  const result = await new OpenRouterAgentAdapter().createStreamCompletion({ ...input(), onModelDelta });
  expect(onModelDelta).toHaveBeenCalledWith({ messageId: result.liveMessageId, contentDelta: 'Working' });
  expect(onModelDelta).toHaveBeenCalledWith({ messageId: result.liveMessageId,
    toolCallDelta: { index: 1, argumentsDelta: '{"command":' } });
  expect(onModelDelta.mock.calls.every(([delta]) => delta.messageId === result.liveMessageId)).toBe(true);
});

it('keeps prior tool calls/results and image input intact across SDK translation', async () => {
  const data = input();
  data.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function',
    function: { name: 'mcp:bash:run', arguments: '{"command":"true"}' } }] },
  { role: 'tool', tool_call_id: 'old-call', content: 'exit 0' },
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] });
  await new OpenRouterAgentAdapter().createCompletion(data);
  expect(callModel.mock.calls[0][0].input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'function_call', callId: 'old-call', name: 'bash_run' }),
    expect.objectContaining({ type: 'function_call_output', callId: 'old-call', output: 'exit 0' }),
    expect.objectContaining({ role: 'user', content: [expect.objectContaining({ type: 'input_image', imageUrl: 'data:image/png;base64,abc' })] }),
  ]));
});

it('carries encrypted reasoning before its original call on the next flow turn', async () => {
  const data = { ...input(), conversationId: 'conversation', nodeId: 'node' };
  nativeResponse.output.unshift({ type: 'reasoning', id: 'reasoning', summary: [], encryptedContent: 'opaque' });
  const adapter = new OpenRouterAgentAdapter();
  const first = await adapter.createCompletion(data);
  data.messages.push(first.completion.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: 'OK' });
  await adapter.createCompletion(data);
  const items = callModel.mock.calls[0][0].input;
  const position = items.findIndex((item: any) => item.type === 'function_call');
  expect(items[position - 1]).toMatchObject({ type: 'reasoning', encryptedContent: 'opaque' });
});

it.each(['error', 'cancelled'])('propagates failures and finalizes archived requests as %s', async outcome => {
  const data = input();
  const controller = new AbortController();
  data.signal = controller.signal;
  data.onSdkRequest = jest.fn(async () => {
    if (outcome === 'cancelled') controller.abort(new Error('transport failed'));
    return 'dispatch';
  });
  data.onSdkRequestResult = jest.fn(async () => undefined);
  failure = new Error('transport failed');
  await expect(new OpenRouterAgentAdapter().createCompletion(data)).rejects.toThrow('transport failed');
  expect(data.onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'dispatch', outcome });
});

it('reports length limits and rejects failed provider responses', async () => {
  nativeResponse = { ...response(), status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } };
  const adapter = new OpenRouterAgentAdapter();
  expect((await adapter.createCompletion(input())).completion.choices[0].finish_reason).toBe('length');
  nativeResponse = { ...response(), status: 'failed', error: { message: 'provider rejected request' } };
  await expect(adapter.createCompletion(input())).rejects.toThrow('provider rejected request');
});

it('stops a dispatch when request admission loses execution authority', async () => {
  const lost = new FlowExecutionAuthorityError('Lease expired');
  const data = { ...input(), onSdkRequest: async () => { throw lost; } };
  await expect(new OpenRouterAgentAdapter().createCompletion(data)).rejects.toBe(lost);
});

it('refuses archive memory pressure before the provider dispatch', async () => {
  const refused = new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_LIMIT');
  await expect(new OpenRouterAgentAdapter().createCompletion({ ...input(),
    onSdkRequest: async () => { throw refused; },
  })).rejects.toBe(refused);
});

it('rejects restricted assessments and pre-aborted requests before constructing the SDK', async () => {
  const data = { ...input(), readOnlyAssessment: true };
  await expect(new OpenRouterAgentAdapter().createCompletion(data)).rejects.toThrow('Read-only assessment');
  expect(() => getCompletionAdapter(model).createCompletion(data)).toThrow('read-only assessment');
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  await expect(new OpenRouterAgentAdapter().createCompletion({ ...input(), signal: controller.signal }))
    .rejects.toThrow('already stopped');
  expect(sdk.OpenRouter).not.toHaveBeenCalled();
});

it('tolerates ordinary archive errors but propagates authority lost during finalization', async () => {
  const adapter = new OpenRouterAgentAdapter();
  await expect(adapter.createCompletion({ ...input(),
    onSdkRequest: async () => { throw new Error('disk full'); },
  })).resolves.toHaveProperty('completion');
  const lost = new FlowExecutionAuthorityError('Lease expired');
  await expect(adapter.createCompletion({ ...input(), onSdkRequest: async () => 'dispatch',
    onSdkRequestResult: async () => { throw lost; },
  })).rejects.toBe(lost);
});

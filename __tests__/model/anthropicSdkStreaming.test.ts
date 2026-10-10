import Anthropic from '@anthropic-ai/sdk';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AnthropicAdapter,
  clearModelCapabilityCache,
  __resetCacheControlSupport,
} from '@/backend/services/model/adapters/anthropicAdapter';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

// The SDK, HTTP transport, event decoder and message accumulator stay real.
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type Receipt = { path: string; body: Record<string, unknown> };
let server: Server;
let origin: string;
let receipts: Receipt[];
let respond: (response: ServerResponse, receipt: Receipt) => void;

const initialMessage = {
  id: 'streamed-message', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022',
  content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
};

function event(response: ServerResponse, value: Record<string, unknown>) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function finishStream(response: ServerResponse) {
  event(response, {
    type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 },
  });
  event(response, { type: 'message_stop' });
  response.end();
}

function input(extra: Partial<CompletionInput> = {}): CompletionInput {
  return {
    model: { id: 'saved', name: initialMessage.model, provider: 'anthropic', baseUrl: origin, ApiKey: 'fixture' },
    apiKey: 'fixture', temperature: 0, maxTokens: 123,
    messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Find the greeting.' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    ...extra,
  };
}

beforeEach(async () => {
  clearModelCapabilityCache();
  __resetCacheControlSupport();
  receipts = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const receipt = { path: request.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} };
    receipts.push(receipt);
    if (receipt.path.startsWith('/v1/models/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    respond(response, receipt);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  jest.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('streams text and split tool arguments while using the final whole-message cache totals', async () => {
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, { type: 'message_start', message: initialMessage });
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 🌻' } });
    event(response, { type: 'content_block_stop', index: 0 });
    event(response, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'lookup-1', name: 'lookup', input: {} } });
    for (const partial_json of ['{"items":[1,', '2],"query":"greet', 'ing"}']) {
      event(response, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } });
    }
    event(response, { type: 'content_block_stop', index: 1 });
    finishStream(response);
  };
  const onModelDelta = jest.fn();
  const result = await new AnthropicAdapter().createStreamCompletion(input({ onModelDelta }));
  const choice = result.completion.choices[0];
  expect(choice.message.content).toBe('Hello 🌻');
  expect(choice.finish_reason).toBe('tool_calls');
  expect(choice.message.tool_calls).toEqual([{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"items":[1,2],"query":"greeting"}' } }]);
  expect(onModelDelta.mock.calls.map(([delta]) => delta.contentDelta).filter(Boolean)).toEqual(['Hello 🌻']);
  expect(onModelDelta.mock.calls.map(([delta]) => delta.toolCallDelta?.argumentsDelta).filter(Boolean).join('')).toBe('{"items":[1,2],"query":"greeting"}');
  expect(result.completion.usage).toEqual({
    prompt_tokens: 38, completion_tokens: 5, total_tokens: 43,
    prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 7 },
  });
  const body = receipts.find(receipt => receipt.path === '/v1/messages')!.body;
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(123);
  expect(body.system).toEqual([{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }]);
  expect(body.tools).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
});

test('negotiates an unsupported cache field only once through real HTTP errors', async () => {
  const bodies: Record<string, unknown>[] = [];
  respond = (response, receipt) => {
    bodies.push(receipt.body);
    if (bodies.length === 1) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported field: cache_control' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, { type: 'message_start', message: initialMessage });
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } });
    event(response, { type: 'content_block_stop', index: 0 });
    finishStream(response);
  };
  const adapter = new AnthropicAdapter();
  expect((await adapter.createStreamCompletion(input())).completion.choices[0].message.content).toBe('Done');
  expect((await adapter.createStreamCompletion(input())).completion.choices[0].message.content).toBe('Done');
  expect(bodies).toHaveLength(3);
  expect(JSON.stringify(bodies[0])).toContain('cache_control');
  expect(JSON.stringify(bodies[1])).not.toContain('cache_control');
  expect(JSON.stringify(bodies[2])).not.toContain('cache_control');
});

test('Stop cancels an open real SDK stream without reporting a completed answer', async () => {
  const controller = new AbortController();
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, { type: 'message_start', message: initialMessage });
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } });
  };
  const onSdkRequestResult = jest.fn().mockResolvedValue(undefined);
  const promise = new AnthropicAdapter().createStreamCompletion(input({
    signal: controller.signal,
    onModelDelta: delta => { if (delta.contentDelta) controller.abort(); },
    onSdkRequest: async () => 'dispatch', onSdkRequestResult,
  }));
  await expect(promise).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
  expect(receipts.filter(receipt => receipt.path === '/v1/messages')).toHaveLength(1);
  expect(onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'dispatch', outcome: 'cancelled' });
});

test('Stop settles a real SDK retry immediately without advancing its backoff timer', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const fetch = jest.fn(async () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Try later' } }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after-ms': '5000' } },
  ));
  const client = new Anthropic({ apiKey: 'fixture', fetch, maxRetries: 1 });
  let outcome: unknown;
  const promise = client.messages.create({ model: initialMessage.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, { signal: controller.signal })
    .then(() => { outcome = 'completed'; }, error => { outcome = error; });
  try {
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome).toBeUndefined();
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    // Also release the old SDK's uninterruptible timer during negative qualification.
    await jest.runOnlyPendingTimersAsync();
    await promise;
  }
});

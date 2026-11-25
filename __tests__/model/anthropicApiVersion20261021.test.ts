/**
 * The Anthropic Messages adapter against a stand-in server that applies the
 * request rules of Claude API version 2026-10-21
 * (https://platform.claude.com/docs/en/api/migration-2026-10-21) and answers in
 * that version's shapes. The SDK, its HTTP transport, retries, error classes and
 * stream decoder all stay real; only the far end is local.
 *
 * The first test is the guard for the removed sampling fields: whatever a model
 * or caller has saved, no request may carry `temperature`, `top_p` or `top_k`
 * again, because the real API refuses every such request with a 400.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import {
  AnthropicAdapter,
  __resetApiVersionSupport,
  __resetCacheControlSupport,
} from '@/backend/services/model/adapters/anthropicAdapter';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_PREVIOUS_API_VERSION,
  ANTHROPIC_REMOVED_SAMPLING_FIELDS,
} from '@/backend/services/model/adapters/anthropicApiVersion';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type Block = { type: string; citations?: unknown[]; [key: string]: unknown };
type RequestBody = {
  model: string;
  stream?: boolean;
  messages: { role: string; content: string | Block[] }[];
  [key: string]: unknown;
};
type Receipt = { method: string; path: string; headers: IncomingHttpHeaders; body: RequestBody };

let server: Server;
let origin: string;
let receipts: Receipt[];
/** Answers one request that passed the version's request rules. */
let respond: (response: ServerResponse, receipt: Receipt) => void;
/** The version the stand-in server accepts; a legacy gateway knows only the old one. */
let acceptedVersion: string;

function sendError(response: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_fixture', ...headers });
  response.end(JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_fixture' }));
}

/** The request rules API version 2026-10-21 adds, each answered with the 400 the real API sends. */
function violation(body: RequestBody): string | undefined {
  for (const field of ANTHROPIC_REMOVED_SAMPLING_FIELDS) {
    if (field in body) return `${field}: Extra inputs are not permitted`;
  }
  for (const [index, message] of body.messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant' && message.content.some(block => block.type === 'document')) {
      return `messages.${index}: document blocks are not allowed in assistant messages`;
    }
    if (message.role === 'user' && message.content.some(block => block.type === 'text' && (block.citations?.length ?? 0) > 0)) {
      return `messages.${index}: text blocks with citations are not allowed in user messages`;
    }
  }
  return undefined;
}

const USAGE = { input_tokens: 12, output_tokens: 4, cache_creation_input_tokens: 30, cache_read_input_tokens: 70, service_tier: 'standard' };

function message(body: RequestBody, content: Block[], stopReason: string) {
  return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE,
  };
}

function sse(response: ServerResponse, events: Record<string, unknown>[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

/**
 * A reply in 2026-10-21 shapes. On current models thinking is on by default and
 * its text is omitted, so a reply starts with an empty, signed thinking block.
 */
function answer(response: ServerResponse, body: RequestBody, text = 'Hello', toolUse?: { id: string; name: string; input: Record<string, unknown> }) {
  const content: Block[] = [
    { type: 'thinking', thinking: '', signature: 'sig-fixture' },
    { type: 'text', text, citations: null },
    ...(toolUse ? [{ type: 'tool_use', ...toolUse }] : []),
  ];
  const stopReason = toolUse ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(message(body, content, stopReason)));
    return;
  }
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { ...message(body, [], stopReason), stop_reason: null, usage: { ...USAGE, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
  ];
  if (toolUse) {
    const json = JSON.stringify(toolUse.input);
    events.push(
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: json.slice(5) } },
      { type: 'content_block_stop', index: 2 },
    );
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null }, usage: USAGE },
    { type: 'message_stop' },
  );
  sse(response, events);
}

function model(extra: Partial<Model> = {}): Model {
  return { id: 'saved', name: 'claude-sonnet-4-6', provider: 'anthropic', adapter: 'anthropic', baseUrl: origin, ApiKey: 'fixture-key', ...extra };
}

function input(extra: Partial<CompletionInput> = {}): CompletionInput {
  return {
    model: model(),
    apiKey: 'fixture-key',
    maxTokens: 256,
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello.' }],
    ...extra,
  };
}

const messageReceipts = () => receipts.filter(receipt => receipt.path === '/v1/messages');

beforeEach(async () => {
  __resetCacheControlSupport();
  __resetApiVersionSupport();
  receipts = [];
  acceptedVersion = ANTHROPIC_API_VERSION;
  respond = (response, receipt) => answer(response, receipt.body);
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const receipt: Receipt = {
      method: request.method!, path: request.url!, headers: request.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : { model: '', messages: [] },
    };
    receipts.push(receipt);
    if (request.headers['anthropic-version'] !== acceptedVersion) {
      sendError(response, 400, 'invalid_request_error', `anthropic-version: ${request.headers['anthropic-version']} is not a supported version`);
      return;
    }
    const problem = violation(receipt.body);
    if (problem) {
      sendError(response, 400, 'invalid_request_error', problem);
      return;
    }
    respond(response, receipt);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('guard: removed sampling fields are never sent again', () => {
  const MODEL_NAMES = ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-5-5'];
  const cases = MODEL_NAMES.flatMap(name => (['createCompletion', 'createStreamCompletion'] as const).map(path => [name, path] as const));

  test.each(cases)('%s via %s: saved and caller temperatures never reach the request', async (name, path) => {
    for (const temperature of [0, 0.7, 1, undefined]) {
      const result = await new AnthropicAdapter()[path](input({
        model: model({ name, temperature: '0.3', reasoningEffort: 'high' }),
        temperature,
        temperatureOverride: 0.9,
      }));
      expect(result.completion.choices[0].message.content).toBe('Hello');
    }
    for (const receipt of messageReceipts()) {
      for (const field of ANTHROPIC_REMOVED_SAMPLING_FIELDS) expect(receipt.body).not.toHaveProperty(field);
      expect(receipt.body.output_config).toEqual({ effort: 'high' });
    }
    expect(messageReceipts()).toHaveLength(4);
  });

  test('OpenRouter Messages never sends them either, even for a non-Claude model', async () => {
    const openRouter = model({ provider: 'openrouter', name: 'vendor/other-model', temperature: '0.2' });
    await new AnthropicAdapter().createCompletion(input({ model: openRouter, temperature: 0.2 }));
    await new AnthropicAdapter().createStreamCompletion(input({ model: openRouter, temperature: 0.2 }));
    expect(messageReceipts()).toHaveLength(2);
    for (const receipt of messageReceipts()) {
      for (const field of ANTHROPIC_REMOVED_SAMPLING_FIELDS) expect(receipt.body).not.toHaveProperty(field);
    }
  });
});

describe('API version and credentials', () => {
  test('the SDK sends the version FLUJO pins, and only Messages requests go out', async () => {
    await new AnthropicAdapter().createCompletion(input());
    await new AnthropicAdapter().createStreamCompletion(input());
    // A future SDK major that moves to another API version must fail here, so its
    // request rules are reviewed before the upgrade lands.
    expect(ANTHROPIC_API_VERSION).toBe('2026-10-21');
    expect(receipts.map(receipt => [receipt.method, receipt.path, receipt.headers['anthropic-version']])).toEqual([
      ['POST', '/v1/messages', ANTHROPIC_API_VERSION],
      ['POST', '/v1/messages', ANTHROPIC_API_VERSION],
    ]);
  });

  test('an API key still goes out in X-Api-Key and never as a bearer token, so gateways keep authenticating', async () => {
    await new AnthropicAdapter().createCompletion(input());
    expect(receipts[0].headers['x-api-key']).toBe('fixture-key');
    expect(receipts[0].headers.authorization).toBeUndefined();
  });

  test('OpenRouter gets only a bearer token', async () => {
    await new AnthropicAdapter().createCompletion(input({ model: model({ provider: 'openrouter' }), apiKey: 'or-key' }));
    expect(receipts[0].headers.authorization).toBe('Bearer or-key');
    expect(receipts[0].headers['x-api-key']).toBeUndefined();
  });

  test('a server behind a custom base URL that only knows the earlier version gets it, once per endpoint', async () => {
    acceptedVersion = ANTHROPIC_PREVIOUS_API_VERSION;
    const first = await new AnthropicAdapter().createStreamCompletion(input());
    const second = await new AnthropicAdapter().createCompletion(input());
    expect(first.completion.choices[0].message.content).toBe('Hello');
    expect(second.completion.choices[0].message.content).toBe('Hello');
    expect(receipts.map(receipt => receipt.headers['anthropic-version'])).toEqual([
      ANTHROPIC_API_VERSION, ANTHROPIC_PREVIOUS_API_VERSION, ANTHROPIC_PREVIOUS_API_VERSION,
    ]);
    // The body is valid under both versions, so it does not change.
    expect(receipts[1].body).toEqual(receipts[0].body);
  });

  test('a 400 about the request body is not mistaken for a version problem', async () => {
    respond = response => sendError(response, 400, 'invalid_request_error', 'messages: at least one message is required');
    await expect(new AnthropicAdapter().createCompletion(input())).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });
});

describe('tool use round trip, documents and citations', () => {
  const tools: OpenAI.ChatCompletionFunctionTool[] = [{
    type: 'function',
    function: { name: 'lookup', description: 'Find a fact', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  }];
  const pdf = { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0xLjQK', filename: 'notes.pdf' } };

  test.each(['createCompletion', 'createStreamCompletion'] as const)('%s: a tool call and its result travel in the shapes 2026-10-21 accepts', async path => {
    respond = (response, receipt) => {
      const last = receipt.body.messages[receipt.body.messages.length - 1];
      const hasResult = Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result');
      if (hasResult) answer(response, receipt.body, 'The answer is 42.');
      else answer(response, receipt.body, 'Looking it up.', { id: 'toolu_fixture', name: 'lookup', input: { q: 'meaning' } });
    };
    const userTurn = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Read this and look it up.' }, pdf] as OpenAI.ChatCompletionContentPart[],
    };
    const first = await new AnthropicAdapter()[path](input({ tools, messages: [{ role: 'system', content: 'Be brief.' }, userTurn] }));
    const call = first.completion.choices[0];
    expect(call.finish_reason).toBe('tool_calls');
    expect(call.message.tool_calls).toEqual([
      { id: 'toolu_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"meaning"}' } },
    ]);

    const second = await new AnthropicAdapter()[path](input({
      tools,
      messages: [
        { role: 'system', content: 'Be brief.' },
        userTurn,
        { role: 'assistant', content: call.message.content, tool_calls: call.message.tool_calls },
        { role: 'tool', tool_call_id: 'toolu_fixture', content: '42' },
      ],
    }));
    expect(second.completion.choices[0].message.content).toBe('The answer is 42.');
    expect(second.completion.choices[0].finish_reason).toBe('stop');

    const replay = messageReceipts()[1].body;
    expect(replay.messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'user']);
    // The document stays in the user turn; the assistant turn carries only text and the tool call.
    expect((replay.messages[0].content as Block[]).map(block => block.type)).toEqual(['text', 'document']);
    expect((replay.messages[1].content as Block[]).map(block => block.type)).toEqual(['text', 'tool_use']);
    expect((replay.messages[1].content as Block[])[1]).toMatchObject({ id: 'toolu_fixture', name: 'lookup', input: { q: 'meaning' } });
    expect(replay.messages[2].content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_fixture', content: '42' }),
    ]);
    // No user text ever carries citations.
    for (const entry of replay.messages.filter(item => item.role === 'user')) {
      for (const block of entry.content as Block[]) expect(block).not.toHaveProperty('citations');
    }
  });
});

describe('streaming and prompt caching', () => {
  test('thinking blocks in the stream are skipped; text, tool arguments and cache usage come through', async () => {
    respond = (response, receipt) => answer(response, receipt.body, 'Hi 🌻', { id: 'toolu_1', name: 'lookup', input: { q: 'x' } });
    const onModelDelta = jest.fn();
    const result = await new AnthropicAdapter().createStreamCompletion(input({
      onModelDelta,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    }));
    const choice = result.completion.choices[0];
    expect(choice.message.content).toBe('Hi 🌻');
    expect(choice.message.tool_calls?.[0].function).toEqual({ name: 'lookup', arguments: '{"q":"x"}' });
    expect(onModelDelta.mock.calls.map(([delta]) => delta.contentDelta).filter(Boolean)).toEqual(['Hi 🌻']);
    expect(result.completion.usage).toEqual({
      prompt_tokens: 112, completion_tokens: 4, total_tokens: 116,
      prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 30 },
    });

    const body = messageReceipts()[0].body;
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    expect((body.tools as Block[])[0]).toHaveProperty('cache_control', { type: 'ephemeral' });
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'Say hello.', cache_control: { type: 'ephemeral' } }]);
  });
});

describe('errors in 2026-10-21 shapes', () => {
  test.each([
    [429, 'rate_limit_error'],
    [529, 'overloaded_error'],
  ])('a %s (%s) is retried by the SDK and the turn still completes', async (status, type) => {
    let failures = 0;
    respond = (response, receipt) => {
      if (failures++ === 0) sendError(response, status, type, 'Try again shortly.', { 'retry-after-ms': '1' });
      else answer(response, receipt.body);
    };
    const result = await new AnthropicAdapter().createCompletion(input());
    expect(result.completion.choices[0].message.content).toBe('Hello');
    expect(messageReceipts()).toHaveLength(2);
  });

  test('a lasting overload ends as an OverloadedError after the SDK retries', async () => {
    respond = response => sendError(response, 529, 'overloaded_error', 'Overloaded', { 'retry-after-ms': '1' });
    const failure = new AnthropicAdapter().createCompletion(input());
    await expect(failure).rejects.toBeInstanceOf(Anthropic.OverloadedError);
    expect(messageReceipts()).toHaveLength(3);
  });

  test('a 400 is not retried and keeps the API message', async () => {
    respond = response => sendError(response, 400, 'invalid_request_error', 'max_tokens: must be at least 1');
    const failure = new AnthropicAdapter().createCompletion(input());
    await expect(failure).rejects.toThrow(/max_tokens: must be at least 1/);
    await expect(failure).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(messageReceipts()).toHaveLength(1);
  });
});

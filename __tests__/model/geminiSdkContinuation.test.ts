import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleGenAIOptions, Interactions } from '@google/genai';
import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { toInteractionInput } from '@/backend/services/model/adapters/geminiInteractions';
import { Agent } from 'undici';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

// Keep the installed Interactions SDK, transport and SSE decoder real.
// Only its constructor's destination changes to the fixture's loopback server.
jest.mock('@google/genai', () => {
  const actual = jest.requireActual<typeof import('@google/genai')>('@google/genai');
  let origin: string;
  return {
    ...actual,
    GoogleGenAI: class extends actual.GoogleGenAI {
      constructor(options: GoogleGenAIOptions) {
        if (!origin?.startsWith('http://127.0.0.1:')) throw new Error('Loopback fixture is not ready');
        super({ ...options, httpOptions: {
          ...options.httpOptions, baseUrl: origin, apiVersion: 'v1beta',
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            // Native Response.json parses in Node's host realm. The SDK's
            // plain-object accumulator needs objects from this Jest realm.
            Object.defineProperty(response, 'json', { value: async () => JSON.parse(await response.text()) });
            return response;
          },
        } });
      }
    },
    __setOrigin(value: string) { origin = value; },
  };
});

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type Receipt = { path: string; body: Record<string, unknown> };
let server: Server;
let receipts: Receipt[];
let respond: (response: ServerResponse) => void;
const dispatcherSymbol = Symbol.for('undici.globalDispatcher.1');
let fixtureDispatcher: Agent | undefined;

beforeAll(() => {
  // Node's fetch initializes its dispatcher in the host realm; Jest has its own
  // global object. Supply that realm with a real dispatcher for the SDK.
  if (!Reflect.get(globalThis, dispatcherSymbol)) {
    fixtureDispatcher = new Agent();
    Object.defineProperty(globalThis, dispatcherSymbol, { value: fixtureDispatcher, configurable: true });
  }
});

afterAll(async () => {
  if (fixtureDispatcher) {
    Reflect.deleteProperty(globalThis, dispatcherSymbol);
    await fixtureDispatcher.close();
  }
});

beforeEach(async () => {
  receipts = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receipts.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (receipts.length > 2) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    respond(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  jest.requireMock('@google/genai').__setOrigin(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function input(extra: Partial<CompletionInput> = {}): CompletionInput {
  return {
    model: { id: 'saved', name: 'fixture', provider: 'gemini', adapter: 'gemini', ApiKey: 'fixture', contextWindow: 200000 },
    apiKey: 'fixture', maxTokens: 4, signal: AbortSignal.timeout(3000),
    messages: [{ role: 'user', content: 'Hello' }],
    ...extra,
  };
}

const signedSteps: Interactions.Step[] = [
  { type: 'thought', signature: 'opaque-signature' },
  { type: 'model_output', content: [{ type: 'text', text: 'Checking.' }] },
  { type: 'function_call', id: 'call-a', name: 'lookup', arguments: { query: 'hello' } },
  { type: 'function_call', id: 'call-b', name: 'lookup', arguments: { query: 'world' } },
];
const usage = { total_input_tokens: 10, total_output_tokens: 4, total_thought_tokens: 6, total_cached_tokens: 3, total_tokens: 20 };

function send(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function events(): Interactions.InteractionSSEEvent[] {
  return [
    { event_type: 'interaction.created', interaction: { id: 'first', status: 'in_progress' } },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'opaque-signature' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Checking.' } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'call-a', name: 'lookup', arguments: {} } },
    { event_type: 'step.start', index: 3, step: { type: 'function_call', id: 'call-b', name: 'lookup', arguments: {} } },
    { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"query":' } },
    { event_type: 'step.delta', index: 3, delta: { type: 'arguments_delta', arguments: '{"query":"world"}' } },
    { event_type: 'step.stop', index: 3 },
    { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '"hello"}' } },
    { event_type: 'step.stop', index: 2 },
    { event_type: 'interaction.completed', interaction: { id: 'first', status: 'requires_action', usage } },
  ];
}

function sendEvents(response: ServerResponse, values: Interactions.InteractionSSEEvent[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(values.map(value => `event: ${value.event_type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
}

it.each([false, true])('replays signed parallel tool calls after durable flow projection (streaming=%s)', async streaming => {
  respond = response => streaming ? sendEvents(response, events()) : send(response, {
    id: 'first', status: 'requires_action', steps: signedSteps, usage,
  });
  const adapter = new GeminiAdapter();
  const onModelDelta = jest.fn();
  const result = await (streaming ? adapter.createStreamCompletion(input({ onModelDelta })) : adapter.createCompletion(input()));
  expect(result.completion.choices[0].message.tool_calls).toMatchObject([
    { id: 'call-a', function: { name: 'lookup', arguments: '{"query":"hello"}' } },
    { id: 'call-b', function: { name: 'lookup', arguments: '{"query":"world"}' } },
  ]);
  expect(result.providerMetadata?.geminiInteraction?.steps).toEqual(signedSteps);
  expect(result.completion.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 6 } });
  const persisted: FlujoChatMessage[] = JSON.parse(JSON.stringify([
    { ...input().messages[0], id: 'u', timestamp: 1 },
    { ...result.completion.choices[0].message, id: 'a', timestamp: 2, providerMetadata: result.providerMetadata },
    { role: 'tool', id: 'ta', timestamp: 3, tool_call_id: 'call-a', content: 'result A' },
    { role: 'tool', id: 'tb', timestamp: 4, tool_call_id: 'call-b', content: 'result B' },
  ]));
  expect(toApiMessages(persisted)[1]).not.toHaveProperty('providerMetadata');
  respond = response => send(response, { id: 'final', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Done.' }] }] });
  await adapter.createCompletion(input({ messages: toApiMessages(persisted, true) }));
  expect(receipts).toHaveLength(2);
  expect(receipts[1].path).toMatch(/\/v1beta2?\/interactions$/);
  expect(receipts[1].body).toMatchObject({ store: false, input: [
    { type: 'user_input', content: [{ type: 'text', text: 'Hello' }] }, ...signedSteps,
    { type: 'function_result', call_id: 'call-a', name: 'lookup', result: [{ type: 'text', text: 'result A' }] },
    { type: 'function_result', call_id: 'call-b', name: 'lookup', result: [{ type: 'text', text: 'result B' }] },
  ] });
  expect(receipts[1].body).not.toHaveProperty('previous_interaction_id');
  if (streaming) {
    expect(onModelDelta.mock.calls.filter(([delta]) => delta.contentDelta).map(([delta]) => delta.contentDelta).join('')).toBe('Checking.');
    expect(new Set(onModelDelta.mock.calls.map(([delta]) => delta.messageId))).toEqual(new Set([result.liveMessageId]));
  }
  persisted[1].content = 'Edited.';
  await expect(toInteractionInput(toApiMessages(persisted, true), 'fixture')).rejects.toThrow('edited');
});

it('retains signatures for text-only history without leaking them to other providers', async () => {
  respond = response => send(response, { id: 'text', status: 'completed', steps: signedSteps.slice(0, 2) });
  const result = await new GeminiAdapter().createCompletion(input());
  const message = result.completion.choices[0].message;
  expect((await toInteractionInput([message], 'fixture')).input).toEqual(signedSteps.slice(0, 2));
  expect((await toInteractionInput([message], 'another-model')).input).toEqual([signedSteps[1]]);
});

it.each(['incomplete', 'failed', 'cancelled'])('does not execute tools from a %s response or retry it', async status => {
  respond = response => send(response, { id: 'failed', status, steps: signedSteps });
  await expect(new GeminiAdapter().createCompletion(input())).rejects.toThrow('did not complete');
  expect(receipts).toHaveLength(1);
});

it('rejects an abruptly ended stream, even after a complete function-call step', async () => {
  respond = response => sendEvents(response, events().slice(0, -1));
  await expect(new GeminiAdapter().createStreamCompletion(input())).rejects.toThrow('before completion');
  expect(receipts).toHaveLength(1);
});

it('rejects malformed streamed arguments instead of dispatching a partial call', async () => {
  respond = response => sendEvents(response, events().filter(event => !(event.event_type === 'step.delta'
    && event.index === 2 && event.delta.type === 'arguments_delta' && event.delta.arguments === '"hello"}')));
  await expect(new GeminiAdapter().createStreamCompletion(input())).rejects.toThrow();
  expect(receipts).toHaveLength(1);
});

it('assembles media bytes and keeps them in the live and durable result', async () => {
  respond = response => sendEvents(response, [
    { event_type: 'interaction.created', interaction: { id: 'media', status: 'in_progress' } },
    { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 0, delta: { type: 'audio', mime_type: 'audio/wav', data: 'YQ==' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'audio', mime_type: 'audio/wav', data: 'Yg==' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.completed', interaction: { id: 'media', status: 'completed' } },
  ]);
  const onModelDelta = jest.fn();
  const result = await new GeminiAdapter().createStreamCompletion(input({ onModelDelta }));
  expect(result.media).toEqual([{ type: 'audio', mimeType: 'audio/wav', data: 'YWI=' }]);
  expect(onModelDelta).toHaveBeenCalledWith({ messageId: result.liveMessageId, mediaPart: result.media![0] });
});

it('cancels the actual streaming request when Stop is pressed', async () => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = events()[0];
    response.write(`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
    timer = setTimeout(() => controller.abort(), 20);
  };
  try {
    await expect(new GeminiAdapter().createStreamCompletion(input({ signal: controller.signal }))).rejects.toThrow();
    expect(receipts).toHaveLength(1);
  } finally { clearTimeout(timer); }
});

it('does not retry an HTTP 503 or follow a redirect', async () => {
  for (const status of [503, 307]) {
    receipts = [];
    respond = response => { response.writeHead(status, { 'Content-Type': 'application/json', Location: '/unexpected' }); response.end('{}'); };
    await expect(new GeminiAdapter().createCompletion(input())).rejects.toThrow();
    expect(receipts).toHaveLength(1);
  }
});

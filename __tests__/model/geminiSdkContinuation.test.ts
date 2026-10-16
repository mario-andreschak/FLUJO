import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleGenAIOptions } from '@google/genai';
import { Agent } from 'undici';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

// Keep the installed SDK, transport, SSE decoder and continuation accumulator real.
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

function hop(final: boolean) {
  return {
    responseId: final ? 'final' : 'first',
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: final ? 'world' : 'Hello ' }] },
      finishReason: final ? 'STOP' : 'CONTINUATION', ...(final ? {} : { continuationToken: 'fixture-checkpoint' }) }],
    usageMetadata: { promptTokenCount: final ? 14 : 10, candidatesTokenCount: final ? 3 : 4, totalTokenCount: final ? 17 : 14 },
  };
}

it.each([false, true])('keeps continuation billing separate from input context (streaming=%s)', async streaming => {
  respond = response => {
    const value = hop(receipts.length === 2);
    response.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
    response.end(streaming ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
  };
  const onModelDelta = jest.fn();
  const adapter = new GeminiAdapter();
  const result = await (streaming ? adapter.createStreamCompletion(input({ onModelDelta })) : adapter.createCompletion(input()));
  expect(result.completion.choices[0].message.content).toBe('Hello world');
  expect(result.completion.usage).toMatchObject({ prompt_tokens: 24, completion_tokens: 7, total_tokens: 31 });
  expect(result.contextUsage).toEqual({ promptTokens: 10, completionTokens: 7, contextWindow: 200000, contextWindowSource: 'configured' });
  expect(receipts).toHaveLength(2);
  expect(receipts[1].body).toHaveProperty('continuationToken', 'fixture-checkpoint');
  if (streaming) expect(onModelDelta.mock.calls.map(([delta]) => delta.contentDelta).join('')).toBe('Hello world');
});

it('keeps ordinary tool signatures and context usage without a continuation', async () => {
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { query: 'hello' } }, thoughtSignature: 'fixture-signature' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    }));
  };
  const result = await new GeminiAdapter().createCompletion(input());
  expect(result.completion.choices[0].message.tool_calls?.[0]).toMatchObject({
    function: { name: 'lookup', arguments: '{"query":"hello"}' }, providerMetadata: { gemini: { thoughtSignature: 'fixture-signature' } },
  });
  expect(result.contextUsage).toMatchObject({ promptTokens: 10, completionTokens: 4 });
  expect(receipts).toHaveLength(1);
});

it('does not resume a streaming checkpoint after Stop', async () => {
  const controller = new AbortController();
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(hop(false))}\n\n`);
    abortTimer = setTimeout(() => controller.abort(), 20);
  };
  try {
    await expect(new GeminiAdapter().createStreamCompletion(input({ signal: controller.signal }))).rejects.toThrow();
    expect(receipts).toHaveLength(1);
  } finally {
    clearTimeout(abortTimer);
  }
});

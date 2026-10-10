import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { OpenAiResponsesAdapter } from '@/backend/services/model/adapters/openaiResponsesAdapter';
import { AzureOpenAiAdapter } from '@/backend/services/model/adapters/azureOpenAiAdapter';
import { AnthropicAdapter } from '@/backend/services/model/adapters/anthropicAdapter';
import { GeminiAdapter } from '@/backend/services/model/adapters/geminiAdapter';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model';

type Receipt = { path: string; method: string; body: Record<string, unknown>; key?: string };
let server: Server, origin: string;
let receipts: Receipt[];
let respond: (request: IncomingMessage, response: ServerResponse) => void;
const chat = { id: 'test', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }] };
const responses = { id: 'response', created_at: 1, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture' }] }] };
const anthropic = { id: 'message', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const gemini = { candidates: [{ content: { role: 'model', parts: [{ text: 'fixture' }] }, finishReason: 'STOP' }] };

beforeEach(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receipts.push({ path: request.url!, method: request.method!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}, key: request.headers['x-goog-api-key'] as string | undefined });
    respond(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  receipts = [];
  respond = (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const path = _request.url!;
    response.end(JSON.stringify(path.includes(':generateContent') ? gemini : path.includes('responses') ? responses : path.includes('/anthropic/') ? anthropic : chat));
  };
});

const cases = [
  ['openai', () => new OpenAiAdapter(), 'openai', 'openai', '/v1'],
  ['azure', () => new AzureOpenAiAdapter(), 'azure', 'azure', ''],
  ['responses', () => new OpenAiResponsesAdapter(), 'openai', 'openai-responses', '/v1'],
  ['anthropic', () => new AnthropicAdapter(), 'anthropic', 'anthropic', '/anthropic'],
  ['gemini', () => new GeminiAdapter(), 'gemini', 'gemini', '/v1beta'],
] as const;
function input(provider: Model['provider'], adapter: Model['adapter'], path: string): CompletionInput {
  return { model: { id: 'saved', name: 'fixture', ApiKey: 'stored', provider, adapter, baseUrl: `${origin}${path}` }, apiKey: 'fixture-key',
    messages: [{ role: 'system', content: 'Only assess.' }, { role: 'user', content: 'Untrusted repository text.' }],
    signal: AbortSignal.timeout(3000), maxTokens: 321, readOnlyAssessment: true };
}

it.each(cases)('%s sends one real tool-free request with the output cap', async (_name, make, provider, adapter, path) => {
  const result = await make().createCompletion(input(provider, adapter, path));
  expect(result.completion.choices[0].message.content).toBe('fixture');
  expect(receipts).toHaveLength(1);
  const body = receipts[0].body;
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('cachedContent');
  expect(body).not.toHaveProperty('previous_response_id');
  if (adapter === 'gemini') {
    expect(receipts[0].path).toBe('/v1beta/models/fixture:generateContent');
    expect(receipts[0].key).toBe('fixture-key');
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 321, responseModalities: ['TEXT'] }, systemInstruction: { parts: [{ text: 'Only assess.' }] } });
  } else expect(body).toHaveProperty(adapter === 'openai-responses' ? 'max_output_tokens' : 'max_tokens', 321);
});

it.each(cases)('%s does not retry a real HTTP503', async (_name, make, provider, adapter, path) => {
  respond = (_request, response) => { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Service unavailable', type: 'api_error' } })); };
  await expect(make().createCompletion(input(provider, adapter, path))).rejects.toThrow();
  expect(receipts).toHaveLength(1);
});

it.each(cases)('%s refuses redirects before forwarding to another endpoint', async (_name, make, provider, adapter, path) => {
  respond = (_request, response) => { response.writeHead(307, { Location: `${origin}/redirect-target` }); response.end(); };
  await expect(make().createCompletion(input(provider, adapter, path))).rejects.toThrow();
  expect(receipts).toHaveLength(1);
});

it.each(cases)('%s aborts a real hung response body without retry', async (_name, make, provider, adapter, path) => {
  const controller = new AbortController();
  respond = (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); setTimeout(() => controller.abort(), 20); };
  await expect(make().createCompletion({ ...input(provider, adapter, path), signal: controller.signal })).rejects.toThrow();
  expect(receipts).toHaveLength(1);
  server.closeAllConnections();
});

it.each(['openai-responses', 'anthropic'] as const)('%s does not negotiate optional parameters or retrieve model capability', async adapter => {
  respond = (_request, response) => { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'temperature cache_control include not supported', type: 'invalid_request_error' } })); };
  const make = adapter === 'anthropic' ? new AnthropicAdapter() : new OpenAiResponsesAdapter();
  await expect(make.createCompletion({ ...input(adapter === 'anthropic' ? 'anthropic' : 'openai', adapter, adapter === 'anthropic' ? '/anthropic' : '/v1'), temperature: 0 })).rejects.toThrow();
  expect(receipts).toHaveLength(1);
  expect(receipts[0].method).toBe('POST');
});

it.each(cases)('%s rejects tools and mixed media before making any request', async (_name, make, provider, adapter, path) => {
  await expect(make().createCompletion({ ...input(provider, adapter, path), tools: [] })).rejects.toThrow(/tool-free/);
  const request = input(provider, adapter, path);
  await expect(make().createCompletion({ ...request, model: { ...request.model, outputModalities: ['text', 'image'] } })).rejects.toThrow(/tool-free/);
  await expect(make().createCompletion({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `${origin}/attachment` } }] }] })).rejects.toThrow(/tool-free/);
  expect(receipts).toHaveLength(0);
});

it('bounds actual Gemini chunked JSON before parsing and hides provider error bodies', async () => {
  respond = (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(128 * 1024 + 1)); };
  await expect(new GeminiAdapter().createCompletion(input('gemini', 'gemini', '/v1beta'))).rejects.toThrow('Gemini assessment response is unavailable.');
  expect(receipts).toHaveLength(1);
  respond = (_request, response) => { response.writeHead(400); response.end('secret-provider-body'); };
  await expect(new GeminiAdapter().createCompletion(input('gemini', 'gemini', '/v1beta'))).rejects.toThrow('Gemini assessment response is unavailable.');
});

it('rejects incompatible native Gemini endpoints before sending credentials', async () => {
  await expect(new GeminiAdapter().createCompletion(input('gemini', 'gemini', '/v1beta/openai'))).rejects.toThrow(/saved Gemini endpoint/);
  expect(receipts).toHaveLength(0);
});

it.each(['claude-cli', 'codex-cli', 'antigravity-cli'] as const)('factory denies %s assessment without running an agent', async adapter => {
  const request = input('openai', adapter, '/v1');
  await expect(Promise.resolve().then(() => getCompletionAdapter(request.model).createCompletion(request))).rejects.toThrow(/does not support/);
  expect(receipts).toHaveLength(0);
});

it.each(cases)('%s refuses assessment streaming and missing cancellation/caps', async (_name, make, provider, adapter, path) => {
  const request = input(provider, adapter, path);
  await expect(make().createCompletion({ ...request, signal: undefined })).rejects.toThrow(/bounded/);
  await expect(make().createCompletion({ ...request, maxTokens: undefined })).rejects.toThrow(/bounded/);
  await expect(make().createStreamCompletion!({ ...request })).rejects.toThrow(/streaming/);
  expect(receipts).toHaveLength(0);
});

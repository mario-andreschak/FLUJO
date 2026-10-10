import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { fetchModelsFromProvider, getProviderFromBaseUrl } from '@/backend/services/model/provider';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { testModelConnection } from '@/backend/services/model/testConnection';

const key = 'synthetic-orca-fixture-key';
const modelName = 'vendor/fixture-model';
let server: Server;
let baseUrl: string;
let requests: Array<{ path: string; headers: IncomingHttpHeaders; body?: OpenAI.ChatCompletionCreateParams }>;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as OpenAI.ChatCompletionCreateParams : undefined;
    requests.push({ path: request.url!, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'Invalid fixture key', type: 'authentication_error' } }));
      return;
    }
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: modelName, name: 'Fixture model', supported_parameters: ['tools'], context_length: 32000 }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || !body) {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    const selectedTool = body.tools?.find(tool => tool.type === 'function');
    const toolResult = body.messages.find(message => message.role === 'tool');
    const prompt = body.messages.find(message => message.role === 'user')?.content;
    const requestedId = typeof prompt === 'string' ? prompt.match(/requestId "([a-f0-9-]+)"/)?.[1] : undefined;
    const toolCalls = selectedTool && !toolResult ? [{
      id: 'fixture_tool_call', type: 'function', function: {
        name: selectedTool.function.name,
        arguments: JSON.stringify(requestedId ? { requestId: requestedId, payload: { values: [2, 3] } } : { value: 7 }),
      },
    }] : undefined;
    const content = toolResult && typeof toolResult.content === 'string'
      ? toolResult.content.match(/flujo-tool-[a-f0-9-]+/)?.[0] ?? '' : 'pong';
    const completion = {
      id: 'fixture_completion', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else response.end(JSON.stringify(completion));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
beforeEach(() => { requests = []; });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const model = (): Model => ({ id: 'orca-fixture', name: modelName, ApiKey: key, baseUrl, provider: 'orcarouter', adapter: 'openai' });

it('infers the official hostname without matching credentials, paths or lookalike domains', () => {
  expect(getProviderFromBaseUrl('https://API.ORCAROUTER.AI./v1')).toBe('orcarouter');
  for (const url of ['https://api.orcarouter.ai.attacker.test/v1', 'https://api.orcarouter.ai@attacker.test/v1', 'https://attacker.test/api.orcarouter.ai/v1']) {
    expect(getProviderFromBaseUrl(url)).toBe('ollama');
  }
});

it('discovers authenticated vendor/model IDs through the configured catalogue endpoint', async () => {
  expect(await fetchModelsFromProvider('orcarouter', baseUrl, key)).toEqual([
    expect.objectContaining({ id: modelName, name: 'Fixture model', supportsTools: true, contextWindow: 32000 }),
  ]);
  expect(requests.map(request => request.path)).toEqual(['/v1/models']);
  expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);
});

it('uses the real Chat Completions SDK without gateway attribution or Responses routing', async () => {
  const result = await new OpenAiAdapter().createCompletion({ model: model(), apiKey: key, messages: [{ role: 'user', content: 'ping' }] });
  expect(result.completion.choices[0].message.content).toBe('pong');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: modelName } });
  expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);
  expect(requests[0].headers['http-referer']).toBeUndefined();
  expect(requests[0].headers['x-title']).toBeUndefined();
});

it('streams through the same adapter and emits live text', async () => {
  const onModelDelta = jest.fn();
  const result = await new OpenAiAdapter().createStreamCompletion({ model: model(), apiKey: key, messages: [{ role: 'user', content: 'ping' }], onModelDelta });
  expect(result.completion.choices[0].message.content).toBe('pong');
  expect(onModelDelta).toHaveBeenCalledWith(expect.objectContaining({ contentDelta: 'pong' }));
  expect(requests[0].body?.stream).toBe(true);
});

it('runs the actual connection test and diagnostic tool round trip over loopback HTTP', async () => {
  const result = await testModelConnection({ modelName, baseUrl, apiKey: key, provider: 'orcarouter', adapter: 'openai' });
  expect(result).toMatchObject({ ok: true, provider: 'orcarouter', sdk: { ok: true }, axios: { ok: true }, tool: { ok: true } });
  expect(requests.every(request => request.path === '/v1/chat/completions')).toBe(true);
  expect(requests.some(request => request.body?.messages.some(message => message.role === 'tool'))).toBe(true);
});

it('reports invalid API keys through the real SDK and HTTP diagnostics', async () => {
  const result = await testModelConnection({ modelName, baseUrl, apiKey: 'wrong-fixture-key', provider: 'orcarouter', adapter: 'openai' });
  expect(result).toMatchObject({ ok: false, sdk: { ok: false, status: 401 }, axios: { ok: false, status: 401 } });
  expect(result.diagnosis).toMatch(/auth|API key/i);
});

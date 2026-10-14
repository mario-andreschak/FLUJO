import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { fetch as ownerFetch } from 'undici';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import {
  executionOwnerModelRouting, issueExecutionModelStepContext, registerExecutionExtension,
  type ExecutionExtensionContext, type ExecutionOwnerModelDispatchRequest, type ExecutionOwnerModelRouting,
} from '@/backend/execution/extensions';
import type { Model } from '@/shared/types/model';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn(),
}) }));

const routingNames = ['openai-organization', 'openai-project', 'http-referer', 'x-title'] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const approved: ExecutionOwnerModelRouting = {
  'openai-organization': 'org-owner-approved', 'openai-project': 'proj-owner-approved',
  'http-referer': 'https://owner.example', 'x-title': 'Owner workspace',
};
const environmentNames = ['OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_CUSTOM_HEADERS'] as const;
let environment: Partial<Record<typeof environmentNames[number], string>>;
let server: Server;
let baseUrl: string;
let received: Array<{ url?: string; headers: IncomingHttpHeaders }>;
let restore: (() => void) | undefined;

function model(): Model {
  return { id: 'owner-model', name: 'fixture', provider: 'openai', adapter: 'openai',
    baseUrl, ApiKey: '', ownerCredentialBinding: { ownerId: 'owner', credentialId: 'account' } };
}
async function child(routing: unknown = {}, onRead?: () => void) {
  const run = fixtureRun();
  const dispatchModelRequest = jest.fn(async (_step: object, request: ExecutionOwnerModelDispatchRequest) => {
    // This fixture owner, rather than the source SDK, supplies a fake key and
    // opens the socket. No real provider or provider credential is involved.
    const headers = new Headers(request.headers as [string, string][]);
    headers.set('authorization', 'Bearer owner-loopback-fixture');
    const result = await ownerFetch(request.url, { method: 'POST', headers, body: request.body, redirect: 'manual' });
    return new Response(await result.arrayBuffer(), { status: result.status,
      headers: { 'content-type': result.headers.get('content-type') ?? 'application/json' } });
  });
  const ownerModelRouting = jest.fn(async () => { onRead?.(); return routing as ExecutionOwnerModelRouting; });
  const owner = fixtureAdapter({ ownerModelRouting,
    issueModelStep: async (parent: object) => ({ ...parent, child: true }), dispatchModelRequest });
  restore?.(); restore = registerExecutionExtension(owner);
  const parent = mintFixture(owner, run);
  const context = await issueExecutionModelStepContext(parent, model(), { nodeId: 'process', ordinal: 0 });
  return { run, parent, context, ownerModelRouting, dispatchModelRequest };
}

beforeEach(async () => {
  environment = {};
  for (const name of environmentNames) environment[name] = process.env[name];
  process.env.OPENAI_ORG_ID = 'org-ambient-unapproved';
  process.env.OPENAI_PROJECT_ID = 'proj-ambient-unapproved';
  delete process.env.OPENAI_CUSTOM_HEADERS;
  received = [];
  server = createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture',
          choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
            message: { role: 'assistant', content: 'OK', refusal: null } }] }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterEach(async () => {
  restore?.(); restore = undefined;
  for (const name of environmentNames) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  jest.restoreAllMocks();
});

it.each([
  ['response', {}], ['stream', {}], ['response', approved], ['stream', approved],
] as const)('uses only owner routing through the real SDK for %s with %j', async (mode, routing) => {
  const { context, ownerModelRouting, dispatchModelRequest } = await child(routing);
  const input = { model: model(), apiKey: '', executionExtensionContext: context,
    messages: [{ role: 'user' as const, content: 'Routing fixture' }] };
  const adapter = new OpenAiAdapter();
  const result = mode === 'stream' ? await adapter.createStreamCompletion(input) : await adapter.createCompletion(input);
  expect(result.completion.choices[0].message.content).toBe('OK');
  expect(ownerModelRouting).toHaveBeenCalledTimes(1);
  expect(dispatchModelRequest).toHaveBeenCalledTimes(1);
  expect(received).toHaveLength(1);
  expect(received[0].url).toBe('/v1/chat/completions');
  expect(received[0].headers.authorization).toBe('Bearer owner-loopback-fixture');
  const request = dispatchModelRequest.mock.calls[0][1];
  expect(request.headers.some(([name]) => name === 'authorization')).toBe(false);
  expect(JSON.stringify(request)).not.toContain('owner-loopback-fixture');
  expect(request.headersSha256).toBe(digest(JSON.stringify(request.headers)));
  const projection: ExecutionOwnerModelRouting = routing;
  for (const name of routingNames) {
    const expected = projection[name];
    expect(received[0].headers[name]).toBe(expected);
    expect(request.headers.find(([key]) => key === name)?.[1]).toBe(expected);
  }
  expect(request.routingHeaderSha256).toEqual({
    openaiOrganization: projection['openai-organization'] === undefined ? null : digest(projection['openai-organization']),
    openaiProject: projection['openai-project'] === undefined ? null : digest(projection['openai-project']),
    httpReferer: projection['http-referer'] === undefined ? null : digest(projection['http-referer']),
    xTitle: projection['x-title'] === undefined ? null : digest(projection['x-title']),
  });
  expect(input.model.ApiKey).toBe('');
});

it('keeps ordinary SDK account routing and provider attribution unchanged', async () => {
  const ordinary: Model = { ...model(), provider: 'openrouter', ApiKey: 'ordinary-loopback-fixture', ownerCredentialBinding: undefined };
  await new OpenAiAdapter().createCompletion({ model: ordinary, apiKey: ordinary.ApiKey,
    messages: [{ role: 'user', content: 'Ordinary fixture' }] });
  expect(received[0].headers['openai-organization']).toBe('org-ambient-unapproved');
  expect(received[0].headers['openai-project']).toBe('proj-ambient-unapproved');
  expect(received[0].headers['http-referer']).toBe('https://flujo.com.co');
  expect(received[0].headers['x-title']).toBe('FLUJO');
  const ordinaryClient = createOpenAIClient({ apiKey: ordinary.ApiKey, baseURL: baseUrl });
  expect(ordinaryClient.organization).toBe('org-ambient-unapproved');
  expect(ordinaryClient.project).toBe('proj-ambient-unapproved');
});

it('requires a genuine unconsumed child and rechecks revocation after the owner routing read', async () => {
  const first = await child(approved);
  await expect(executionOwnerModelRouting(first.parent)).rejects.toMatchObject({ code: 'execution_model_step_required' });
  await expect(executionOwnerModelRouting({ ...first.context } as ExecutionExtensionContext))
    .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
  expect(first.ownerModelRouting).not.toHaveBeenCalled();
  const second = await child(approved, () => revoke());
  const revoke: () => void = () => { second.run.revoked = true; };
  await expect(executionOwnerModelRouting(second.context)).rejects.toMatchObject({ code: 'fixture_authorization_denied' });
  expect(second.dispatchModelRequest).not.toHaveBeenCalled();
  expect(received).toHaveLength(0);
});

it.each([
  { authorization: 'Bearer private-fixture' },
  { 'openai-project': 'project\r\nAuthorization: forbidden' },
  { 'openai-project': ' project-with-padding ' },
  { 'openai-project': 'x'.repeat(4097) },
  new Proxy({ 'openai-project': 'project' }, {}),
])('refuses malformed or credential-bearing owner routing before dispatch', async routing => {
  const { context, dispatchModelRequest } = await child(routing);
  await expect(new OpenAiAdapter().createCompletion({ model: model(), apiKey: '', executionExtensionContext: context,
    messages: [{ role: 'user', content: 'Routing fixture' }] }))
    .rejects.toMatchObject({ code: 'execution_owner_model_routing_invalid' });
  expect(dispatchModelRequest).not.toHaveBeenCalled();
  expect(received).toHaveLength(0);
});

it('does not invoke routing getters or accept a public model routing projection', async () => {
  const getter = jest.fn(() => 'private getter result');
  const routing = Object.defineProperty({}, 'openai-project', { enumerable: true, get: getter });
  const first = await child(routing);
  await expect(executionOwnerModelRouting(first.context)).rejects.toMatchObject({ code: 'execution_owner_model_routing_invalid' });
  expect(getter).not.toHaveBeenCalled();
  const second = await child({});
  const publicModel = { ...model(), routingHeaders: approved };
  await new OpenAiAdapter().createCompletion({ model: publicModel, apiKey: '', executionExtensionContext: second.context,
    messages: [{ role: 'user', content: 'Routing fixture' }] });
  for (const name of routingNames) expect(received[0].headers[name]).toBeUndefined();
  await expect(executionOwnerModelRouting(second.context))
    .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
});

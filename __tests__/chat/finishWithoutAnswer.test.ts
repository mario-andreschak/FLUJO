/**
 * #1419: a model can hand off to Finish after reasoning only, without writing
 * any answer. FLUJO then replied with `content: ""` while the reasoning tokens
 * were counted, which looks exactly like a lost answer.
 *
 * Each flow (Start -> Process with one MCP tool -> Finish) runs through the
 * real /v1/chat/completions route, storage and locks. The Process node's model
 * is either an OpenAI-compatible stand-in on this machine, or a Claude
 * subscription model: FLUJO's own adapter driving the installed Agent SDK with
 * its bundled Claude Code, which talks to a stand-in model service. The
 * stand-ins replay the shapes recorded in the issue: a reasoning block plus
 * the hand-off call and no text, after a tool round or without one.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { FINISH_ANSWER_INSTRUCTION, NO_ANSWER_TEXT } from '@/backend/execution/flow/finishAnswer';
import { createClaudeSdkRelay, startClaudeModelStandIn, type ClaudeModelStandIn, type StandInBlock } from '../model/fixtures/claudeSdkStandIn';
import { stopBackgroundWorkers } from '../helpers/backgroundWorkers';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));
const queryMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: jest.fn(),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
const mockClaude = { home: '' };
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: mockClaude.home, workingDirectory: `${mockClaude.home}/workspace`, env: {},
  })),
}));

jest.setTimeout(180_000);

const ENV = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE'] as const;
const ANSWER = 'The pharmacy is open from 8:00 to 18:00.';
const HOURS = 'opening hours: 8-18';
const REASONING = 'The tool says 8 to 18. That answers the question, so I am done and hand off to Finish.';
const TOOL = { name: 'opening_hours', description: 'Look up the opening hours.', inputSchema: { type: 'object' as const, properties: {} } };

let root: string;
let previous: Array<string | undefined>;
let mcpServer: HttpServer;
let openAiServer: HttpServer;
let claude: ClaudeModelStandIn;
const mcpSessions = new Map<string, StreamableHTTPServerTransport>();
const relay = createClaudeSdkRelay({ baseUrl: () => claude.baseUrl, home: () => mockClaude.home });

/** One OpenAI-compatible model reply: text, reasoning and tool calls by tool-name fragment. */
interface OpenAiReply { content?: string; reasoning?: string; calls?: Array<{ tool: string; args?: Record<string, unknown> }> }
interface OpenAiRequest { messages: Array<{ role: string; content?: unknown }>; tools: string[] }
let openAiScript: (request: number) => OpenAiReply;
let openAiRequests: OpenAiRequest[];

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function openAiStandIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(request)).toString('utf8'));
  const tools: string[] = (body.tools ?? []).map((item: { function?: { name?: string } }) => String(item.function?.name));
  const index = openAiRequests.push({ messages: body.messages ?? [], tools }) - 1;
  const reply = openAiScript(index);
  const toolCalls = (reply.calls ?? []).map((call, position) => ({
    id: `call_${index + 1}_${position}`, type: 'function',
    function: { name: tools.find(name => name.includes(call.tool)) ?? call.tool, arguments: JSON.stringify(call.args ?? {}) },
  }));
  const finish = toolCalls.length ? 'tool_calls' : 'stop';
  const id = `stand-in-${randomUUID()}`;
  if (body.stream) {
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'stand-in', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(chunk({ role: 'assistant', content: null }));
    if (reply.reasoning) response.write(chunk({ reasoning_content: reply.reasoning }));
    if (reply.content) response.write(chunk({ content: reply.content }));
    toolCalls.forEach((call, position) => response.write(chunk({ tool_calls: [{ index: position, ...call }] })));
    response.write(chunk({}, finish));
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'stand-in', choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 600, total_tokens: 650 } })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: 'stand-in',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: reply.content ?? null,
      ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 50, completion_tokens: 600, total_tokens: 650 } }));
}

async function mcpStandIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readBody(request);
  const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  let transport = mcpSessions.get(String(request.headers['mcp-session-id']));
  if (!transport && body?.method === 'initialize') {
    const server = new Server({ name: 'hours-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: HOURS }] }));
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    await server.connect(transport);
  }
  if (!transport) {
    response.writeHead(request.method === 'GET' ? 405 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
    return;
  }
  await transport.handleRequest(request, response, body);
  if (transport.sessionId) mcpSessions.set(transport.sessionId, transport);
}

function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): HttpServer {
  return createServer((request, response) => {
    handler(request, response).catch(error => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  previous = ENV.map(name => process.env[name]);
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-finish-answer-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, randomBytes(32).toString('base64url'));
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secret;
  mcpServer = serve(mcpStandIn);
  openAiServer = serve(openAiStandIn);
  const mcpPort = await listen(mcpServer);
  const openAiPort = await listen(openAiServer);
  claude = await startClaudeModelStandIn(300);

  const { runWithWorkspace, ensureWorkspaceDirs } = await import('@/utils/workspace');
  const { modelService } = await import('@/backend/services/model');
  const { mcpService } = await import('@/backend/services/mcp');
  const { saveCollectionItem } = await import('@/utils/storage/backend');
  await runWithWorkspace('default-workspace', async () => {
    await ensureWorkspaceDirs();
    expect((await modelService.addModel({ id: 'openai-model', name: 'stand-in', displayName: 'OpenAI-compatible stand-in',
      provider: 'openai', adapter: 'openai', ApiKey: 'stand-in-key', baseUrl: `http://127.0.0.1:${openAiPort}/v1` })).success).toBe(true);
    expect((await modelService.addModel({ id: 'claude-model', name: 'sonnet', displayName: 'Claude stand-in',
      provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: 'stand-in-oauth-token' })).success).toBe(true);
    const server: MCPStreamableConfig = { name: 'hours', transport: 'streamable', serverUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '' };
    expect(await mcpService.updateServerConfig('hours', server)).not.toHaveProperty('error');
    for (const model of ['openai-model', 'claude-model']) {
      const node = (id: string, type: string, properties: Record<string, unknown> = {}) =>
        ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
      const nodes = [
        node('start', 'start', { promptTemplate: 'You answer questions about a pharmacy.' }),
        node('process', 'process', { boundModel: model, allowQuestion: false, promptTemplate: 'Answer the question. Use the tool for opening hours.' }),
        node('tools', 'mcp', { boundServer: 'hours', enabledTools: [TOOL.name] }),
        node('finish', 'finish'),
      ];
      const edge = (source: typeof nodes[number], target: typeof nodes[number]) => ({
        id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
        sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
      await saveCollectionItem('flows', `flow-${model}`, { id: `flow-${model}`, name: `Finish-${model}`, nodes, updatedAt: Date.now(), edges: [
        edge(nodes[0], nodes[1]), edge(nodes[1], nodes[3]),
        { id: 'tools-process', source: 'tools', target: 'process', type: 'custom', data: { edgeType: 'mcp' } },
      ] });
    }
  });
});

afterAll(async () => {
  await settle();
  await relay.settled();
  await stopBackgroundWorkers();
  const { runWithWorkspace } = await import('@/utils/workspace');
  const { mcpService } = await import('@/backend/services/mcp');
  const { retireIdleWorkspaceWriterRegistration } = await import('@/backend/services/enduringAgents/runtimeLock');
  const { flushStatisticsEvents } = await import('@/backend/services/statistics');
  await runWithWorkspace('default-workspace', () => mcpService.disconnectAll('test finished'));
  for (const transport of mcpSessions.values()) await transport.close().catch(() => undefined);
  for (const server of [mcpServer, openAiServer]) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await claude.close();
  await flushStatisticsEvents();
  await runWithWorkspace('default-workspace', () => retireIdleWorkspaceWriterRegistration());
  ENV.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(async () => {
  openAiRequests = [];
  claude.requests = [];
  claude.offeredTools = [];
  mockClaude.home = await fs.mkdtemp(path.join(root, 'claude-home-'));
  queryMock.mockReset().mockImplementation(relay.relayQuery);
});

/** Runs keep saving their state briefly after the reply ends; let them finish. */
async function settle(): Promise<void> {
  const { getFlowRunAdmissionDiagnostics } = await import('@/backend/execution/flow/runAdmission');
  for (let wait = 0; wait < 400 && getFlowRunAdmissionDiagnostics().activeRuns > 0; wait++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

interface Reply {
  status: number;
  content: string;
  body: { flujo_no_answer?: boolean; messages?: FlujoChatMessage[]; conversation_id?: string; error?: { message: string } };
}

async function ask(model: 'openai-model' | 'claude-model', stream = false): Promise<Reply> {
  const { POST } = await import('@/app/v1/chat/completions/route');
  const payload = JSON.stringify({ model: `flow-Finish-${model}`, stream, messages: [{ id: randomUUID(), role: 'user', content: 'When are you open?' }] });
  const response = await POST(new NextRequest('http://localhost/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, body: payload }));
  let content = '';
  let body: Reply['body'] = {};
  if (stream) {
    for (const line of (await response.text()).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const chunk = JSON.parse(line.slice(6));
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (delta?.flujo_no_answer) body.flujo_no_answer = true;
      if (delta?.conversation?.messages) body.messages = delta.conversation.messages;
    }
  } else {
    body = JSON.parse(await response.text());
    content = (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
  }
  await settle();
  await relay.settled();
  return { status: response.status, content, body };
}

const lastAssistant = (messages: FlujoChatMessage[] = []) => [...messages].reverse().find(message => message.role === 'assistant');
const wireText = (request: OpenAiRequest) => JSON.stringify(request.messages);
/** The step's tools, leaving out read_resource: it stays so a saved tool result can still be read back. */
const stepTools = (tools: string[]) => tools.filter(name => !name.endsWith('read_resource'));

describe('a hand-off to Finish without an answer, OpenAI-compatible model (#1419)', () => {
  it('asks once more without tools when the hand-off turn holds only reasoning', async () => {
    openAiScript = request => request === 0
      ? { reasoning: REASONING, calls: [{ tool: 'handoff_to_' }] }
      : { content: ANSWER };

    const reply = await ask('openai-model');

    expect(reply.status).toBe(200);
    expect(reply.content).toBe(ANSWER);
    expect(openAiRequests).toHaveLength(2);
    expect(openAiRequests[0].tools.some(name => name.startsWith('handoff_to_'))).toBe(true);
    expect(stepTools(openAiRequests[1].tools)).toEqual([]);
    expect(openAiRequests[1].messages.at(-1)).toEqual({ role: 'user', content: FINISH_ANSWER_INSTRUCTION });
    expect(reply.body.flujo_no_answer).toBeUndefined();
    // The instruction is for the model only; the person's transcript holds the answer.
    expect(JSON.stringify(reply.body.messages)).not.toContain(FINISH_ANSWER_INSTRUCTION);
    expect(lastAssistant(reply.body.messages)?.content).toBe(ANSWER);
  });

  it('asks once more when there is no text anywhere in a run with a tool round', async () => {
    openAiScript = request => [
      { reasoning: 'I need the opening hours.', calls: [{ tool: TOOL.name }] },
      { reasoning: REASONING, calls: [{ tool: 'handoff_to_' }] },
    ][request] ?? { content: ANSWER };

    const reply = await ask('openai-model');

    expect(reply.content).toBe(ANSWER);
    expect(openAiRequests).toHaveLength(3);
    expect(stepTools(openAiRequests[2].tools)).toEqual([]);
    expect(wireText(openAiRequests[2])).toContain(HOURS);
    expect(openAiRequests[2].messages.at(-1)).toEqual({ role: 'user', content: FINISH_ANSWER_INSTRUCTION });
  });

  it('takes the answer from the hand-off call when the model passed it there', async () => {
    openAiScript = () => ({ reasoning: REASONING, calls: [{ tool: 'handoff_to_', args: { answer: ANSWER } }] });

    const reply = await ask('openai-model');

    expect(reply.content).toBe(ANSWER);
    expect(openAiRequests).toHaveLength(1);
    expect(lastAssistant(reply.body.messages)?.content).toBe(ANSWER);
  });

  it('leaves a hand-off turn that carries its answer unchanged', async () => {
    openAiScript = () => ({ content: ANSWER, calls: [{ tool: 'handoff_to_' }] });

    const reply = await ask('openai-model');

    expect(reply.content).toBe(ANSWER);
    expect(openAiRequests).toHaveLength(1);
  });

  it('never replies with an empty success when the model stays silent', async () => {
    openAiScript = request => request === 0 ? { reasoning: REASONING, calls: [{ tool: 'handoff_to_' }] } : {};

    const reply = await ask('openai-model');

    // The provider's empty reply is retried as for any model call (#288), then reported.
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.body.error?.message).toMatch(/empty message/);
    expect(openAiRequests.slice(1).every(request => stepTools(request.tools).length === 0)).toBe(true);
  });
});

describe('a hand-off to Finish without an answer, Claude subscription with the bundled Claude Code (#1419)', () => {
  const offered = (request: number, fragment: string) => {
    const name = claude.offeredTools[request].find(tool => tool.includes(fragment));
    if (!name) throw new Error(`request ${request} offered no ${fragment}: ${claude.offeredTools[request].join(', ')}`);
    return name;
  };
  const toolUse = (request: number, fragment: string): StandInBlock => ({ type: 'tool_use', name: offered(request, fragment), input: {} });
  const thinking = (value: string): StandInBlock => ({ type: 'thinking', thinking: value });
  const text = (value: string): StandInBlock => ({ type: 'text', text: value });
  const flujoTools = (request: number) => stepTools(claude.offeredTools[request].filter(name => name.startsWith('mcp__')));

  it('asks once more without tools when the hand-off turn holds only reasoning', async () => {
    claude.script = request => request === 0 ? [thinking(REASONING), toolUse(0, 'handoff_to_')] : [text(ANSWER)];

    const reply = await ask('claude-model');

    expect(reply.status).toBe(200);
    expect(reply.content).toBe(ANSWER);
    expect(claude.requests).toHaveLength(2);
    expect(flujoTools(1)).toEqual([]);
    expect(claude.requests[1]).toContain(FINISH_ANSWER_INSTRUCTION);
    expect(reply.body.flujo_no_answer).toBeUndefined();
    expect(lastAssistant(reply.body.messages)?.content).toBe(ANSWER);
  });

  it('asks once more when there is no text anywhere in a run with a tool round', async () => {
    claude.script = request => [
      () => [thinking('I need the opening hours.'), toolUse(0, TOOL.name)],
      () => [thinking(REASONING), toolUse(1, 'handoff_to_')],
    ][request]?.() ?? [text(ANSWER)];

    const reply = await ask('claude-model');

    expect(reply.content).toBe(ANSWER);
    expect(claude.requests).toHaveLength(3);
    expect(flujoTools(2)).toEqual([]);
    expect(claude.requests[2]).toContain(HOURS);
    expect(claude.requests[2]).toContain(FINISH_ANSWER_INSTRUCTION);
  });

  it('says in words that there is no answer when the model stays silent, and marks the message', async () => {
    claude.script = request => request === 0 ? [thinking(REASONING), toolUse(0, 'handoff_to_')] : [thinking('Nothing to add.')];

    const reply = await ask('claude-model');

    expect(reply.status).toBe(200);
    expect(reply.content).toBe(NO_ANSWER_TEXT);
    expect(reply.body.flujo_no_answer).toBe(true);
    // FLUJO asks once: one Claude Code run for the step, one for the answer.
    // Claude Code itself nudges a reply without visible text once more.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(claude.requests.at(-1)).toContain('no visible output');
    expect(lastAssistant(reply.body.messages)).toMatchObject({ noAnswer: true });
    // The chat reloads the saved conversation when a run ends: the mark is saved too.
    const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
    const { loadConversationState } = await import('@/backend/execution/flow/loadConversationState');
    const { runWithWorkspace } = await import('@/utils/workspace');
    FlowExecutor.conversationStates.delete(reply.body.conversation_id!);
    const saved = await runWithWorkspace('default-workspace', () => loadConversationState(reply.body.conversation_id!));
    expect(lastAssistant(saved?.messages)).toMatchObject({ noAnswer: true });
  });

  it('streams the same words when the model stays silent', async () => {
    claude.script = request => request === 0 ? [thinking(REASONING), toolUse(0, 'handoff_to_')] : [thinking('Nothing to add.')];

    const reply = await ask('claude-model', true);

    expect(reply.content).toBe(NO_ANSWER_TEXT);
    expect(reply.body.flujo_no_answer).toBe(true);
  });
});

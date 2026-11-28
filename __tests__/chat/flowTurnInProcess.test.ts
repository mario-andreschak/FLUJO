/**
 * #1404: FLUJO's own time per flow turn, without a production build.
 *
 * The flow of scripts/flow-turn-benchmark.mjs (one Process node, three MCP
 * tools, one knowledge resource bound with `${resource:...}`) runs through the
 * real /v1/chat/completions route, storage and locks, against a loopback stub
 * model and a loopback stub MCP server. By default one streamed answer, one
 * streamed tool turn and two turns of one continued conversation must answer.
 *
 * To measure, start Jest with the step timers on (the setup file loads them,
 * so the variable must be set before Jest starts):
 *
 *   FLUJO_TURN_TRACE_FILE=<file> FLUJO_TURN_BENCH_OUT=<result.json> \
 *     node scripts/run-local-jest.cjs __tests__/chat/flowTurnInProcess.test.ts --runInBand
 *
 * The result has the benchmark's format, so two results compare with
 * `node scripts/flow-turn-benchmark.mjs --compare <before.json> <after.json>`.
 * FLUJO_TURN_BENCH_RUNS sets the runs per kind of turn (12) and
 * FLUJO_TURN_BENCH_WARMUP the warm-up turns before them (8; 0 makes run 1 of
 * the streamed answer the cold turn).
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
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { stopBackgroundWorkers } from '../helpers/backgroundWorkers';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));

const outFile = process.env.FLUJO_TURN_BENCH_OUT;
const traceFile = process.env.FLUJO_TURN_TRACE_FILE;
const RUNS = outFile ? Number(process.env.FLUJO_TURN_BENCH_RUNS ?? 12) : 2;
const WARMUP = outFile ? Number(process.env.FLUJO_TURN_BENCH_WARMUP ?? 8) : 0;
jest.setTimeout(outFile ? 900_000 : 120_000);

const ENV = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WRITER_LEASE_IDLE_MS', 'FLUJO_LOW_LATENCY_SAVES'] as const;
const STUB_KEY = 'bench-stub-key';
const KNOWLEDGE_URI = 'bench://kb/faq';
const KNOWLEDGE = Array.from({ length: 40 }, (_, index) =>
  `Q${index + 1}: Opening hours of store ${index + 1}? A: 8:00 to 20:00, Monday to Saturday.`).join('\n');
const TOOLS = [
  { name: 'lookup_order', description: 'Look up an order by id.', inputSchema: { type: 'object' as const,
    properties: { order_id: { type: 'string', description: 'Order id' } }, required: ['order_id'] } },
  { name: 'list_stores', description: 'List stores near a city.', inputSchema: { type: 'object' as const, properties: { city: { type: 'string' } } } },
  { name: 'check_stock', description: 'Check stock for a product.', inputSchema: { type: 'object' as const,
    properties: { sku: { type: 'string' } }, required: ['sku'] } },
];

interface ModelCall { arrival: number; firstChunk: number; done: number; tool: boolean }
interface McpCall { method: string; arrival: number; replied?: number }
let current: { model: ModelCall[]; mcp: McpCall[] } | undefined;
const now = () => performance.now();

let root: string;
let previous: Array<string | undefined>;
let modelServer: HttpServer;
let mcpServer: HttpServer;
const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

function chunk(id: string, delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'bench-model',
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** Answers at once, or asks for lookup_order once when the caller's message says [bench:tool]. */
async function stubModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const arrival = now();
  const body = JSON.parse((await readBody(request)).toString('utf8'));
  const messages: Array<{ role: string }> = body.messages ?? [];
  const wantsTool = JSON.stringify(messages).includes('[bench:tool]') && !messages.some(message => message.role === 'tool');
  const tool: { function: { name: string } } | undefined = wantsTool
    ? (body.tools ?? []).find((item: { function?: { name?: string } }) => item.function?.name?.includes('lookup_order'))
    : undefined;
  const call: ModelCall = { arrival, firstChunk: arrival, done: arrival, tool: Boolean(tool) };
  current?.model.push(call);
  const id = `bench-${randomUUID()}`;
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    call.firstChunk = now();
    if (tool) {
      response.write(chunk(id, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_bench_1', type: 'function',
        function: { name: tool.function.name, arguments: '' } }] }));
      response.write(chunk(id, { tool_calls: [{ index: 0, function: { arguments: '{"order_id":"A-1"}' } }] }));
      response.write(chunk(id, {}, 'tool_calls'));
    } else {
      response.write(chunk(id, { role: 'assistant', content: 'Your order A-1 ships today' }));
      await new Promise(resolve => setTimeout(resolve, 20));
      response.write(chunk(id, { content: ' from the Main Street store.' }));
      response.write(chunk(id, {}, 'stop'));
    }
    response.end('data: [DONE]\n\n');
  } else {
    if (!tool) await new Promise(resolve => setTimeout(resolve, 20));
    call.firstChunk = now();
    const message = tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_bench_1', type: 'function',
        function: { name: tool.function.name, arguments: '{"order_id":"A-1"}' } }] }
      : { role: 'assistant', content: 'Your order A-1 ships today from the Main Street store.' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: 'bench-model',
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  }
  call.done = now();
}

async function stubMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const arrival = now();
  const raw = await readBody(request);
  const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  const methods: string[] = (Array.isArray(body) ? body : body ? [body] : []).map((message: { method?: string }) => message.method ?? 'response');
  const entry: McpCall = { method: request.method === 'POST' ? methods.join('+') : String(request.method), arrival };
  if (request.method === 'POST') current?.mcp.push(entry);
  response.once('finish', () => { entry.replied = now(); });
  let transport = mcpSessions.get(String(request.headers['mcp-session-id']));
  if (!transport && body?.method === 'initialize') {
    const server = new Server({ name: 'bench-mcp', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: KNOWLEDGE_URI, name: 'Shop FAQ', mimeType: 'text/plain' }] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, read => ({ contents: [{ uri: read.params.uri, mimeType: 'text/plain', text: KNOWLEDGE }] }));
    server.setRequestHandler(CallToolRequestSchema, call => ({ content: [{ type: 'text', text: JSON.stringify({
      tool: call.params.name, order: 'A-1', status: 'ships today', store: 'Main Street' }) }] }));
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
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-flow-turn-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, randomBytes(32).toString('base64url'));
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secret;
  // Like a production server: one shared writer registration per burst of saves.
  delete process.env.FLUJO_WRITER_LEASE_IDLE_MS;
  if (traceFile) await fs.writeFile(traceFile, '');
  modelServer = serve(stubModel);
  mcpServer = serve(stubMcp);
  const modelPort = await listen(modelServer);
  const mcpPort = await listen(mcpServer);

  const { runWithWorkspace, ensureWorkspaceDirs } = await import('@/utils/workspace');
  const { modelService } = await import('@/backend/services/model');
  const { mcpService } = await import('@/backend/services/mcp');
  const { saveCollectionItem } = await import('@/utils/storage/backend');
  await runWithWorkspace('default-workspace', async () => {
    await ensureWorkspaceDirs();
    const saved = await modelService.addModel({ id: 'bench-model', name: 'bench-model', displayName: 'bench-model',
      provider: 'openai', adapter: 'openai', ApiKey: STUB_KEY, baseUrl: `http://127.0.0.1:${modelPort}/v1` });
    expect(saved.success).toBe(true);
    const server: MCPStreamableConfig = { name: 'bench', transport: 'streamable', serverUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '' };
    expect(await mcpService.updateServerConfig('bench', server)).not.toHaveProperty('error');
    const node = (id: string, type: string, properties: Record<string, unknown> = {}) =>
      ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
    const nodes = [
      node('start', 'start', { promptTemplate: 'You are the voice assistant of a small shop. Keep answers short.' }),
      node('process', 'process', { boundModel: 'bench-model', inputMode: 'full-history', allowQuestion: false,
        promptTemplate: 'Answer the caller in one or two sentences. Use a tool when you need order data.\n'
          + `Shop knowledge:\n\${resource:bench__${KNOWLEDGE_URI}}` }),
      node('tools', 'mcp', { boundServer: 'bench', enabledTools: TOOLS.map(tool => tool.name), enabledResources: 'all' }),
      node('finish', 'finish'),
    ];
    const edge = (source: typeof nodes[number], target: typeof nodes[number]) => ({
      id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
      sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
    await saveCollectionItem('flows', 'voice-bench-flow', { id: 'voice-bench-flow', name: 'VoiceBench', nodes, updatedAt: Date.now(), edges: [
      edge(nodes[0], nodes[1]), edge(nodes[1], nodes[3]),
      { id: 'tools-process', source: 'tools', target: 'process', type: 'custom', data: { edgeType: 'mcp' } },
    ] });
  });
});

afterAll(async () => {
  await settle();
  await stopBackgroundWorkers();
  const { runWithWorkspace } = await import('@/utils/workspace');
  const { mcpService } = await import('@/backend/services/mcp');
  const { retireIdleModelCatalogReader, retireIdleWorkspaceWriterRegistration } = await import('@/backend/services/enduringAgents/runtimeLock');
  const { flushStatisticsEvents } = await import('@/backend/services/statistics');
  await runWithWorkspace('default-workspace', () => mcpService.disconnectAll('test finished'));
  for (const transport of mcpSessions.values()) await transport.close().catch(() => undefined);
  for (const server of [modelServer, mcpServer]) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await flushStatisticsEvents();
  await runWithWorkspace('default-workspace', async () => {
    await retireIdleModelCatalogReader();
    await retireIdleWorkspaceWriterRegistration();
  });
  ENV.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Runs keep saving their state briefly after the reply ends; let them finish. */
async function settle(): Promise<void> {
  const { getFlowRunAdmissionDiagnostics } = await import('@/backend/execution/flow/runAdmission');
  for (let wait = 0; wait < 400 && getFlowRunAdmissionDiagnostics().activeRuns > 0; wait++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

let traceLinesSeen = 0;
/** Sums the spans of the trace lines the last turn wrote (a streamed run writes its line when it ends). */
async function readTrace(): Promise<Record<string, number> | undefined> {
  if (!traceFile) return undefined;
  const deadline = Date.now() + 3000;
  let lines: string[] = [];
  do {
    lines = (await fs.readFile(traceFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (lines.length > traceLinesSeen) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  const totals: Record<string, number> = {};
  for (const line of lines.slice(traceLinesSeen)) {
    for (const span of (JSON.parse(line) as { spans?: Array<{ name: string; start: number; end: number }> }).spans ?? []) {
      totals[span.name] = Math.round(((totals[span.name] ?? 0) + span.end - span.start) * 10) / 10;
    }
  }
  traceLinesSeen = lines.length;
  return totals;
}

type Scenario = 'answer' | 'tool' | 'continue';
let continued: string | undefined;

async function turn(mode: 'stream' | 'json', scenario: Scenario) {
  const { POST } = await import('@/app/v1/chat/completions/route');
  const metadata = scenario === 'continue'
    ? { flujo: 'true', ...(continued ? { conversationId: continued, appendMessages: 'true' } : {}) }
    : undefined;
  const record = { model: [] as ModelCall[], mcp: [] as McpCall[] };
  current = record;
  const payload = JSON.stringify({ model: 'flow-VoiceBench', stream: mode === 'stream', ...(metadata ? { metadata } : {}),
    messages: [{ id: randomUUID(), role: 'user', content: scenario === 'tool' ? '[bench:tool] Where is my order A-1?' : 'When does store 3 open?' }] });
  const cpuStart = process.cpuUsage();
  const sent = now();
  const response = await POST(new NextRequest('http://localhost/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, body: payload }));
  expect(response.status).toBe(200);
  let content = '';
  let firstContent: number | undefined;
  let conversationId: string | undefined;
  if (mode === 'stream') {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += decoder.decode(read.value, { stream: true });
      for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
        const line = buffer.slice(0, index).split('\n').find(item => item.startsWith('data: '));
        buffer = buffer.slice(index + 2);
        if (!line || line === 'data: [DONE]') continue;
        const choice = JSON.parse(line.slice(6)).choices?.[0];
        expect(choice?.finish_reason).not.toBe('error');
        if (choice?.delta?.content) { firstContent ??= now(); content += choice.delta.content; }
        conversationId ??= choice?.delta?.conversation?.conversationId;
      }
    }
  } else {
    const parsed = JSON.parse(await response.text());
    content = parsed.choices?.[0]?.message?.content ?? '';
    conversationId = parsed.conversation_id;
  }
  const end = now();
  current = undefined;
  expect(content).toContain('ships today');
  if (scenario === 'continue') {
    if (continued) expect(conversationId).toBe(continued);
    continued ??= conversationId;
  }
  const trace = await readTrace();
  await settle();
  const cpu = process.cpuUsage(cpuStart);
  const ms = (value: number | undefined) => value === undefined ? undefined : Math.round(value * 10) / 10;
  const [first] = record.model;
  const last = record.model.at(-1);
  const answerCall = record.model.find(call => !call.tool) ?? last;
  const stubTime = record.model.reduce((sum, call) => sum + call.done - call.arrival, 0)
    + record.mcp.reduce((sum, entry) => sum + (entry.replied ?? entry.arrival) - entry.arrival, 0);
  return {
    total: ms(end - sent),
    before_model: ms(first && first.arrival - sent),
    first_token_from_send: ms(firstContent === undefined ? undefined : firstContent - sent),
    first_token_pass: ms(firstContent === undefined || !answerCall ? undefined : firstContent - answerCall.firstChunk),
    tool_roundtrip: ms(record.model.length > 1 ? record.model[1].arrival - record.model[0].done : undefined),
    after_model: ms(last && end - last.done),
    flujo_own: ms(end - sent - stubTime),
    cpu_ms: ms((cpu.user + cpu.system) / 1000),
    model_calls: record.model.length,
    mcp_calls: record.mcp.length,
    toolCalled: record.mcp.some(entry => entry.method === 'tools/call'),
    ...(trace ? { trace } : {}),
  };
}

it('answers flow turns with MCP tools and a bound resource through the real route', async () => {
  for (let run = 0; run < WARMUP; run++) await turn('stream', run % 2 ? 'tool' : 'answer');
  const plan: Array<[mode: 'stream' | 'json', scenario: Scenario]> = [['stream', 'answer'], ['stream', 'tool'], ['json', 'continue']];
  const series = [];
  for (const [mode, scenario] of plan) {
    continued = undefined;
    const runs = [];
    for (let run = 1; run <= RUNS; run++) runs.push({ run, ...await turn(mode, scenario) });
    expect(runs.map(run => [run.model_calls, run.toolCalled])).toEqual(runs.map(() => scenario === 'tool' ? [2, true] : [1, false]));
    series.push({ mode, scenario, runs });
  }
  if (outFile) {
    await fs.writeFile(outFile, JSON.stringify({ schemaVersion: 1, label: process.env.FLUJO_TURN_BENCH_LABEL ?? 'in-process',
      startedUtc: new Date().toISOString(), node: process.version, model: 'stub (in process)', runs: RUNS, series }, null, 2));
  }
});

it('keeps every finished turn on disk with fewer saves per turn (#1408)', async () => {
  const before = process.env.FLUJO_LOW_LATENCY_SAVES;
  process.env.FLUJO_LOW_LATENCY_SAVES = '1';
  try {
    const tool = await turn('stream', 'tool');
    expect([tool.model_calls, tool.toolCalled]).toEqual([2, true]);
    continued = undefined;
    await turn('json', 'continue');
    await turn('json', 'continue');
  } finally {
    if (before === undefined) delete process.env.FLUJO_LOW_LATENCY_SAVES;
    else process.env.FLUJO_LOW_LATENCY_SAVES = before;
  }
  const { runWithWorkspace } = await import('@/utils/workspace');
  const { loadItem } = await import('@/utils/storage/backend');
  const stored = await runWithWorkspace('default-workspace', () =>
    loadItem<{ status?: string; messages: Array<{ role: string; content?: unknown }>; recovery?: { classification?: string; currentCheckpoint?: { phase?: string } } }>(
      `conversations/${continued}` as never, undefined as never));
  expect(stored.status).toBe('completed');
  expect(stored.recovery).toMatchObject({ classification: 'completed', currentCheckpoint: { phase: 'node:after' } });
  const said = stored.messages.filter(message => message.role !== 'system').map(message => message.role);
  expect(said).toEqual(['user', 'assistant', 'user', 'assistant']);
});

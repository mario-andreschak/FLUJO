#!/usr/bin/env node
/**
 * Flow turn benchmark (issue #1404).
 *
 * Times one FLUJO flow turn through `POST /v1/chat/completions` with
 * `model: "flow-<name>"`, streaming and non-streaming, and splits the time into
 * steps. It starts its own production FLUJO server from a build (`.next`) with a
 * throwaway data folder, an instant OpenAI-compatible stub model and a stub MCP
 * server (three tools and one knowledge resource bound into the prompt with
 * `${resource:...}`). Every stub records when FLUJO reached it, so FLUJO's own
 * time is what is left between those moments. Nothing outside this machine is
 * contacted unless `--real` is given.
 *
 * Usage (build first: `npm run build`):
 *   node scripts/flow-turn-benchmark.mjs [--app <dir with .next>] [--runs 10]
 *     [--modes stream,json] [--scenarios answer,tool,continue] [--out <file.json>]
 *     [--label <text>] [--keep] [--no-owner-auth] [--fs-probe] [--profile <dir>]
 *   scenarios: answer   = a new conversation, the model answers at once
 *              tool     = a new conversation, the model calls one MCP tool first
 *              continue = one conversation across all runs; each run appends its
 *                         new message (metadata.appendMessages), like a voice app
 *   --no-owner-auth  run like a default localhost install (no owner sign-in file)
 *   --fs-probe       count file-system calls per turn inside the server
 *   --profile <dir>  write CPU profiles of the warm runs
 *   --node-options <flags>  extra Node flags for the server under test
 *   --compare <before.json> <after.json>  print two --out files side by side and exit
 *   --real   use a real model instead of the stub. Reads FLUJO_BENCH_REAL_BASE_URL
 *            (default https://api.openai.com/v1), FLUJO_BENCH_REAL_MODEL
 *            (default gpt-4.1-mini) and the key from FLUJO_BENCH_REAL_KEY or
 *            OPENAI_API_KEY.
 *
 * "cold" is the first turn after the server process started; every
 * mode/scenario pair gets its own fresh process for that. "warm" is the last run
 * (the 10th by default); the summary also shows the median of the warm runs.
 * When the server supports FLUJO_TURN_TRACE_FILE, its in-process step times
 * are added to each run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

// ---------------------------------------------------------------- arguments
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback, { flagValue = false } = {}) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  assert.ok(value && (flagValue || !value.startsWith('--')), `--${name} needs a value`);
  return value;
}
const flag = name => args.includes(`--${name}`);
const application = path.resolve(option('app', repo));
const runs = Number(option('runs', '10'));
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 200, '--runs must be 1..200');
const modes = option('modes', 'stream,json').split(',');
const scenarios = option('scenarios', 'answer,tool').split(',');
for (const mode of modes) assert.ok(['stream', 'json'].includes(mode), `Unknown mode ${mode}`);
for (const scenario of scenarios) assert.ok(['answer', 'tool', 'continue'].includes(scenario), `Unknown scenario ${scenario}`);
const outFile = option('out', undefined);
const label = option('label', path.basename(application));
const keep = flag('keep');
const real = flag('real');
const tokenGapMs = Number(option('token-gap', '20'));
// Optional CPU profile of the warm runs (runs 2..N), written as .cpuprofile files
// into this folder. Uses the Node inspector on a random loopback port.
const profileDir = option('profile', undefined);
// Optional per-turn file-system call counts from a diagnostic preload in the server.
const fsProbe = flag('fs-probe');
// Without owner sign-in the server runs like a default localhost desktop install.
const ownerAuth = !flag('no-owner-auth');
// Extra Node flags for the server under test, e.g. --node-options "--experimental-async-context-frame".
const extraNodeOptions = option('node-options', '', { flagValue: true });
const realModel = real ? {
  baseUrl: process.env.FLUJO_BENCH_REAL_BASE_URL || 'https://api.openai.com/v1',
  name: process.env.FLUJO_BENCH_REAL_MODEL || 'gpt-4.1-mini',
  key: process.env.FLUJO_BENCH_REAL_KEY || process.env.OPENAI_API_KEY,
} : undefined;
if (real) assert.ok(realModel.key, '--real needs FLUJO_BENCH_REAL_KEY or OPENAI_API_KEY');
// --seed-from <FLUJO data dir> --seed-model <model id>: use a model that is already
// configured there (for example a Claude subscription model). Only that model entry and
// the encryption key file are copied, still encrypted, into the throwaway data folder;
// FLUJO decrypts the credential in memory. Needs FLUJO's default (no password) encryption.
const seedFrom = option('seed-from', undefined);
const seedModelId = option('seed-model', undefined);
assert.ok(Boolean(seedFrom) === Boolean(seedModelId), '--seed-from and --seed-model go together');
assert.ok(!(seedFrom && real), 'Use either --real or --seed-from');
const realModelRun = real || Boolean(seedFrom);

// ---------------------------------------------------------------- compare mode
// node scripts/flow-turn-benchmark.mjs --compare <before.json> <after.json>
// prints cold and warm-median values of two --out files side by side.
const compareAt = args.indexOf('--compare');
if (compareAt !== -1) {
  const files = args.slice(compareAt + 1, compareAt + 3);
  assert.ok(files.length === 2 && files.every(file => !file.startsWith('--')), '--compare needs <before.json> <after.json>');
  const [before, after] = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
  const middle = values => {
    const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
    if (!sorted.length) return undefined;
    const half = Math.floor(sorted.length / 2);
    return Math.round((sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2) * 10) / 10;
  };
  const pick = (series, key) => {
    const value = run => key.startsWith('trace: ') ? run.trace?.[key.slice(7)] : run[key];
    const warmRuns = series.runs.slice(Math.min(4, series.runs.length - 1));
    return { cold: value(series.runs[0]), warm: middle(warmRuns.map(value)) };
  };
  const change = (old, value) => typeof old === 'number' && typeof value === 'number' && old > 0
    ? `${Math.round((value - old) / old * 100)}%` : '';
  const out = [`# ${before.label} -> ${after.label}`, '', 'Times in ms. Warm = median of runs 5 to the last.', ''];
  for (const series of after.series) {
    const old = before.series.find(item => item.mode === series.mode && item.scenario === series.scenario);
    if (!old) continue;
    out.push(`## ${series.mode} / ${series.scenario}`, '', '| step | cold before | cold after | warm before | warm after | warm change |', '|---|---:|---:|---:|---:|---:|');
    const keys = ['total', 'before_model', 'first_token_from_send', 'first_token_pass', 'tool_roundtrip', 'after_model', 'flujo_own'];
    const traceKeys = [...new Set([...old.runs, ...series.runs].flatMap(run => Object.keys(run.trace ?? {})))].map(key => `trace: ${key}`);
    for (const key of [...keys, ...traceKeys]) {
      const a = pick(old, key), b = pick(series, key);
      if ([a.cold, a.warm, b.cold, b.warm].every(value => value === undefined)) continue;
      out.push(`| ${key} | ${a.cold ?? '-'} | ${b.cold ?? '-'} | ${a.warm ?? '-'} | ${b.warm ?? '-'} | ${change(a.warm, b.warm)} |`);
    }
    out.push('');
  }
  console.log(out.join('\n'));
  process.exit(0);
}

await fs.access(path.join(application, '.next', 'BUILD_ID')).catch(() => {
  throw new Error(`No production build in ${application}. Run "npm run build" first or pass --app.`);
});

// ---------------------------------------------------------------- clock + log
const now = () => performance.now();
let current; // the run being measured: { sent, model: [], mcp: [] }
const say = message => process.stderr.write(`[bench] ${message}\n`);

// ---------------------------------------------------------------- stub model
const STUB_KEY = 'bench-stub-key';
const ANSWER_HEAD = 'Your order A-1 ships today';
const ANSWER_TAIL = ' from the Main Street store.';
function chunk(id, delta, finish = null, extra = {}) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'bench-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
}
const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
const stubModel = http.createServer(async (request, response) => {
  const arrival = now();
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'bench-model', object: 'model' }] }));
      return;
    }
    assert.ok(request.url?.endsWith('/chat/completions'), `Unexpected stub model path ${request.url}`);
    assert.equal(request.headers.authorization, `Bearer ${STUB_KEY}`);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const text = JSON.stringify(body.messages ?? []);
    // FLUJO may add its own context after the tool result, so look at the whole wire.
    const wantsTool = text.includes('[bench:tool]') && !(body.messages ?? []).some(message => message.role === 'tool');
    const tool = wantsTool ? (body.tools ?? []).find(item => item.function?.name?.includes('lookup_order')) : undefined;
    const call = { arrival, firstChunk: undefined, done: undefined, stream: body.stream === true, tool: Boolean(tool),
      tools: (body.tools ?? []).length, requestBytes: Buffer.concat(parts).length };
    current?.model.push(call);
    const id = `bench-${randomUUID()}`;
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (tool) {
        call.firstChunk = now();
        response.write(chunk(id, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_bench_1', type: 'function',
          function: { name: tool.function.name, arguments: '' } }] }));
        response.write(chunk(id, { tool_calls: [{ index: 0, function: { arguments: '{"order_id":"A-1"}' } }] }));
        response.write(chunk(id, {}, 'tool_calls', { usage }));
      } else {
        call.firstChunk = now();
        response.write(chunk(id, { role: 'assistant', content: ANSWER_HEAD }));
        if (tokenGapMs > 0) await delay(tokenGapMs);
        response.write(chunk(id, { content: ANSWER_TAIL }));
        response.write(chunk(id, {}, 'stop', { usage }));
      }
      response.end('data: [DONE]\n\n');
    } else {
      if (tokenGapMs > 0 && !tool) await delay(tokenGapMs);
      call.firstChunk = now();
      const message = tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_bench_1', type: 'function',
          function: { name: tool.function.name, arguments: '{"order_id":"A-1"}' } }] }
        : { role: 'assistant', content: ANSWER_HEAD + ANSWER_TAIL };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'bench-model',
        choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
    }
    call.done = now();
  } catch (error) {
    say(`stub model error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'bench stub model failed' } }));
  }
});

// ---------------------------------------------------------------- stub MCP server
const KNOWLEDGE_URI = 'bench://kb/faq';
const KNOWLEDGE = Array.from({ length: 40 }, (_, index) =>
  `Q${index + 1}: Opening hours of store ${index + 1}? A: 8:00 to 20:00, Monday to Saturday.`).join('\n');
const TOOLS = [
  { name: 'lookup_order', description: 'Look up an order by id.', inputSchema: { type: 'object',
    properties: { order_id: { type: 'string', description: 'Order id' } }, required: ['order_id'] } },
  { name: 'list_stores', description: 'List stores near a city.', inputSchema: { type: 'object',
    properties: { city: { type: 'string' } } } },
  { name: 'check_stock', description: 'Check stock for a product.', inputSchema: { type: 'object',
    properties: { sku: { type: 'string' } }, required: ['sku'] } },
];
const mcpSessions = new Map();
function newMcpSession() {
  const server = new Server({ name: 'bench-mcp', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: KNOWLEDGE_URI, name: 'Shop FAQ', mimeType: 'text/plain' }] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => ({
    contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: KNOWLEDGE }] }));
  server.setRequestHandler(CallToolRequestSchema, request => ({
    content: [{ type: 'text', text: JSON.stringify({ tool: request.params.name, order: 'A-1', status: 'ships today', store: 'Main Street' }) }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  return { server, transport };
}
let mcpCounts = {};
const stubMcp = http.createServer(async (request, response) => {
  const arrival = now();
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    const raw = Buffer.concat(parts);
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    const methods = (Array.isArray(body) ? body : body ? [body] : []).map(message => message.method ?? 'response');
    const label = request.method === 'POST' ? methods.join('+') : request.method;
    for (const method of methods) mcpCounts[method] = (mcpCounts[method] ?? 0) + 1;
    const entry = { method: label, arrival, replied: undefined };
    if (request.method === 'POST') current?.mcp.push(entry);
    response.once('finish', () => { entry.replied = now(); });
    let session = mcpSessions.get(request.headers['mcp-session-id']);
    if (!session && body?.method === 'initialize') {
      session = newMcpSession();
      await session.server.connect(session.transport);
    }
    if (!session) {
      response.writeHead(request.method === 'GET' ? 405 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      return;
    }
    await session.transport.handleRequest(request, response, body);
    if (session.transport.sessionId) mcpSessions.set(session.transport.sessionId, session);
  } catch (error) {
    say(`stub MCP error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

// ---------------------------------------------------------------- seeded model (optional)
async function seedModel() {
  const source = path.join(path.resolve(seedFrom), 'workspaces');
  const target = path.join(data, 'workspaces');
  const encryption = JSON.parse(await fs.readFile(path.join(source, 'default-workspace', 'db', 'encryption_key.json'), 'utf8'));
  assert.equal(encryption.encryption_type, 'default', 'Only a data folder with default (no password) encryption can be seeded');
  const models = JSON.parse(await fs.readFile(path.join(source, 'default-workspace', 'db', 'models.json'), 'utf8'));
  const model = models.find(entry => entry.id === seedModelId);
  assert.ok(model, `Model ${seedModelId} not found in ${seedFrom}`);
  await fs.mkdir(path.join(target, 'default-workspace', 'db'), { recursive: true });
  await fs.copyFile(path.join(source, '.workspace-layout.json'), path.join(target, '.workspace-layout.json')).catch(() => undefined);
  await fs.copyFile(path.join(source, 'default-workspace', 'db', 'encryption_key.json'), path.join(target, 'default-workspace', 'db', 'encryption_key.json'));
  // The entry is copied as stored: its credential stays encrypted.
  await fs.writeFile(path.join(target, 'default-workspace', 'db', 'models.json'), JSON.stringify([model], null, 2));
  say(`Seeded model ${model.id} (${model.name}, ${model.adapter})`);
  return { id: model.id, name: model.name, adapter: model.adapter };
}

// ---------------------------------------------------------------- FLUJO process
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-turn-bench-'));
const runtimeApp = path.join(root, 'application');
const LINKED = ['.next', 'node_modules', 'public', 'scripts', 'bin'];
const data = path.join(root, 'data');
const traceFile = path.join(root, 'turn-trace.jsonl');
const fsStatsBase = path.join(root, 'fs-stats');
const password = randomBytes(24).toString('hex');
let operator, child, childClosed, base, serverLog = '';

function safeEnvironment() {
  const safe = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?|programdata|number_of_processors|processor_architecture)$/i.test(name) && value) safe[name] = value;
  }
  return { ...safe, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home', 'roaming'), LOCALAPPDATA: path.join(root, 'home', 'local'),
    XDG_CONFIG_HOME: path.join(root, 'home', 'config'), XDG_CACHE_HOME: path.join(root, 'home', 'cache'),
    TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp') };
}

async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(endpoint, base);
  url.searchParams.set('workspace', 'default-workspace');
  const response = await fetch(url, { method,
    headers: { authorization: `Bearer ${operator.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  assert.ok(response.ok, `API ${method} ${endpoint} returned ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serverLog = '';
  const started = now();
  // The launcher only runs as the main module under its real (unlinked) path.
  child = spawn(process.execPath, [path.join(application, 'scripts', 'launch-next.mjs'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: runtimeApp, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...safeEnvironment(), ...(ownerAuth ? operator.env : {}), FLUJO_DATA_DIR: data, FLUJO_RUNTIME_ENV_DIR: data, FLUJO_APP_ROOT: runtimeApp,
      FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_TELEMETRY_URL: `${base}/disabled-telemetry`, FLUJO_CODEX_AUTO_UPDATE: '0',
      FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await freePort()),
      FLUJO_TURN_TRACE_FILE: traceFile,
      ...(fsProbe ? { FLUJO_BENCH_FS_STATS: fsStatsBase } : {}),
      NODE_OPTIONS: [extraNodeOptions, profileDir ? '--inspect=127.0.0.1:0' : '',
        // NODE_OPTIONS treats backslashes inside quotes as escapes; use forward slashes.
        fsProbe ? `--require "${path.join(repo, 'scripts', 'flow-turn-benchmark-fs-probe.cjs').replaceAll('\\', '/')}"` : ''].filter(Boolean).join(' ') },
  });
  childClosed = new Promise(resolve => child.once('close', resolve));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-60_000); });
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`FLUJO exited during startup:\n${serverLog.slice(-4000)}`);
    try {
      const response = await fetch(new URL('/api/encryption/secure', base), { method: 'POST',
        headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(3000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`FLUJO did not become ready:\n${serverLog.slice(-4000)}`);
    await delay(100);
  }
  return now() - started;
}

async function stopServer() {
  if (!child) return;
  const owned = child;
  if (owned.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', resolve); killer.once('exit', resolve);
      });
    } else {
      try { process.kill(-owned.pid, 'SIGTERM'); } catch { /* gone */ }
      if (!await Promise.race([childClosed.then(() => true), delay(5000).then(() => false)])) {
        try { process.kill(-owned.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  }
  await Promise.race([childClosed, delay(10_000)]);
  child = undefined;
  // Stub MCP sessions belonged to the old process.
  for (const session of mcpSessions.values()) await session.transport.close().catch(() => undefined);
  mcpSessions.clear();
}

// ---------------------------------------------------------------- CPU profile (optional)
async function inspectorSession(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}
async function startProfiles() {
  const urls = [...new Set([...serverLog.matchAll(/Debugger listening on (ws:\/\/\S+)/g)].map(match => match[1]))];
  const sessions = [];
  for (const url of urls) {
    try {
      const session = await inspectorSession(url);
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: 200 });
      await session.send('Profiler.start');
      sessions.push(session);
    } catch { /* a process that already exited */ }
  }
  return sessions;
}
async function stopProfiles(sessions, name) {
  await fs.mkdir(profileDir, { recursive: true });
  let index = 0;
  for (const session of sessions) {
    const result = await session.send('Profiler.stop');
    session.close();
    const profile = result.result?.profile;
    if (!profile || profile.samples.length < 50) continue;
    const file = path.join(profileDir, `${name}-${++index}.cpuprofile`);
    await fs.writeFile(file, JSON.stringify(profile));
    say(`CPU profile: ${file} (${profile.samples.length} samples)`);
  }
}

// ---------------------------------------------------------------- file-system probe (optional)
async function fsSnapshot() {
  const merged = { stats: {}, sites: {} };
  const directory = path.dirname(fsStatsBase);
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith(`${path.basename(fsStatsBase)}.`)) continue;
    const parsed = await fs.readFile(path.join(directory, name), 'utf8').then(JSON.parse, () => undefined);
    for (const group of ['stats', 'sites']) for (const [key, value] of Object.entries(parsed?.[group] ?? {})) {
      const entry = merged[group][key] ??= { count: 0, ms: 0 };
      entry.count += value.count; entry.ms += value.ms;
    }
  }
  return merged;
}
function fsDiff(before, after, group, top = 12) {
  return Object.entries(after[group]).map(([key, value]) => {
    const old = before[group][key] ?? { count: 0, ms: 0 };
    return [key, { count: value.count - old.count, ms: Math.round((value.ms - old.ms) * 10) / 10 }];
  }).filter(([, value]) => value.count > 0).sort((a, b) => b[1].ms - a[1].ms).slice(0, top);
}

// ---------------------------------------------------------------- in-server step timers
// A server that supports FLUJO_TURN_TRACE_FILE appends one line per request once
// the request and its streamed run have finished, which can be just after the
// client saw the end. Wait briefly for that line; a build without the timers
// writes none, so stop waiting once that is known.
let traceLinesSeen = 0;
let traceSupported;
async function readTurnTrace() {
  const deadline = Date.now() + (traceSupported === false ? 0 : 3_000);
  for (;;) {
    const lines = (await fs.readFile(traceFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (lines.length > traceLinesSeen || Date.now() >= deadline) {
      const fresh = lines.slice(traceLinesSeen);
      traceLinesSeen = lines.length;
      if (fresh.length) traceSupported = true;
      else traceSupported ??= false;
      return fresh.map(line => JSON.parse(line));
    }
    await delay(20);
  }
}

// ---------------------------------------------------------------- one turn
const FLOW_NAME = 'VoiceBench';
// 'continue' keeps one conversation across the runs of a series, as a stateful
// voice client does: each turn sends only its new message (appendMessages).
let continuedConversation;
async function turn(mode, scenario) {
  const marker = scenario === 'tool' ? '[bench:tool] Where is my order A-1?' : 'When does store 3 open?';
  const metadata = scenario === 'continue'
    ? { flujo: 'true', ...(continuedConversation ? { conversationId: continuedConversation, appendMessages: 'true' } : {}) }
    : undefined;
  const record = { sent: 0, model: [], mcp: [], headers: undefined, firstContent: undefined, end: undefined };
  current = record;
  const fsBefore = fsProbe ? await fsSnapshot() : undefined;
  record.sent = now();
  const response = await fetch(new URL('/v1/chat/completions', base), {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: `flow-${FLOW_NAME}`, stream: mode === 'stream',
      messages: [{ id: randomUUID(), role: 'user', content: marker }], ...(metadata ? { metadata } : {}) }),
  });
  record.headers = now();
  let content = '';
  if (mode === 'stream') {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const line = event.split('\n').find(item => item.startsWith('data: '));
        if (!line || line === 'data: [DONE]') continue;
        const parsed = JSON.parse(line.slice(6));
        if (parsed.error) throw new Error(`Stream error: ${JSON.stringify(parsed.error)}`);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) { record.firstContent ??= now(); content += delta; }
        record.conversationId ??= parsed.choices?.[0]?.delta?.conversation?.conversationId;
      }
    }
  } else {
    const text = await response.text();
    record.raw = text.slice(0, 3000);
    const parsed = JSON.parse(text);
    assert.ok(response.ok, `Turn failed with ${response.status}: ${text.slice(0, 500)}`);
    content = parsed.choices?.[0]?.message?.content ?? '';
    record.conversationId = parsed.conversation_id;
  }
  if (scenario === 'continue') continuedConversation ??= record.conversationId;
  record.end = now();
  current = undefined;
  assert.ok(response.ok, `Turn failed with ${response.status}`);
  const diagnostics = () => JSON.stringify({ model: record.model.map(call => ({ tool: call.tool, tools: call.tools })),
    mcp: record.mcp.map(entry => entry.method), raw: record.raw?.slice(0, 1500) });
  if (!realModelRun) assert.ok(content.includes('ships today'), `Unexpected answer: ${content.slice(0, 200)} ${diagnostics()}`);
  else assert.ok(content.length > 0, 'Real model returned no text');
  record.contentChars = content.length;
  if (fsBefore) {
    await delay(400); // let background writes after the answer finish and the probe flush
    const fsAfter = await fsSnapshot();
    record.fs = { ops: fsDiff(fsBefore, fsAfter, 'stats', 20), sites: fsDiff(fsBefore, fsAfter, 'sites', 25) };
  }
  record.trace = await readTurnTrace();
  return record;
}

function spans(record) {
  const ms = value => value === undefined ? undefined : Math.round(value * 10) / 10;
  const rel = value => value === undefined ? undefined : value - record.sent;
  const first = record.model[0];
  const last = record.model.at(-1);
  const answerCall = record.model.find(call => !call.tool) ?? last;
  const toolCall = record.mcp.find(entry => entry.method === 'tools/call');
  const beforeModel = record.mcp.filter(entry => first && entry.arrival < first.arrival);
  const result = {
    total: ms(record.end - record.sent),
    before_model: ms(first && first.arrival - record.sent),
    mcp_before_model: ms(beforeModel.reduce((sum, entry) => sum + ((entry.replied ?? entry.arrival) - entry.arrival), 0)),
    mcp_calls_before_model: beforeModel.map(entry => entry.method).join(' ') || '-',
    model_stub_time: ms(record.model.reduce((sum, call) => sum + (call.done - call.arrival), 0)),
    first_token_pass: ms(record.firstContent !== undefined && answerCall ? record.firstContent - answerCall.firstChunk : undefined),
    first_token_from_send: ms(rel(record.firstContent)),
    tool_roundtrip: ms(record.model.length > 1 ? record.model[1].arrival - record.model[0].done : undefined),
    tool_mcp_time: ms(toolCall ? (toolCall.replied ?? toolCall.arrival) - toolCall.arrival : undefined),
    after_model: ms(last && record.end - last.done),
    model_calls: record.model.length,
    mcp_calls: record.mcp.length,
  };
  const mcpTime = record.mcp.reduce((sum, entry) => sum + ((entry.replied ?? entry.arrival) - entry.arrival), 0);
  result.flujo_own = ms(record.end - record.sent - mcpTime - record.model.reduce((sum, call) => sum + (call.done - call.arrival), 0));
  if (record.trace?.length) {
    result.trace = summarizeTrace(record.trace);
    result.marks = Object.fromEntries(record.trace.flatMap(line => line.marks ?? []).reverse().map(mark => [mark.name, mark.at]));
  }
  if (record.fs) result.fs = record.fs;
  return result;
}

function summarizeTrace(lines) {
  // Each line: { conversationId, spans: [{ name, start, end }] } relative to request start.
  const totals = {};
  for (const line of lines) for (const span of line.spans ?? []) {
    totals[span.name] = Math.round(((totals[span.name] ?? 0) + (span.end - span.start)) * 10) / 10;
  }
  return totals;
}

const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
};

// ---------------------------------------------------------------- main
const results = { schemaVersion: 1, label, application, startedUtc: new Date().toISOString(),
  node: process.version, platform: `${process.platform} ${os.release()} ${os.cpus().length} threads ${Math.round(os.totalmem() / 2 ** 30)} GB`,
  buildId: (await fs.readFile(path.join(application, '.next', 'BUILD_ID'), 'utf8')).trim(),
  model: real ? `real ${realModel.name}` : seedFrom ? `configured model ${seedModelId}` : `stub (token gap ${tokenGapMs} ms)`, runs, series: [] };
try {
  for (const name of ['application', 'data', 'home', 'temp']) await fs.mkdir(path.join(root, name), { recursive: true });
  for (const name of ['roaming', 'local', 'config', 'cache']) await fs.mkdir(path.join(root, 'home', name));
  for (const name of LINKED) {
    await fs.symlink(path.join(application, name), path.join(runtimeApp, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  // The shipped server refuses linked MCP server folders; copy only the built parts.
  await fs.cp(path.join(application, 'mcp-servers'), path.join(runtimeApp, 'mcp-servers'), { recursive: true,
    filter: source => !source.split(path.sep).includes('node_modules') });
  for (const name of ['package.json', 'next.config.mjs']) await fs.copyFile(path.join(application, name), path.join(runtimeApp, name));
  operator = await createSmokeOperator({ scopes: ['control:admin', 'mcp:access', 'secrets:read', 'openai:read', 'openai:execute'], ttlMs: 6 * 3600_000 });
  const modelPort = await listen(stubModel);
  const mcpPort = await listen(stubMcp);

  let seededModel;
  if (seedFrom) seededModel = await seedModel();
  say('Starting FLUJO for setup...');
  results.setupStartupMs = Math.round(await startServer());
  if (!seededModel) {
    assert.equal((await api('/api/encryption/secure', { action: 'initialize', password })).success, true);
    assert.equal((await api('/api/encryption/secure', { action: 'authenticate', password })).success, true);
  }
  await api('/api/storage', { key: 'speech_settings', value: { onboarding: { completed: true }, telemetry: { enabled: false } } });
  for (const config of await api('/api/mcp/servers')) {
    if (config.name !== 'bench') await api(`/api/mcp/servers/${encodeURIComponent(config.name)}`, { disabled: true }, 'PUT');
  }
  await api('/api/mcp/servers', { name: 'bench', transport: 'streamable', serverUrl: `http://127.0.0.1:${mcpPort}/mcp`, disabled: false });
  const modelId = seededModel?.id ?? 'bench-model';
  if (!seededModel) await api('/api/model', real
    ? { id: modelId, name: realModel.name, provider: 'openai', adapter: 'openai', ApiKey: realModel.key, baseUrl: realModel.baseUrl }
    : { id: modelId, name: 'bench-model', provider: 'openai', adapter: 'openai', ApiKey: STUB_KEY, baseUrl: `http://127.0.0.1:${modelPort}/v1` });
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
  const nodes = [
    node('start', 'start', { promptTemplate: 'You are the voice assistant of a small shop. Keep answers short.' }),
    node('process', 'process', { boundModel: modelId, inputMode: 'full-history', allowQuestion: false,
      promptTemplate: 'Answer the caller in one or two sentences. Use a tool when you need order data.\n'
        + `Shop knowledge:\n\${resource:bench__${KNOWLEDGE_URI}}` }),
    node('tools', 'mcp', { boundServer: 'bench', enabledTools: TOOLS.map(tool => tool.name), enabledResources: 'all' }),
    node('finish', 'finish'),
  ];
  const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  await api('/api/flow', { id: 'voice-bench-flow', name: FLOW_NAME, nodes, updatedAt: Date.now(), edges: [
    edge(nodes[0], nodes[1]), edge(nodes[1], nodes[3]),
    { id: 'tools-process', source: 'tools', target: 'process', type: 'custom', data: { edgeType: 'mcp' } },
  ] });
  await stopServer();

  for (const mode of modes) for (const scenario of scenarios) {
    say(`Fresh FLUJO process for ${mode}/${scenario}...`);
    continuedConversation = undefined;
    const startupMs = await startServer();
    if (!seedFrom) assert.equal((await api('/api/encryption/secure', { action: 'authenticate', password })).success, true);
    const series = { mode, scenario, startupMs: Math.round(startupMs), runs: [] };
    let profiles;
    for (let index = 1; index <= runs; index++) {
      mcpCounts = {};
      if (profileDir && index === 2) profiles = await startProfiles();
      const record = await turn(mode, scenario);
      const result = { run: index, ...spans(record), mcpMethods: mcpCounts };
      series.runs.push(result);
      say(`${mode}/${scenario} run ${index}: total ${result.total} ms, before model ${result.before_model} ms, after model ${result.after_model} ms`);
    }
    if (profiles) await stopProfiles(profiles, `${mode}-${scenario}`);
    results.series.push(series);
    await stopServer();
  }
} catch (error) {
  say(`Benchmark failed: ${error.stack ?? error}`);
  if (serverLog) say(`Server log tail:\n${serverLog.slice(-6000)}`);
  process.exitCode = 1;
} finally {
  await stopServer().catch(() => undefined);
  stubModel.close(); stubMcp.close();
  await operator?.restore().catch(() => undefined);
  // Remove the links first so cleanup can never reach the linked build or dependencies.
  if (!keep) for (const name of LINKED) await fs.rmdir(path.join(runtimeApp, name)).catch(() => undefined);
  if (!keep) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => say(`Cleanup left ${root}: ${error.message}`));
  else say(`Kept ${root}`);
}

// ---------------------------------------------------------------- report
const KEYS = ['total', 'before_model', 'mcp_before_model', 'first_token_from_send', 'first_token_pass', 'tool_roundtrip', 'after_model', 'flujo_own'];
const lines = [`# Flow turn benchmark: ${label}`, '',
  `${results.platform}, Node ${results.node}, build ${results.buildId}, model ${results.model}. Times in ms.`, ''];
for (const series of results.series) {
  const cold = series.runs[0];
  const warm = series.runs.at(-1);
  const warmRuns = series.runs.slice(Math.min(4, series.runs.length - 1));
  lines.push(`## ${series.mode} / ${series.scenario} (server ready in ${series.startupMs} ms)`, '',
    `| step | cold (run 1) | warm (run ${warm.run}) | warm median (runs ${warmRuns[0].run}-${warm.run}) |`, '|---|---:|---:|---:|');
  for (const key of KEYS) {
    if (cold[key] === undefined && warm[key] === undefined) continue;
    lines.push(`| ${key} | ${cold[key] ?? '-'} | ${warm[key] ?? '-'} | ${median(warmRuns.map(run => run[key])) ?? '-'} |`);
  }
  lines.push(`| MCP calls before model | ${cold.mcp_calls_before_model} | ${warm.mcp_calls_before_model} | |`);
  const traceKeys = [...new Set(series.runs.flatMap(run => Object.keys(run.trace ?? {})))];
  for (const key of traceKeys) {
    lines.push(`| trace: ${key} | ${cold.trace?.[key] ?? '-'} | ${warm.trace?.[key] ?? '-'} | ${median(warmRuns.map(run => run.trace?.[key])) ?? '-'} |`);
  }
  if (warm.marks) {
    lines.push('', `Timeline of warm run ${warm.run} (ms after the request was sent to the server):`, '',
      Object.entries(warm.marks).sort((a, b) => a[1] - b[1]).map(([name, at]) => `${name} ${at}`).join(' -> '));
  }
  lines.push('');
  if (warm.fs) {
    lines.push(`File-system calls in warm run ${warm.run} (count, summed ms; async calls overlap):`, '');
    for (const [key, value] of warm.fs.ops) lines.push(`- ${key}: ${value.count}x, ${value.ms} ms`);
    lines.push('', 'Busiest call sites:', '');
    for (const [key, value] of warm.fs.sites) lines.push(`- ${value.count}x ${value.ms} ms ${key.slice(0, 260)}`);
    lines.push('');
  }
}
const report = lines.join('\n');
console.log(report);
if (outFile) {
  await fs.writeFile(path.resolve(outFile), JSON.stringify({ ...results, report }, null, 2));
  say(`Wrote ${path.resolve(outFile)}`);
}

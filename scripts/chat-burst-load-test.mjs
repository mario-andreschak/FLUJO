#!/usr/bin/env node
/**
 * Parallel chat load test (issue #757).
 *
 * Fires N parallel `POST /v1/chat/completions` requests with `model:
 * "flow-<name>"` at FLUJO and reports how long each waited before FLUJO's first
 * model call, plus first-token and total times and every HTTP status. Each
 * request hides a unique code in filler text and asks for it back, so every
 * answer is checked.
 *
 * By default it starts its own production FLUJO (build first with
 * `npm run build`) on a free port with a throwaway data folder and an
 * OpenAI-compatible stub model on loopback that answers at once (or after
 * --stub-delay). The stub records when FLUJO reached it, so the time before
 * that is FLUJO's own. Nothing outside this machine is contacted.
 *
 *   node scripts/chat-burst-load-test.mjs [--parallel 300] [--rounds 1]
 *     [--mode stream|json] [--filler-tokens 1000] [--stub-delay 0]
 *     [--app <dir with .next>] [--out <file.json>] [--keep] [--no-warmup]
 *     [--cold-start]
 *
 * --cold-start sets FLUJO up, stops it and starts it again on the same data,
 * then sends the burst the moment the new process accepts connections, while
 * it is still starting. The stub model is starting too: for three seconds
 * after FLUJO first reaches it, it answers 503 with no body, as vLLM did in
 * issue #757.
 *
 * Against its own server the run passes only when every request answers
 * correctly with HTTP 200 (nothing refused, nothing lost) and FLUJO reaches
 * the model quickly enough (PASS_RULES below). Otherwise the exit code is 2.
 *
 * Against an already running FLUJO (for example one that uses a real vLLM
 * server), name a flow that already exists there. No stub is started and no
 * data is created; the token, if the server needs one, comes from the
 * FLUJO_LOADTEST_TOKEN environment variable:
 *
 *   node scripts/chat-burst-load-test.mjs --url http://127.0.0.1:4200
 *     --flow plain [--workspace default-workspace] [--trace-file <file>]
 *
 * --trace-file reads the server's FLUJO_TURN_TRACE_FILE (set it when starting
 * that server) to time the first model call and FLUJO's own waits inside it.
 * The started server always writes one.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// ---------------------------------------------------------------- arguments
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), `--${name} needs a value`);
  return value;
}
const flag = name => args.includes(`--${name}`);
function count(name, fallback, min, max) {
  const value = Number(option(name, String(fallback)));
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `--${name} must be a whole number from ${min} to ${max}`);
  return value;
}
const parallel = count('parallel', 300, 1, 5000);
const rounds = count('rounds', 1, 1, 100);
const fillerTokens = count('filler-tokens', 1000, 0, 2_000_000);
const stubDelayMs = count('stub-delay', 0, 0, 600_000);
const requestTimeoutMs = count('timeout', 900_000, 1000, 3_600_000);
const mode = option('mode', 'stream');
assert.ok(['stream', 'json'].includes(mode), '--mode must be stream or json');
const targetUrl = option('url', undefined);
const existingFlow = option('flow', undefined);
assert.ok(!targetUrl === !existingFlow, '--url and --flow go together: a running FLUJO is tested with one of its own flows');
const workspace = option('workspace', 'default-workspace');
const traceFileOption = option('trace-file', undefined);
const application = path.resolve(option('app', repo));
const outFile = option('out', undefined);
const keep = flag('keep');
const coldStart = flag('cold-start');
assert.ok(!coldStart || !targetUrl, '--cold-start restarts the FLUJO it started itself; it cannot be used with --url');
const warmup = !flag('no-warmup') && !coldStart;
const say = message => process.stderr.write(`[burst] ${message}\n`);
const now = () => performance.now();

// ---------------------------------------------------------------- stub model
const STUB_KEY = 'burst-stub-key';
const arrivals = new Map(); // marker -> first time FLUJO reached the stub
const MARKER = /burst-[0-9a-f]{8}-\d+-\d+/;
// --cold-start: the model server is starting too. For MODEL_START_MS after FLUJO first reaches it, it
// answers 503 with no body, as vLLM did in #757.
const MODEL_START_MS = 3000;
let modelStarting = false;
let modelReadyAt;
let modelUnavailableAnswers = 0;
function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'burst', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'burst-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const stubModel = http.createServer(async (request, response) => {
  const arrival = now();
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'burst-model', object: 'model' }] }));
      return;
    }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const marker = JSON.stringify(body.messages ?? []).match(MARKER)?.[0] ?? 'unknown';
    if (!arrivals.has(marker)) arrivals.set(marker, arrival);
    if (modelStarting) modelReadyAt ??= arrival + MODEL_START_MS;
    if (modelStarting && arrival < modelReadyAt) {
      modelUnavailableAnswers++;
      response.writeHead(503);
      response.end();
      return;
    }
    if (stubDelayMs) await delay(stubDelayMs);
    const content = `The code is ${marker}.`;
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(chunk({ role: 'assistant', content }));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'burst', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'burst-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  } catch (error) {
    say(`stub model error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'stub model failed' } }));
  }
});
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

// ---------------------------------------------------------------- own FLUJO server
const root = targetUrl ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-chat-burst-'));
const runtimeApp = root && path.join(root, 'application');
const LINKED = ['.next', 'node_modules', 'public', 'scripts', 'bin'];
const traceFile = traceFileOption ? path.resolve(traceFileOption) : root && path.join(root, 'turn-trace.jsonl');
let base = targetUrl;
let token = process.env.FLUJO_LOADTEST_TOKEN?.trim() || undefined;
let operator, child, childClosed, serverLog = '';

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
function authorization() {
  return token ? { authorization: `Bearer ${token}` } : {};
}
async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(endpoint, base);
  url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { method, signal: AbortSignal.timeout(60_000),
    headers: { ...authorization(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.ok(response.ok, `API ${method} ${endpoint} returned ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}
let serverPort, sandboxPort;
async function startServer() {
  await fs.access(path.join(application, '.next', 'BUILD_ID')).catch(() => {
    throw new Error(`No production build in ${application}. Run "npm run build" first or pass --app.`);
  });
  for (const name of ['application', 'data', 'home', 'temp']) await fs.mkdir(path.join(root, name), { recursive: true });
  for (const name of ['roaming', 'local', 'config', 'cache']) await fs.mkdir(path.join(root, 'home', name));
  for (const name of LINKED) {
    await fs.symlink(path.join(application, name), path.join(runtimeApp, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  // The shipped server refuses linked MCP server folders; copy only the built parts.
  await fs.cp(path.join(application, 'mcp-servers'), path.join(runtimeApp, 'mcp-servers'), { recursive: true,
    filter: source => !source.split(path.sep).includes('node_modules') });
  for (const name of ['package.json', 'next.config.mjs']) await fs.copyFile(path.join(application, name), path.join(runtimeApp, name));
  const { createSmokeOperator } = await import('./smoke-bundled-operator.mjs');
  operator = await createSmokeOperator({ scopes: ['control:admin', 'mcp:access', 'secrets:read', 'openai:read', 'openai:execute'], ttlMs: 6 * 3600_000 });
  token = operator.token;
  serverPort = await freePort();
  sandboxPort = await freePort();
  base = `http://127.0.0.1:${serverPort}`;
  await launchServer();
  await waitUntilReady();
  await setUpData();
}
function launchServer() {
  const data = path.join(root, 'data');
  child = spawn(process.execPath, [path.join(application, 'scripts', 'launch-next.mjs'), 'start', '-p', String(serverPort), '-H', '127.0.0.1'], {
    cwd: runtimeApp, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...safeEnvironment(), ...operator.env, FLUJO_DATA_DIR: data, FLUJO_RUNTIME_ENV_DIR: data, FLUJO_APP_ROOT: runtimeApp,
      FLUJO_BASE_URL: base, FLUJO_PORT: String(serverPort), FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_TELEMETRY_URL: `${base}/disabled-telemetry`, FLUJO_CODEX_AUTO_UPDATE: '0',
      FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort),
      FLUJO_TURN_TRACE_FILE: traceFile },
  });
  childClosed = new Promise(resolve => child.once('close', resolve));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-60_000); });
}
async function waitUntilReady() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`FLUJO exited during startup:\n${serverLog.slice(-4000)}`);
    try {
      const response = await fetch(new URL('/api/encryption/secure', base), { method: 'POST',
        headers: { ...authorization(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(3000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`FLUJO did not become ready:\n${serverLog.slice(-4000)}`);
    await delay(100);
  }
}
/** Resolves as soon as the new process accepts a connection; nothing is asked of it yet. */
async function waitUntilListening() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`FLUJO exited during startup:\n${serverLog.slice(-4000)}`);
    const accepted = await new Promise(resolve => {
      const socket = net.connect(serverPort, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (accepted) return;
    if (Date.now() > deadline) throw new Error(`FLUJO did not start listening:\n${serverLog.slice(-4000)}`);
    await delay(20);
  }
}
async function setUpData() {
  // The default key setup, as a new desktop install makes it: a restarted FLUJO is unlocked at once.
  assert.equal((await api('/api/encryption/secure', { action: 'initialize_default' })).success, true);
  await api('/api/storage', { key: 'speech_settings', value: { onboarding: { completed: true }, telemetry: { enabled: false } } });
  // A plain flow needs no MCP server; idle bundled servers would only add noise.
  for (const config of await api('/api/mcp/servers')) {
    await api(`/api/mcp/servers/${encodeURIComponent(config.name)}`, { disabled: true }, 'PUT');
  }
  const modelPort = await listen(stubModel);
  await api('/api/model', { id: 'burst-model', name: 'burst-model', provider: 'openai', adapter: 'openai',
    ApiKey: STUB_KEY, baseUrl: `http://127.0.0.1:${modelPort}/v1` });
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'burst-model' }), node('finish', 'finish')];
  const edge = (source, target) => ({ id: `${source.id}-${target.id}`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  await api('/api/flow', { id: 'burst-plain-flow', name: 'BurstPlain', nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])],
    updatedAt: Date.now() });
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
}

// ---------------------------------------------------------------- one request
const flowName = existingFlow ?? 'BurstPlain';
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(fillerTokens / 10));
/**
 * Like the OpenAI SDK, try again when a connection is refused before it was
 * made: the server never saw that request. Windows queues only about 200
 * connections a busy process has not accepted yet, which a burst can exceed in
 * the first seconds after a restart. Retries are counted in the report.
 */
const CONNECTION_RETRY_DELAYS_MS = [500, 1000];
async function connect(url, init, record) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, init); } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' || attempt >= CONNECTION_RETRY_DELAYS_MS.length) throw error;
      record.connectionRetries++;
      await delay(CONNECTION_RETRY_DELAYS_MS[attempt]);
    }
  }
}
async function chat(marker) {
  const record = { marker, sent: now(), status: 0, firstContent: undefined, end: undefined, correct: false, error: undefined,
    connectionRetries: 0 };
  const body = JSON.stringify({ model: `flow-${flowName}`, stream: mode === 'stream', messages: [{ role: 'user',
    content: `Somewhere in this text is a code. ${filler.slice(0, filler.length / 2)} The code is ${marker}. `
      + `${filler.slice(filler.length / 2)} Reply with the code only.` }] });
  try {
    const url = new URL('/v1/chat/completions', base);
    url.searchParams.set('workspace', workspace);
    const response = await connect(url, { method: 'POST', signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { ...authorization(), 'content-type': 'application/json' }, body }, record);
    record.status = response.status;
    let content = '';
    if (!response.ok) {
      const text = await response.text();
      try { record.error = JSON.parse(text).error?.code ?? JSON.parse(text).error?.message; } catch { record.error = text.slice(0, 120); }
    } else if (mode === 'stream') {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const line = buffer.slice(0, index).split('\n').find(item => item.startsWith('data: '));
          buffer = buffer.slice(index + 2);
          if (!line || line === 'data: [DONE]') continue;
          const parsed = JSON.parse(line.slice(6));
          if (parsed.error) record.error = parsed.error.code ?? parsed.error.message;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) { record.firstContent ??= now(); content += delta; }
        }
      }
    } else {
      const parsed = await response.json();
      content = parsed.choices?.[0]?.message?.content ?? '';
      record.firstContent = now();
    }
    record.correct = content.includes(marker);
  } catch (error) {
    const cause = error.cause?.code ?? error.cause?.name;
    record.error = error.name === 'TimeoutError' ? 'client_timeout' : `${error.message.slice(0, 120)}${cause ? ` (${cause})` : ''}`;
  }
  record.end = now();
  return record;
}

// ---------------------------------------------------------------- traces
let traceLines = 0;
async function newTraces(expected) {
  if (!traceFile) return [];
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = (await fs.readFile(traceFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
    if (lines.length - traceLines >= expected || Date.now() > deadline) {
      const fresh = lines.slice(traceLines).map(line => JSON.parse(line)).filter(line => line.label === 'chat.completions');
      traceLines = lines.length;
      return fresh;
    }
    await delay(200);
  }
}
async function skipExistingTraces() {
  if (traceFile) traceLines = (await fs.readFile(traceFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).length;
}

// ---------------------------------------------------------------- report helpers
function percentile(values, fraction) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
}
const stats = values => ({ n: values.filter(Number.isFinite).length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) });
function traceStats(traces) {
  const first = (trace, name, kind) => kind === 'mark'
    ? trace.marks?.find(mark => mark.name === name)?.at
    : trace.spans?.find(span => span.name === name)?.start;
  const total = (trace, name) => {
    const spans = trace.spans?.filter(span => span.name === name) ?? [];
    return spans.length ? spans.reduce((sum, span) => sum + span.end - span.start, 0) : undefined;
  };
  return {
    'first model call (server)': stats(traces.map(trace => first(trace, 'model.generate', 'span'))),
    'request admitted': stats(traces.map(trace => first(trace, 'route.admitted', 'mark'))),
    'waiting for a run slot': stats(traces.map(trace => total(trace, 'service.runAdmission'))),
    'waiting for a stream slot': stats(traces.map(trace => total(trace, 'service.streamAdmission'))),
    'run started': stats(traces.map(trace => first(trace, 'runFlow.admitted', 'mark'))),
    'model catalog registration': stats(traces.map(trace => total(trace, 'lock.catalogAdmit'))),
    'saving conversation state': stats(traces.map(trace => total(trace, 'persist.snapshot'))),
  };
}

// ---------------------------------------------------------------- pass rules
/**
 * Fixed pass rules from issue #757. FLUJO answered all 300 requests there, but
 * waited 230 s (p50) / 417 s (p95) before its first model call, while the model
 * itself answered 400 parallel requests in 26 s (p95). Every request must be
 * answered correctly and none may be refused. The 95th percentile of FLUJO's
 * own time before the first model call must stay under `firstModelCallP95Ms`,
 * or under `coldStartFirstModelCallP95Ms` for a burst that arrives while FLUJO
 * and its model server are still starting. A 300 burst measured about 15 s and
 * 30 s on a shared Windows PC (docs/performance/chat-burst-load-test.md). The
 * time rule needs the stub, so it only applies when this script started its own FLUJO.
 */
const PASS_RULES = Object.freeze({ firstModelCallP95Ms: 45_000, coldStartFirstModelCallP95Ms: 75_000 });
function ruleFailures(burst, ownServer) {
  const failures = [];
  if (burst.correct !== parallel) failures.push(`${parallel - burst.correct} of ${parallel} requests got no correct answer`);
  const refused = Object.entries(burst.statuses).filter(([status]) => status !== '200');
  if (refused.length) failures.push(`refused or failed requests: ${refused.map(([status, n]) => `${n} x HTTP ${status}`).join(', ')}`);
  if (Object.keys(burst.errors).length) failures.push(`errors: ${JSON.stringify(burst.errors)}`);
  const firstCall = burst.firstModelCallMs.p95;
  const bound = coldStart && burst.round === 1 ? PASS_RULES.coldStartFirstModelCallP95Ms : PASS_RULES.firstModelCallP95Ms;
  if (ownServer && !(firstCall <= bound)) failures.push(`first model call p95 ${firstCall ?? 'missing'} ms is over ${bound} ms`);
  return failures;
}

// ---------------------------------------------------------------- main
const results = { schemaVersion: 1, startedUtc: new Date().toISOString(), node: process.version,
  platform: `${process.platform} ${os.release()} ${os.cpus().length} threads ${Math.round(os.totalmem() / 2 ** 30)} GB`,
  target: targetUrl ? `running FLUJO ${targetUrl}, flow ${flowName}` : `own production server from ${application}`,
  buildId: targetUrl ? undefined : await fs.readFile(path.join(application, '.next', 'BUILD_ID'), 'utf8').then(text => text.trim(), () => undefined),
  model: targetUrl ? 'the flow\'s own model' : `stub, answers after ${stubDelayMs} ms`, parallel, rounds, mode, fillerTokens, coldStart,
  passRules: PASS_RULES, bursts: [] };
try {
  if (!targetUrl) {
    say('Starting FLUJO...');
    await startServer();
  }
  if (coldStart) {
    say('Restarting FLUJO; the burst goes out as soon as it accepts connections...');
    await stopServer();
    launchServer();
    await waitUntilListening();
  }
  if (warmup) {
    say('Warm-up request...');
    const record = await chat(`burst-${randomUUID().slice(0, 8)}-0-0`);
    assert.ok(record.status === 200 && record.correct, `Warm-up failed: HTTP ${record.status} ${record.error ?? ''}`);
    await newTraces(1);
  }
  await skipExistingTraces();
  for (let round = 1; round <= rounds; round++) {
    const run = randomUUID().slice(0, 8);
    arrivals.clear();
    say(`Round ${round}: ${parallel} parallel ${mode} requests...`);
    const started = now();
    modelUnavailableAnswers = 0;
    modelStarting = coldStart && round === 1;
    modelReadyAt = undefined;
    const records = await Promise.all(Array.from({ length: parallel }, (_, index) => chat(`burst-${run}-${round}-${index}`)));
    const statuses = {};
    for (const record of records) statuses[record.status || 'none'] = (statuses[record.status || 'none'] ?? 0) + 1;
    const errors = {};
    for (const record of records) if (record.error) errors[record.error] = (errors[record.error] ?? 0) + 1;
    const burst = {
      round, wallMs: Math.round(now() - started), statuses, errors, modelUnavailableAnswers,
      connectionRetries: records.reduce((sum, record) => sum + record.connectionRetries, 0),
      correct: records.filter(record => record.correct).length,
      firstModelCallMs: stats(records.map(record => arrivals.has(record.marker) ? arrivals.get(record.marker) - record.sent : NaN)),
      firstTokenMs: stats(records.map(record => record.firstContent === undefined ? NaN : record.firstContent - record.sent)),
      totalMs: stats(records.map(record => record.end - record.sent)),
      server: traceStats(await newTraces(parallel)),
    };
    burst.failures = ruleFailures(burst, !targetUrl);
    results.bursts.push(burst);
    const firstCall = burst.firstModelCallMs.p50 ?? burst.server['first model call (server)'].p50;
    say(`Round ${round}: ${burst.correct}/${parallel} correct, statuses ${JSON.stringify(statuses)}, first model call p50 ${firstCall ?? '-'} ms`);
  }
} catch (error) {
  say(`Load test failed: ${error.stack ?? error}`);
  if (serverLog) say(`Server log tail:\n${serverLog.slice(-6000)}`);
  process.exitCode = 1;
} finally {
  await stopServer().catch(() => undefined);
  stubModel.close();
  await operator?.restore().catch(() => undefined);
  if (root && !keep) {
    // Remove the links first so cleanup can never reach the linked build or dependencies.
    for (const name of LINKED) await fs.rmdir(path.join(runtimeApp, name)).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => say(`Cleanup left ${root}: ${error.message}`));
  } else if (root) say(`Kept ${root}`);
}

// ---------------------------------------------------------------- report
const cell = value => value === undefined ? '-' : String(value);
const lines = [`# Parallel chat load test`, '',
  `${results.platform}, Node ${results.node}. Target: ${results.target}${results.buildId ? ` (build ${results.buildId})` : ''}. `
    + `Model: ${results.model}. ${parallel} parallel ${mode} requests${coldStart ? ' sent while FLUJO was starting' : ''}, `
    + `about ${fillerTokens} filler tokens each. Times in ms from sending.`, ''];
for (const burst of results.bursts) {
  lines.push(`## Round ${burst.round} (all answered after ${burst.wallMs} ms)`, '',
    `Correct answers: ${burst.correct}/${parallel}. HTTP statuses: ${JSON.stringify(burst.statuses)}.`
      + (Object.keys(burst.errors).length ? ` Errors: ${JSON.stringify(burst.errors)}.` : '')
      + (burst.modelUnavailableAnswers ? ` The starting model server answered 503 ${burst.modelUnavailableAnswers} times.` : '')
      + (burst.connectionRetries ? ` ${burst.connectionRetries} refused connections were tried again.` : ''), '',
    '| step | requests | p50 | p95 | max |', '|---|---:|---:|---:|---:|');
  const rows = [['first model call (stub)', burst.firstModelCallMs], ['first token', burst.firstTokenMs], ['total', burst.totalMs],
    ...Object.entries(burst.server).map(([name, value]) => [`server: ${name}`, value])];
  for (const [name, value] of rows) {
    if (!value.n) continue;
    lines.push(`| ${name} | ${value.n} | ${cell(value.p50)} | ${cell(value.p95)} | ${cell(value.max)} |`);
  }
  lines.push('', burst.failures.length ? `**Failed:** ${burst.failures.join('; ')}.` : '**Passed** every rule.', '');
}
if (results.bursts.length) console.log(lines.join('\n'));
results.passed = results.bursts.length === rounds && results.bursts.every(burst => !burst.failures.length);
if (outFile) {
  await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await fs.writeFile(path.resolve(outFile), JSON.stringify(results, null, 2));
  say(`Wrote ${path.resolve(outFile)}`);
}
if (!results.passed) process.exitCode ||= 2;

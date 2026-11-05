#!/usr/bin/env node
/**
 * Repeatable load test for one FLUJO instance, through the public /v1/chat/completions
 * address, against a stand-in model. It never calls a paid model.
 *
 *   npm run build
 *   node scripts/load-test.mjs concurrency --data-dir /some/empty/folder --out /some/results
 *
 * Scenarios (see docs/operations/load-results.md for what each one means):
 *   concurrency  many conversations at once, on a simple flow and a richer one
 *   long         one conversation with very many turns
 *   many         a large number of stored conversations: start time, listing, memory
 *   approvals    many runs waiting for approval, including a restart while they wait
 *   faults       slow, failing, hanging and cut-off models; clients that disconnect
 *   all          everything above, in that order
 *
 * The tool starts its own server from this checkout, on a private data folder, and
 * stops everything it started. With --base-url it uses a server you started yourself;
 * it then cannot read the inside measurements or restart it, and it skips what needs that.
 * Results land in --out as one JSON file for each scenario, and tables on the screen.
 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, createWriteStream, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startModelServer } from './load-test/model-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------

/** Value at the given share of a list, by the nearest-rank rule. */
export function percentile(values, share) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1];
}

const rounded = (value, digits = 0) => (value === null || value === undefined || !Number.isFinite(value)
  ? null : Number(value.toFixed(digits)));

function spread(values) {
  return {
    count: values.length,
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(values.length ? Math.max(...values) : null),
  };
}

const MiB = 1024 * 1024;
const toMiB = (bytes) => rounded(bytes / MiB, 1);

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

const DEFAULTS = {
  port: 4310,
  modelPort: 0,
  levels: '10,50,100,200,500',
  flows: 'simple,rich',
  streams: 'false,true',
  turns: 2,
  turnsList: '50,200,1000',
  files: 10_000,
  approvals: '50,200',
  timeoutS: 180,
  delayMs: 200,
  retry: false,
  retryBudgetS: 300,
  restartBetween: false,
};

export function parseOptions(argv) {
  const [scenario = 'help', ...rest] = argv;
  const options = { ...DEFAULTS, scenario };
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index];
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument: ${raw}`);
    const name = raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) { options[name] = true; continue; }
    index++;
    options[name] = /^-?\d+(\.\d+)?$/.test(next) && !['levels', 'approvals', 'turnsList'].includes(name) ? Number(next) : next;
  }
  return options;
}

const list = (value) => String(value).split(',').map((item) => item.trim()).filter(Boolean);

// ---------------------------------------------------------------------------------------
// HTTP client: one request, measured
// ---------------------------------------------------------------------------------------

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 1024 });

function jsonRequest(baseUrl, method, route, body, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(route, baseUrl);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const started = performance.now();
    const request = http.request(url, {
      method, agent, timeout: timeoutMs,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed, bytes: text.length, ms: performance.now() - started });
      });
      response.on('error', (error) => resolve({ status: 0, error: error.code ?? error.message, ms: performance.now() - started }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
    request.on('error', (error) => resolve({ status: 0, error: error.code ?? error.message, ms: performance.now() - started }));
    request.end(payload);
  });
}

function assistantReplyOf(body) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Send one chat turn and time it. `cut` makes the client hang up on purpose:
 * 'before-first-byte' right after sending, or 'after-first-chunk'.
 */
export function chatTurn(baseUrl, { flow, messages, conversationId, stream, metadata = {}, timeoutMs = 180_000, cut }) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({
      model: `flow-${flow}`, stream, messages,
      metadata: { flujo: 'true', ...(conversationId ? { conversationId } : {}), ...metadata },
    }));
    const started = performance.now();
    let firstAnswerMs = null;
    let settled = false;
    let request;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve({ firstAnswerMs, totalMs: performance.now() - started, ...result });
    };
    request = http.request(new URL('/v1/chat/completions', baseUrl), {
      method: 'POST', agent, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (response) => {
      const status = response.statusCode;
      const retryAfter = response.headers['retry-after'];
      const finalConversationId = response.headers['x-conversation-id'];
      let text = '';
      let reply = '';
      let buffer = '';
      let streamError;
      let sawDone = false;
      let streamedConversationId;
      const streaming = stream && status === 200;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (!streaming) { text += chunk; return; }
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') { sawDone = true; continue; }
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }
            if (parsed.error) streamError = parsed.error.code ?? parsed.error.type ?? 'stream_error';
            streamedConversationId ??= parsed.conversation_id ?? parsed.conversationId;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              if (firstAnswerMs === null) firstAnswerMs = performance.now() - started;
              reply += delta;
              if (cut === 'after-first-chunk') { request.destroy(); settle({ status, cut: true, reply }); return; }
            }
          }
        }
      });
      response.on('end', () => {
        if (settled) return;
        if (!streaming) {
          let body;
          try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
          firstAnswerMs = performance.now() - started;
          settle({
            status, body, retryAfter, reply: assistantReplyOf(body),
            code: body?.error?.code ?? undefined,
            conversationId: body?.conversation_id ?? body?.conversationId ?? finalConversationId ?? conversationId,
          });
          return;
        }
        settle({
          status, retryAfter, reply, sawDone, code: streamError,
          conversationId: streamedConversationId ?? finalConversationId ?? conversationId,
        });
      });
      response.on('error', (error) => settle({ status: 0, error: error.code ?? error.message, reply }));
      response.on('aborted', () => settle({ status: 0, error: 'response_aborted', reply }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
    request.on('error', (error) => {
      if (!settled) settle({ status: 0, error: error.code ?? error.message });
    });
    request.end(payload);
    if (cut === 'before-first-byte') setTimeout(() => { request.destroy(); settle({ status: 0, cut: true }); }, 30);
  });
}

/** Sort one finished turn into a named kind, so error rates can be listed by kind. */
export function classifyTurn(result, nonce) {
  if (result.cut) return 'cut_by_client';
  if (result.error) return `transport:${result.error}`;
  if (result.status !== 200) return `http_${result.status}:${result.code ?? 'no_code'}`;
  if (result.code) return `stream_error:${result.code}`;
  if (!result.reply) return 'empty_reply';
  if (nonce && !result.reply.includes(`[nonce:${nonce}]`)) return 'wrong_reply';
  return 'ok';
}

const canRetry = (result) => result.status === 429 || result.status === 503;

/** One turn. With retry on, it follows Retry-After until a budget runs out. */
async function turnWithRetry(baseUrl, turn, options) {
  const budgetEnds = performance.now() + options.retryBudgetS * 1000;
  let attempts = 0;
  for (;;) {
    attempts++;
    const result = await chatTurn(baseUrl, turn);
    if (!options.retry || !canRetry(result) || performance.now() >= budgetEnds) return { ...result, attempts };
    const seconds = Number(result.retryAfter);
    await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000 * (0.5 + Math.random()));
  }
}

// ---------------------------------------------------------------------------------------
// The server under test and its surroundings
// ---------------------------------------------------------------------------------------

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 64 * MiB, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

/** Everything started by this process tree, so leftovers can be counted. */
async function descendantsOf(pid) {
  if (!pid) return [];
  if (process.platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress']);
    let rows;
    try { rows = JSON.parse(stdout); } catch { return []; }
    return walkTree(rows.map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, name: row.Name })), pid);
  }
  const stdout = await run('ps', ['-e', '-o', 'pid=,ppid=,comm=']);
  const rows = stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), name: match[3] }));
  return walkTree(rows, pid);
}

export function walkTree(rows, root) {
  const found = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.parent === parent && row.pid !== parent) { found.push(row); queue.push(row.pid); }
    }
  }
  return found;
}

async function stopTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') { await run('taskkill.exe', ['/pid', String(pid), '/t', '/f']); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

class Server {
  constructor(options) {
    this.options = options;
    this.port = options.port;
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${this.port}`;
    this.dataDir = options.dataDir ? path.resolve(String(options.dataDir)) : undefined;
    this.external = Boolean(options.baseUrl);
    this.probeFile = options.out ? path.join(path.resolve(String(options.out)), 'probe.jsonl') : undefined;
    this.starts = 0;
  }

  /** Start the production build, and report how long each step took. */
  async start() {
    if (this.external) return { external: true };
    if (!existsSync(path.join(repo, '.next', 'BUILD_ID'))) throw new Error('No production build found. Run npm run build first.');
    await fs.mkdir(this.dataDir, { recursive: true });
    this.starts++;
    const logPath = path.join(path.dirname(this.probeFile), `server-${this.starts}.log`);
    this.logPath = logPath;
    const log = createWriteStream(logPath, { flags: 'a' });
    const probe = path.join(here, 'load-test', 'server-probe.cjs');
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(repo, 'scripts', 'launch-next.mjs'), 'start', '--hostname', '127.0.0.1', '--port', String(this.port)], {
      cwd: repo,
      env: {
        ...process.env,
        ...this.options.serverEnv,
        FLUJO_DATA_DIR: this.dataDir,
        FLUJO_LOAD_PROBE_FILE: this.probeFile,
        NODE_ENV: 'production',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(probe)}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const deadline = performance.now() + 300_000;
    let listeningMs = null;
    for (;;) {
      if (performance.now() > deadline) throw new Error('The server did not get ready within five minutes.');
      if (child.exitCode !== null) throw new Error(`The server stopped during start, with exit code ${child.exitCode}. See ${logPath}.`);
      const ping = await jsonRequest(this.baseUrl, 'GET', '/api/flow', undefined, { timeoutMs: 5000 });
      if (ping.status !== 0 && listeningMs === null) listeningMs = performance.now() - started;
      if (ping.status === 200) return { listeningMs: rounded(listeningMs), readyMs: rounded(performance.now() - started) };
      await sleep(100);
    }
  }

  async stop() {
    if (this.external || !this.child) return { leftover: [] };
    const pid = this.child.pid;
    const before = await descendantsOf(pid);
    await stopTree(pid);
    await Promise.race([this.exit, sleep(15_000)]);
    this.child = undefined;
    // A child that outlives the kill would be a leak. Look it up again by its old id.
    await sleep(500);
    const still = [];
    for (const row of before) {
      try { process.kill(row.pid, 0); still.push(row); } catch { /* gone, as it should be */ }
    }
    for (const row of still) await stopTree(row.pid);
    return { processesAtStop: before.length, leftover: still };
  }

  async status() {
    const response = await jsonRequest(this.baseUrl, 'GET', '/api/operations/status?workspace=default-workspace', undefined, { timeoutMs: 30_000 });
    return response.status === 200 ? { ...response.body, sampleMs: rounded(response.ms) } : undefined;
  }

  /** All probe lines of the current server process from `since` on. */
  async probeLines(since = 0) {
    if (!this.probeFile || !existsSync(this.probeFile)) return [];
    const text = await fs.readFile(this.probeFile, 'utf8');
    const lines = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.t >= since) lines.push(parsed);
      } catch { /* a line being written */ }
    }
    return lines;
  }
}

/** Reduce the probe lines of one time window to the numbers worth keeping. */
export function summarizeProbe(lines) {
  if (lines.length === 0) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const delta = (field) => {
    const pid = last.pid;
    const firstOfProcess = lines.find((line) => line.pid === pid) ?? first;
    return last.disk[field] - firstOfProcess.disk[field];
  };
  const groups = {};
  const startGroups = (lines.find((line) => line.pid === last.pid) ?? first).diskByGroup;
  for (const [group, values] of Object.entries(last.diskByGroup)) {
    const before = startGroups[group] ?? {};
    const change = {};
    for (const [field, value] of Object.entries(values)) {
      const difference = value - (before[field] ?? 0);
      if (difference) change[field] = difference;
    }
    if (Object.keys(change).length) groups[group] = change;
  }
  return {
    seconds: rounded((last.t - first.t) / 1000),
    rssStartMiB: toMiB(first.rss),
    rssEndMiB: toMiB(last.rss),
    rssPeakMiB: toMiB(Math.max(...lines.map((line) => line.rss))),
    heapEndMiB: toMiB(last.heapUsed),
    heapPeakMiB: toMiB(Math.max(...lines.map((line) => line.heapUsed))),
    externalPeakMiB: toMiB(Math.max(...lines.map((line) => line.external))),
    loopDelayP99WorstMs: rounded(Math.max(...lines.map((line) => line.delayP99Ms))),
    loopDelayP99MedianMs: rounded(percentile(lines.map((line) => line.delayP99Ms), 0.5)),
    loopDelayMaxMs: rounded(Math.max(...lines.map((line) => line.delayMaxMs))),
    cpuSeconds: rounded((last.cpuUserMs + last.cpuSystemMs - first.cpuUserMs - first.cpuSystemMs) / 1000, 1),
    handlesEnd: Object.values(last.resources).reduce((sum, value) => sum + value, 0),
    handlesPeak: Math.max(...lines.map((line) => Object.values(line.resources).reduce((sum, value) => sum + value, 0))),
    resourcesEnd: last.resources,
    disk: {
      writes: delta('writes'), writtenMiB: toMiB(delta('bytes')), renames: delta('renames'), syncs: delta('syncs'),
      reads: delta('reads'), readMiB: toMiB(delta('readBytes')),
    },
    diskByGroup: groups,
  };
}

/** How busy the whole machine is, so a noisy run can be recognised afterwards. */
function machineMeter() {
  const snapshot = () => os.cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { total: sum.total + total, idle: sum.idle + cpu.times.idle };
  }, { total: 0, idle: 0 });
  const start = snapshot();
  return () => {
    const end = snapshot();
    const total = end.total - start.total;
    return total > 0 ? rounded(100 * (1 - (end.idle - start.idle) / total)) : null;
  };
}

/** Waits for all runs to end, and reports how long that took. */
async function waitForIdle(server, timeoutMs = 120_000) {
  const started = performance.now();
  let last;
  while (performance.now() - started < timeoutMs) {
    last = await server.status();
    if (last?.flowRunAdmission && last.flowRunAdmission.activeRuns === 0 && (last.chatIngress?.active ?? 0) === 0) {
      return { idle: true, ms: rounded(performance.now() - started), status: last };
    }
    await sleep(500);
  }
  return { idle: false, ms: rounded(performance.now() - started), status: last };
}

function loadNumbers(status) {
  if (!status) return null;
  return {
    activeRuns: status.flowRunAdmission?.activeRuns,
    rejectedBusy: status.flowRunAdmission?.rejectedBusy,
    rejectedMemory: status.flowRunAdmission?.rejectedMemory,
    ingressActive: status.chatIngress?.active,
    ingressRejectedBusy: status.chatIngress?.rejectedBusy,
    ...(status.load ? { load: status.load } : {}),
  };
}

/** Samples during a run: the server's own view, and how quickly a small request gets through. */
function startWatcher(server) {
  let stopped = false;
  const samples = [];
  const worker = (async () => {
    while (!stopped) {
      const started = performance.now();
      const ping = await jsonRequest(server.baseUrl, 'GET', '/api/flow', undefined, { timeoutMs: 60_000 });
      const status = await server.status();
      samples.push({
        at: Date.now(), pingMs: rounded(ping.ms), pingStatus: ping.status,
        activeRuns: status?.flowRunAdmission?.activeRuns ?? null,
        took: rounded(performance.now() - started),
      });
      if (!stopped) await sleep(1000);
    }
  })();
  return async () => {
    stopped = true;
    await worker;
    const pings = samples.map((sample) => sample.pingMs).filter((value) => value !== null);
    const runs = samples.map((sample) => sample.activeRuns).filter((value) => value !== null);
    return {
      samples: samples.length,
      responsiveness: spread(pings),
      pingFailures: samples.filter((sample) => sample.pingStatus !== 200).length,
      peakActiveRuns: runs.length ? Math.max(...runs) : null,
    };
  };
}

// ---------------------------------------------------------------------------------------
// What the tests run against
// ---------------------------------------------------------------------------------------

function node(id, type, properties = {}, x = 0) {
  return { id, type, position: { x, y: 0 }, data: { label: id, type, properties } };
}
const edge = (id, source, target, data = {}) => ({ id, source, target, data: { edgeType: 'standard', ...data } });
const toolEdge = (id, source, target) => ({ id, source, target, data: { edgeType: 'mcp' } });
const outcomeIs = (value) => ({ kind: 'equals', value, target: 'variable', variable: 'decision.outcome' });

/** The flows a load test runs. Each is built only from what a real flow can contain. */
export function loadTestFlows(modelId, serverName) {
  const main = (id) => node(id, 'process', {
    boundModel: modelId, promptTemplate: 'You answer briefly.', name: id,
  });
  return {
    simple: {
      id: 'load-simple', name: 'load-simple',
      nodes: [node('start', 'start'), main('answer'), node('end', 'finish')],
      edges: [edge('a', 'start', 'answer'), edge('b', 'answer', 'end')],
    },
    tool: {
      id: 'load-tool', name: 'load-tool',
      nodes: [node('start', 'start'), main('answer'), node('end', 'finish'),
        node('tools', 'mcp', { boundServer: serverName, enabledTools: ['echo'] })],
      edges: [edge('a', 'start', 'answer'), edge('b', 'answer', 'end'), toolEdge('t', 'answer', 'tools')],
    },
    rich: {
      id: 'load-rich', name: 'load-rich',
      nodes: [
        node('start', 'start'),
        node('check', 'static', {
          entries: [{
            kind: 'modelDecision', model: modelId, captureVariable: 'check', target: 'last-user',
            question: {
              type: 'choice', instructions: 'Does this message need a person?',
              options: { fine: 'Anything else', needs_person: 'Needs a person' },
            },
            onFailure: 'continue', failureValue: 'needs_person',
          }],
          rules: [
            { id: 'needs_person', when: { kind: 'equals', value: 'needs_person', variable: 'check.value' }, outcome: 'person', reason: 'asked_for_person' },
            { id: 'fine', outcome: 'answer', reason: 'ordinary', allowTools: ['echo'] },
          ],
        }),
        main('answer'),
        node('note', 'static', { outputTemplate: 'Handed to a person.' }),
        node('end', 'finish'),
        node('tools', 'mcp', { boundServer: serverName, enabledTools: ['echo'] }),
      ],
      edges: [
        edge('a', 'start', 'check'),
        edge('to-answer', 'check', 'answer', { condition: outcomeIs('answer') }),
        edge('to-note', 'check', 'note'),
        edge('answer-end', 'answer', 'end'),
        edge('note-end', 'note', 'end'),
        toolEdge('t', 'answer', 'tools'),
      ],
    },
  };
}

/** Create the model, the tool server and the flows through the public routes. */
async function setUp(server, modelBaseUrl) {
  const modelId = 'load-model';
  const saved = await jsonRequest(server.baseUrl, 'POST', '/api/model', {
    id: modelId, name: 'load-model', displayName: 'Load test stand-in', provider: 'openai', adapter: 'openai',
    ApiKey: 'stand-in-not-a-real-key', baseUrl: modelBaseUrl,
  });
  if (![200, 201, 409].includes(saved.status)) throw new Error(`Could not create the model: HTTP ${saved.status} ${JSON.stringify(saved.body)}`);
  if (saved.status === 409) {
    await jsonRequest(server.baseUrl, 'PUT', `/api/model/${modelId}`, {
      id: modelId, name: 'load-model', displayName: 'Load test stand-in', provider: 'openai', adapter: 'openai',
      ApiKey: 'stand-in-not-a-real-key', baseUrl: modelBaseUrl,
    });
  }
  const serverName = 'load-echo';
  const mcp = await jsonRequest(server.baseUrl, 'POST', '/api/mcp/servers', {
    name: serverName, transport: 'stdio', command: process.execPath,
    args: [path.join(here, 'load-test', 'echo-mcp-server.mjs')],
    env: {}, disabled: false, rootPath: path.dirname(here), autoApprove: [],
  });
  if (![200, 201, 409].includes(mcp.status)) throw new Error(`Could not create the tool server: HTTP ${mcp.status} ${JSON.stringify(mcp.body)}`);
  for (const flow of Object.values(loadTestFlows(modelId, serverName))) {
    const created = await jsonRequest(server.baseUrl, 'POST', '/api/flow', flow);
    if (created.status === 409) await jsonRequest(server.baseUrl, 'PUT', `/api/flow/${flow.id}`, flow);
    else if (![200, 201].includes(created.status)) throw new Error(`Could not create flow ${flow.name}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  }
  return { modelId, serverName };
}

const flowNames = { simple: 'load-simple', tool: 'load-tool', rich: 'load-rich' };
const makeNonce = () => randomUUID().replace(/-/g, '').slice(0, 16);

// ---------------------------------------------------------------------------------------
// Scenario: many conversations at once
// ---------------------------------------------------------------------------------------

/** Runs `clients` conversations side by side, each with a number of turns. */
async function driveConversations(server, { clients, flow, stream, turns, options }) {
  const firsts = [];
  const totals = [];
  const kinds = {};
  let attempts = 0;
  const finished = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: clients }, async () => {
    const conversationId = `load-${randomUUID()}`;
    const messages = [];
    let lastGood = -1;
    for (let turn = 0; turn < turns; turn++) {
      const nonce = makeNonce();
      messages.push({ role: 'user', content: `Question ${turn} [nonce:${nonce}]` });
      const result = await turnWithRetry(server.baseUrl, {
        flow, stream, messages: [...messages], conversationId, timeoutMs: options.timeoutS * 1000,
      }, options);
      attempts += result.attempts;
      const kind = classifyTurn(result, nonce);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (kind !== 'ok') break;
      lastGood = turn;
      firsts.push(result.firstAnswerMs);
      totals.push(result.totalMs);
      messages.push({ role: 'assistant', content: result.reply });
    }
    if (lastGood >= 0) finished.push({ conversationId, nonces: messages.length });
  }));
  const seconds = (performance.now() - started) / 1000;
  const okTurns = kinds.ok ?? 0;
  const allTurns = Object.values(kinds).reduce((sum, value) => sum + value, 0);
  return {
    seconds: rounded(seconds, 1),
    conversations: clients,
    turnsAttempted: allTurns,
    turnsOk: okTurns,
    attempts,
    throughputPerSecond: rounded(okTurns / seconds, 1),
    errorRatePercent: rounded(100 * (allTurns - okTurns) / Math.max(1, allTurns), 1),
    kinds,
    firstAnswerMs: spread(firsts),
    fullAnswerMs: spread(totals),
    finished,
  };
}

/** Read stored conversations back. Each must be there and must end with its own answer. */
async function verifyStored(server, finished, sample = 25) {
  const chosen = finished.slice(0, sample);
  let good = 0;
  const problems = {};
  for (const { conversationId } of chosen) {
    const response = await jsonRequest(server.baseUrl, 'GET', `/v1/chat/conversations/${conversationId}`, undefined, { timeoutMs: 60_000 });
    const messages = response.body?.messages ?? response.body?.state?.messages;
    const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
    const problem = response.status !== 200 ? `http_${response.status}` : !Array.isArray(messages) ? 'no_messages'
      : last?.role !== 'assistant' ? `ends_with_${last?.role}` : undefined;
    if (problem) problems[problem] = (problems[problem] ?? 0) + 1;
    else good++;
  }
  return { checked: chosen.length, good, problems };
}

async function scenarioConcurrency(server, model, options) {
  const rows = [];
  for (const flowKey of list(options.flows)) {
    for (const stream of list(options.streams).map((value) => value === 'true')) {
      for (const clients of list(options.levels).map(Number)) {
        if (options.restartBetween) { await server.stop(); await server.start(); }
        await modelControl(model, { reset: true, resetStats: true, behaviour: { delayMs: options.delayMs } });
        const since = Date.now();
        const machine = machineMeter();
        const stopWatch = startWatcher(server);
        const outcome = await driveConversations(server, { clients, flow: flowNames[flowKey], stream, turns: options.turns, options });
        const watch = await stopWatch();
        const idle = await waitForIdle(server, 60_000);
        const stored = await verifyStored(server, outcome.finished);
        const lines = await server.probeLines(since);
        const { finished: _finished, ...numbers } = outcome;
        const row = {
          flow: flowKey, stream, clients, ...numbers, stored,
          drainedAfterMs: idle.ms, drained: idle.idle,
          watch, server: summarizeProbe(lines), machineBusyPercent: machine(),
          modelRequests: model.stats().requests, modelPeakActive: model.stats().peakActive,
          load: loadNumbers(idle.status),
        };
        rows.push(row);
        printConcurrencyRow(row);
      }
    }
  }
  return { rows };
}

function printConcurrencyRow(row) {
  const kinds = Object.entries(row.kinds).filter(([kind]) => kind !== 'ok').map(([kind, value]) => `${kind}=${value}`).join(' ');
  process.stdout.write(`${row.flow.padEnd(7)} stream=${String(row.stream).padEnd(5)} n=${String(row.clients).padStart(4)}`
    + ` ok=${String(row.turnsOk).padStart(4)}/${String(row.turnsAttempted).padEnd(4)} ${String(row.throughputPerSecond).padStart(6)}/s`
    + ` first p50/95=${row.firstAnswerMs.p50}/${row.firstAnswerMs.p95}ms full=${row.fullAnswerMs.p50}/${row.fullAnswerMs.p95}ms`
    + ` rss=${row.server?.rssPeakMiB}MiB delay99=${row.server?.loopDelayP99WorstMs}ms ping95=${row.watch.responsiveness.p95}ms`
    + ` peakRuns=${row.watch.peakActiveRuns} busy=${row.machineBusyPercent}% ${kinds}\n`);
}

async function modelControl(model, update) {
  await jsonRequest(`http://127.0.0.1:${model.port}`, 'POST', '/__control', update);
}

// ---------------------------------------------------------------------------------------
// Scenario: one very long conversation
// ---------------------------------------------------------------------------------------

async function sizeOnDisk(dataDir, id) {
  if (!dataDir) return null;
  const found = { conversationBytes: 0, logBytes: 0, otherBytes: 0, files: 0 };
  const walk = async (folder) => {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === id) { await sumFolder(full); continue; }
        await walk(full);
      } else if (entry.name.startsWith(id)) {
        const { size } = await fs.stat(full);
        found.files++;
        if (entry.name.endsWith('.jsonl')) found.logBytes += size;
        else if (folder.endsWith('conversations')) found.conversationBytes += size;
        else found.otherBytes += size;
      }
    }
  };
  const sumFolder = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await sumFolder(full);
      else { found.otherBytes += (await fs.stat(full)).size; found.files++; }
    }
  };
  await walk(dataDir);
  return found;
}

async function scenarioLong(server, model, options) {
  const rows = [];
  for (const target of list(options.turnsList).map(Number)) {
    await modelControl(model, { reset: true, resetStats: true, behaviour: { delayMs: options.longDelayMs ?? 20, jitterMs: 0, replyBytes: 400, chunks: 2, chunkDelayMs: 0 } });
    const conversationId = `load-${randomUUID()}`;
    const messages = [];
    const durations = [];
    const checkpoints = [];
    const kinds = {};
    const since = Date.now();
    const machine = machineMeter();
    const stream = options.longStream === true || options.longStream === 'true';
    const nextMark = (done) => done === target || done % Math.max(1, Math.floor(target / 5)) === 0;
    let stoppedAt = null;
    for (let turn = 1; turn <= target; turn++) {
      const nonce = makeNonce();
      messages.push({ role: 'user', content: `Question ${turn} [nonce:${nonce}]` });
      const result = await chatTurn(server.baseUrl, {
        flow: flowNames.simple, stream, messages, conversationId, timeoutMs: options.timeoutS * 1000,
      });
      const kind = classifyTurn(result, nonce);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (kind !== 'ok') { stoppedAt = turn; break; }
      durations.push(result.totalMs);
      messages.push({ role: 'assistant', content: result.reply });
      if (nextMark(turn)) {
        const recent = durations.slice(-Math.min(20, durations.length));
        const size = await sizeOnDisk(server.dataDir, conversationId);
        checkpoints.push({ turn, recentTurnMsP50: rounded(percentile(recent, 0.5)), recentTurnMsP95: rounded(percentile(recent, 0.95)), ...size });
        process.stdout.write(`long target=${target} turn=${turn} p50=${checkpoints.at(-1).recentTurnMsP50}ms conv=${toMiB(size?.conversationBytes ?? 0)}MiB log=${toMiB(size?.logBytes ?? 0)}MiB other=${toMiB(size?.otherBytes ?? 0)}MiB\n`);
      }
    }
    const lines = await server.probeLines(since);
    const summary = summarizeProbe(lines);
    const completed = durations.length;
    rows.push({
      targetTurns: target, completedTurns: completed, stoppedAt, kinds, checkpoints,
      perTurnWriteMiB: summary && completed ? rounded(summary.disk.writtenMiB / completed, 3) : null,
      perTurnRenames: summary && completed ? rounded(summary.disk.renames / completed, 1) : null,
      perTurnSyncs: summary && completed ? rounded(summary.disk.syncs / completed, 1) : null,
      largestModelRequestMiB: toMiB(model.stats().largestRequestBytes),
      server: summary, machineBusyPercent: machine(),
    });
  }
  return { rows };
}

// ---------------------------------------------------------------------------------------
// Scenario: very many stored conversations
// ---------------------------------------------------------------------------------------

async function findFolder(root, name) {
  const queue = [root];
  while (queue.length) {
    const folder = queue.shift();
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === name) return path.join(folder, entry.name);
      if (entry.name !== 'node_modules') queue.push(path.join(folder, entry.name));
    }
  }
  return undefined;
}

/** Clone one real stored conversation until there are `count`, so the format stays real. */
async function seedConversations(dataDir, sampleId, count) {
  const conversations = await findFolder(dataDir, 'conversations');
  const summaries = await findFolder(dataDir, 'conversation-summaries');
  const raw = await fs.readFile(path.join(conversations, `${sampleId}.json`), 'utf8');
  const summaryRaw = summaries ? await fs.readFile(path.join(summaries, `${sampleId}.json`), 'utf8').catch(() => undefined) : undefined;
  const now = Date.now();
  const batch = 64;
  let done = 0;
  while (done < count) {
    const size = Math.min(batch, count - done);
    await Promise.all(Array.from({ length: size }, async (_, offset) => {
      const index = done + offset;
      const id = `load-${randomUUID()}`;
      const stamp = now - index * 1000;
      const text = raw.split(sampleId).join(id).replace(/"updatedAt":\s*\d+/, `"updatedAt": ${stamp}`);
      await fs.writeFile(path.join(conversations, `${id}.json`), text);
      if (summaryRaw) {
        const summary = summaryRaw.split(sampleId).join(id).replace(/"updatedAt":\s*\d+/, `"updatedAt": ${stamp}`);
        await fs.writeFile(path.join(summaries, `${id}.json`), summary);
      }
    }));
    done += size;
  }
  return { conversations, summaries };
}

async function timedListing(server, route) {
  const first = await jsonRequest(server.baseUrl, 'GET', route, undefined, { timeoutMs: 600_000 });
  return { status: first.status, ms: rounded(first.ms), bytes: first.bytes, code: first.body?.code };
}

async function scenarioMany(server, model, options) {
  await modelControl(model, { reset: true, resetStats: true });
  const sampleId = `load-${randomUUID()}`;
  const nonce = makeNonce();
  const sample = await chatTurn(server.baseUrl, {
    flow: flowNames.simple, stream: false, conversationId: sampleId,
    messages: [{ role: 'user', content: `Sample [nonce:${nonce}]` }],
  });
  if (classifyTurn(sample, nonce) !== 'ok') throw new Error(`The sample conversation failed: ${classifyTurn(sample, nonce)}`);
  await waitForIdle(server);
  const baselineStatus = await server.status();
  await server.stop();
  const seedStarted = performance.now();
  const folders = await seedConversations(server.dataDir, sampleId, options.files);
  const seedSeconds = rounded((performance.now() - seedStarted) / 1000, 1);

  const measure = async (label) => {
    const since = Date.now();
    const start = await server.start();
    const listing = {
      coldFirstPage: await timedListing(server, '/v1/chat/conversations?limit=50'),
      warmFirstPage: await timedListing(server, '/v1/chat/conversations?limit=50'),
    };
    const nextCursor = (await jsonRequest(server.baseUrl, 'GET', '/v1/chat/conversations?limit=50', undefined, { timeoutMs: 600_000 })).body?.nextCursor;
    if (nextCursor) listing.secondPage = await timedListing(server, `/v1/chat/conversations?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
    await sleep(1500);
    const afterListing = await server.probeLines(since);
    const turns = await driveConversations(server, { clients: 20, flow: flowNames.simple, stream: false, turns: 1, options });
    const { finished: _finished, ...turnNumbers } = turns;
    await waitForIdle(server);
    const row = {
      label, ...start, listing,
      rssAfterListingMiB: afterListing.length ? toMiB(afterListing.at(-1).rss) : null,
      heapAfterListingMiB: afterListing.length ? toMiB(afterListing.at(-1).heapUsed) : null,
      newConversations: turnNumbers,
      server: summarizeProbe(await server.probeLines(since)),
    };
    process.stdout.write(`many ${label}: ready=${start.readyMs}ms cold=${listing.coldFirstPage.ms}ms warm=${listing.warmFirstPage.ms}ms rss=${row.rssAfterListingMiB}MiB chat p50=${turnNumbers.fullAnswerMs.p50}ms\n`);
    return row;
  };

  const rows = [await measure(`${options.files} stored, sidebar index present`)];
  await server.stop();
  if (folders.summaries) {
    // The worst case: the small index is gone, for example after a change of its format.
    await fs.rm(folders.summaries, { recursive: true, force: true });
    rows.push(await measure(`${options.files} stored, sidebar index missing`));
  }
  return { seedSeconds, baseline: { rssMiB: toMiB(baselineStatus?.memory?.rss ?? 0) }, rows };
}

// ---------------------------------------------------------------------------------------
// Scenario: many runs waiting for approval
// ---------------------------------------------------------------------------------------

function pendingCallsOf(body) {
  return body?.pendingToolCalls ?? body?.pending_tool_calls ?? body?.choices?.[0]?.message?.tool_calls ?? [];
}

async function startWaitingRun(server, nonce) {
  const conversationId = `load-${randomUUID()}`;
  const result = await turnWithRetry(server.baseUrl, {
    flow: flowNames.tool, stream: false, conversationId,
    messages: [{ role: 'user', content: `Please approve [nonce:${nonce}]` }],
    metadata: { requireApproval: 'true' }, timeoutMs: 120_000,
  }, { retry: true, retryBudgetS: 300 });
  return { conversationId, nonce, status: result.status, body: result.body, code: result.code, ms: result.totalMs };
}

async function resolveWaitingRun(server, entry) {
  const stored = await jsonRequest(server.baseUrl, 'GET', `/v1/chat/conversations/${entry.conversationId}`, undefined, { timeoutMs: 120_000 });
  const state = stored.body?.state ?? stored.body;
  const status = state?.status;
  const calls = state?.pendingToolCalls ?? pendingCallsOf(stored.body);
  if (status !== 'awaiting_tool_approval' || !calls?.length) {
    return { kind: `not_waiting:${stored.status}:${status}`, ms: 0 };
  }
  let response;
  const started = performance.now();
  for (const call of calls) {
    response = await jsonRequest(server.baseUrl, 'POST', `/v1/chat/conversations/${entry.conversationId}/respond`, {
      action: 'approve', toolCallId: call.id,
    }, { timeoutMs: 180_000 });
    if (response.status !== 200) return { kind: `approve_http_${response.status}:${response.body?.code ?? response.body?.error ?? ''}`.slice(0, 80), ms: response.ms };
  }
  const finalStatus = response.body?.status;
  const text = JSON.stringify(response.body?.messages ?? response.body ?? '');
  return {
    kind: text.includes(`[nonce:${entry.nonce}]`) ? `done:${finalStatus ?? 'unknown'}` : `no_answer:${finalStatus ?? 'unknown'}`,
    ms: performance.now() - started,
  };
}

async function inBatches(items, size, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function scenarioApprovals(server, model, options) {
  const rows = [];
  for (const count of list(options.approvals).map(Number)) {
    await modelControl(model, { reset: true, resetStats: true, behaviour: { delayMs: 50, jitterMs: 10 } });
    const beforeStatus = await waitForIdle(server);
    const since = Date.now();
    const started = performance.now();
    const entries = await inBatches(Array.from({ length: count }, () => makeNonce()), options.approvalBatch ?? 16, (nonce) => startWaitingRun(server, nonce));
    const secondsToPark = rounded((performance.now() - started) / 1000, 1);
    const parkKinds = {};
    for (const entry of entries) {
      const kind = entry.status === 200 ? 'answered' : `http_${entry.status}:${entry.code}`;
      parkKinds[kind] = (parkKinds[kind] ?? 0) + 1;
    }
    await sleep(2000);
    const holding = await waitForIdle(server, 30_000);
    const whileHolding = await server.status();
    const probe = await driveConversations(server, { clients: 20, flow: flowNames.simple, stream: false, turns: 1, options });
    const { finished: _finishedProbe, ...probeNumbers } = probe;
    const listing = await timedListing(server, '/v1/chat/conversations?limit=50');
    const rssHolding = toMiB((await server.status())?.memory?.rss ?? 0);

    let restart = { skipped: true };
    const half = Math.floor(entries.length / 2);
    const resolvedBefore = await inBatches(entries.slice(0, half), 8, (entry) => resolveWaitingRun(server, entry));
    if (!server.external) {
      await server.stop();
      const start = await server.start();
      const after = await server.status();
      restart = { ...start, runsActiveAfterRestart: after?.flowRunAdmission?.activeRuns };
    }
    const resolveStarted = performance.now();
    const resolvedAfter = await inBatches(entries.slice(half), 8, (entry) => resolveWaitingRun(server, entry));
    const count2 = (results) => {
      const kinds = {};
      for (const result of results) kinds[result.kind] = (kinds[result.kind] ?? 0) + 1;
      return kinds;
    };
    const row = {
      waiting: count, secondsToPark, parkKinds,
      runSlotsHeldWhileWaiting: whileHolding?.flowRunAdmission?.activeRuns,
      idleWhileWaiting: holding.idle,
      rssBeforeMiB: toMiB(beforeStatus.status?.memory?.rss ?? 0), rssHoldingMiB: rssHolding,
      newConversationsWhileWaiting: probeNumbers,
      listingWhileWaiting: listing,
      restart,
      resolvedBeforeRestart: count2(resolvedBefore),
      resolvedAfterRestart: count2(resolvedAfter),
      secondsToResolveAfterRestart: rounded((performance.now() - resolveStarted) / 1000, 1),
      approveMs: spread(resolvedAfter.map((result) => result.ms).filter(Boolean)),
      server: summarizeProbe(await server.probeLines(since)),
    };
    rows.push(row);
    process.stdout.write(`approvals n=${count}: parked in ${secondsToPark}s ${JSON.stringify(parkKinds)} slots=${row.runSlotsHeldWhileWaiting} rss ${row.rssBeforeMiB}->${rssHolding}MiB before=${JSON.stringify(row.resolvedBeforeRestart)} after=${JSON.stringify(row.resolvedAfterRestart)}\n`);
  }
  return { rows };
}

// ---------------------------------------------------------------------------------------
// Scenario: things going wrong
// ---------------------------------------------------------------------------------------

async function faultCase(server, model, { label, behaviour, clients, stream, flow = flowNames.simple, cut, options, drainMs = 90_000, timeoutS }) {
  await modelControl(model, { reset: true, resetStats: true, behaviour });
  const since = Date.now();
  const stopWatch = startWatcher(server);
  const started = performance.now();
  const ids = [];
  const results = await Promise.all(Array.from({ length: clients }, async () => {
    const conversationId = `load-${randomUUID()}`;
    ids.push(conversationId);
    const nonce = makeNonce();
    const result = await chatTurn(server.baseUrl, {
      flow, stream, conversationId, cut, timeoutMs: (timeoutS ?? options.timeoutS) * 1000,
      messages: [{ role: 'user', content: `Fault test [nonce:${nonce}]` }],
    });
    return { kind: classifyTurn(result, nonce), result };
  }));
  const seconds = rounded((performance.now() - started) / 1000, 1);
  const kinds = {};
  for (const { kind } of results) kinds[kind] = (kinds[kind] ?? 0) + 1;
  const statsAtReturn = model.stats();
  const idle = await waitForIdle(server, drainMs);
  // While hanging, a fresh question shows whether the server can still take new work.
  const probeBehaviour = behaviour.hangRate ? { hangRate: 0 } : undefined;
  if (probeBehaviour) await modelControl(model, { behaviour: probeBehaviour });
  const probeNonce = makeNonce();
  const probe = await chatTurn(server.baseUrl, {
    flow: flowNames.simple, stream: false, timeoutMs: 30_000,
    messages: [{ role: 'user', content: `Probe [nonce:${probeNonce}]` }],
  });
  const watch = await stopWatch();
  const stored = {};
  for (const id of ids.slice(0, 20)) {
    const response = await jsonRequest(server.baseUrl, 'GET', `/v1/chat/conversations/${id}`, undefined, { timeoutMs: 30_000 });
    const status = response.status === 200 ? (response.body?.status ?? response.body?.state?.status ?? 'no_status') : `http_${response.status}`;
    stored[status] = (stored[status] ?? 0) + 1;
  }
  const stats = model.stats();
  const row = {
    label, clients, stream, seconds, kinds,
    returned: spread(results.map(({ result }) => result.totalMs)),
    drained: idle.idle, drainMs: idle.ms, activeRunsAtEnd: idle.status?.flowRunAdmission?.activeRuns,
    freshRequestAfter: { kind: classifyTurn(probe, probeNonce), ms: rounded(probe.totalMs), status: probe.status, code: probe.code },
    storedStatusSample: stored,
    modelRequests: stats.requests, modelClientAborts: stats.clientAborts, modelActiveAtReturn: statsAtReturn.active, modelActiveAtEnd: stats.active,
    watch, server: summarizeProbe(await server.probeLines(since)), load: loadNumbers(idle.status),
  };
  process.stdout.write(`fault ${label}: ${JSON.stringify(kinds)} in ${seconds}s drained=${row.drained}(${row.drainMs}ms) active=${row.activeRunsAtEnd} fresh=${row.freshRequestAfter.kind} modelAborts=${stats.clientAborts} modelActive=${stats.active}\n`);
  return row;
}

async function scenarioFaults(server, model, options) {
  const n = Number(options.faultClients ?? 30);
  const rows = [];
  const quick = { delayMs: 50, jitterMs: 10 };
  const cases = [
    { label: 'slow model, 15 s, blocking', behaviour: { delayMs: 15_000, jitterMs: 0 }, stream: false },
    { label: 'slow model, 15 s, streaming', behaviour: { delayMs: 15_000, jitterMs: 0 }, stream: true },
    { label: '20% of model calls fail, blocking', behaviour: { ...quick, failRate: 0.2 }, stream: false },
    { label: '20% of model calls fail, streaming', behaviour: { ...quick, failRate: 0.2 }, stream: true },
    { label: 'model always fails, blocking', behaviour: { ...quick, failRate: 1 }, stream: false },
    { label: 'model refuses with Retry-After 1 s', behaviour: { ...quick, rateLimitRate: 0.5, retryAfterSeconds: 1 }, stream: false },
    { label: 'model cuts the connection midway', behaviour: { ...quick, dropRate: 1 }, stream: true },
    { label: 'client leaves before the first byte, blocking', behaviour: { delayMs: 3000, jitterMs: 0 }, stream: false, cut: 'before-first-byte' },
    { label: 'client leaves before the first byte, streaming', behaviour: { delayMs: 3000, jitterMs: 0 }, stream: true, cut: 'before-first-byte' },
    { label: 'client leaves after the first piece', behaviour: { delayMs: 200, jitterMs: 0, chunks: 40, chunkDelayMs: 100 }, stream: true, cut: 'after-first-chunk' },
    { label: 'client leaves while the tool flow runs', behaviour: { delayMs: 1500, jitterMs: 0, chunks: 20, chunkDelayMs: 50 }, stream: true, flow: flowNames.tool, cut: 'after-first-chunk' },
    { label: 'model never answers, blocking', behaviour: { hangRate: 1 }, stream: false, timeoutS: 45, drainMs: 30_000 },
    { label: 'model never answers, streaming', behaviour: { hangRate: 1 }, stream: true, timeoutS: 45, drainMs: 30_000 },
  ];
  for (const fault of cases) {
    rows.push(await faultCase(server, model, { ...fault, clients: n, options }));
    await modelControl(model, { reset: true });
  }
  return { rows };
}

// ---------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------

const HELP = `Usage: node scripts/load-test.mjs <concurrency|long|many|approvals|faults|all> [options]

Where things go
  --data-dir PATH     Empty private data folder for the server this tool starts.
  --out PATH          Folder for result files and server logs. Keep it outside the repository.
  --port N            Port of the server under test (default ${DEFAULTS.port}).
  --base-url URL      Use a server you started yourself instead.

What to run
  --levels LIST       Conversations at once (default ${DEFAULTS.levels}).
  --flows LIST        simple, tool, rich (default ${DEFAULTS.flows}).
  --streams LIST      false, true (default ${DEFAULTS.streams}).
  --turns N           Turns in each conversation (default ${DEFAULTS.turns}).
  --delay-ms N        Model answer delay (default ${DEFAULTS.delayMs}).
  --retry             Follow Retry-After instead of counting a refusal as final.
  --retry-budget-s N  How long one turn may keep retrying (default ${DEFAULTS.retryBudgetS}).
  --timeout-s N       Give up on one turn after this long (default ${DEFAULTS.timeoutS}).
  --restart-between   Restart the server before each row of the concurrency table.
  --turns-list LIST   Lengths for the long scenario (default ${DEFAULTS.turnsList}).
  --files N           Conversations stored for the many scenario (default ${DEFAULTS.files}).
  --approvals LIST    Waiting runs for the approvals scenario (default ${DEFAULTS.approvals}).
  --fault-clients N   Conversations in each fault case (default 30).
  --server-env JSON   Extra settings for the server, such as limits.
`;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const scenarios = { concurrency: scenarioConcurrency, long: scenarioLong, many: scenarioMany, approvals: scenarioApprovals, faults: scenarioFaults };
  const chosen = options.scenario === 'all' ? Object.keys(scenarios) : [options.scenario];
  if (options.scenario === 'help' || options.help || !chosen.every((name) => scenarios[name])) {
    process.stdout.write(HELP);
    process.exitCode = options.scenario === 'help' || options.help ? 0 : 2;
    return;
  }
  if (!options.baseUrl && (!options.dataDir || !options.out)) throw new Error('--data-dir and --out are required when this tool starts the server.');
  if (options.serverEnv) options.serverEnv = JSON.parse(String(options.serverEnv));
  const out = path.resolve(String(options.out ?? path.join(os.tmpdir(), `flujo-load-${Date.now()}`)));
  options.out = out;
  await fs.mkdir(out, { recursive: true });

  const packageVersion = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const environment = {
    date: new Date().toISOString(), flujoVersion: packageVersion, node: process.version,
    platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cpus: os.cpus().length,
    memoryGiB: rounded(os.totalmem() / 1024 ** 3, 1), label: options.label ?? null,
    serverEnv: options.serverEnv ?? {},
  };

  const model = await startModelServer({ port: Number(options.modelPort) || 0, behaviour: { delayMs: options.delayMs } });
  const server = new Server(options);
  let failure;
  let processCheck;
  try {
    const start = await server.start();
    process.stdout.write(`Server ready: ${JSON.stringify(start)}. Stand-in model on port ${model.port}.\n`);
    await setUp(server, model.baseUrl);
    for (const name of chosen) {
      process.stdout.write(`\n=== ${name} ===\n`);
      const before = server.child ? await descendantsOf(server.child.pid) : [];
      const result = await scenarios[name](server, model, options);
      const after = server.child ? await descendantsOf(server.child.pid) : [];
      const file = path.join(out, `${options.label ? `${options.label}-` : ''}${name}.json`);
      await fs.writeFile(file, JSON.stringify({ environment, scenario: name, childProcesses: { before: before.length, after: after.length, afterNames: after.map((row) => row.name) }, ...result }, null, 2));
      process.stdout.write(`Saved ${file}\n`);
    }
  } catch (error) {
    failure = error;
  } finally {
    processCheck = await server.stop().catch((error) => ({ error: String(error) }));
    await model.close();
    agent.destroy();
  }
  if (processCheck?.leftover?.length) process.stdout.write(`Processes that outlived the server: ${JSON.stringify(processCheck.leftover)}\n`);
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}

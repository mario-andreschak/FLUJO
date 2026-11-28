// A local stand-in for the model service behind the bundled Codex CLI.
//
// It speaks just enough of the Responses API (streamed server-sent events) for
// Codex to run real turns: text replies, FLUJO tool calls, ChatGPT-style plan
// limit headers, a used-up plan, replies that never finish (for cancellation)
// and compaction summaries. It listens on 127.0.0.1 only and needs no login,
// account or real model. Used by `npm run record:codex-protocol`, the real
// Codex tests and the packaged acceptance Codex check.
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAND_IN_MODEL = 'flujo-fixture-model';
export const RESET_AT = 1893456000; // 2030-01-01, a fixed time so recordings stay stable.
export const USAGE_LIMIT_PROMPT = 'FLUJO_FIXTURE_USAGE_LIMIT';
export const HANG_PROMPT = 'FLUJO_FIXTURE_HANG';
/** Codex asks for a summary with this phrase when it compacts a conversation. */
const COMPACTION_PROMPT = /CONTEXT CHECKPOINT COMPACTION|handoff summary|summar(?:y|ize) (?:of|the) (?:the )?conversation/i;

const TRIPLES = {
  'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
  'darwin:x64': 'x86_64-apple-darwin', 'darwin:arm64': 'aarch64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc', 'win32:arm64': 'aarch64-pc-windows-msvc',
};

/** The Codex CLI an installed FLUJO (or this checkout) runs. Same lookup as
 * bundledCodexExecutable() in codexRestrictedProfile.ts. */
export function bundledCodex(root = repo) {
  const triple = TRIPLES[`${process.platform}:${process.arch}`];
  if (!triple) throw new Error('No bundled Codex CLI for this platform.');
  const local = createRequire(path.join(root, 'package.json'));
  const codexPackage = local.resolve('@openai/codex/package.json');
  const codexRequire = createRequire(codexPackage);
  const platformRoot = path.dirname(codexRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  const version = file => JSON.parse(readFileSync(file, 'utf8')).version;
  return {
    executable: path.join(platformRoot, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    cliVersion: version(codexPackage),
    // The SDK's package.json is not an export; read it beside the CLI package.
    sdkVersion: version(path.join(path.dirname(path.dirname(codexPackage)), 'codex-sdk', 'package.json')),
  };
}

function lastUserText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (item?.role !== 'user' || !Array.isArray(item.content)) continue;
    return item.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n');
  }
  return '';
}

function allText(body) {
  return JSON.stringify(body?.input ?? []);
}

/** Where Codex offers a tool whose name ends with `suffix`: its name and,
 * for MCP tools grouped per server, the group (namespace) it sits in. */
export function offeredTool(body, suffix) {
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (typeof tool?.name === 'string' && tool.name.endsWith(suffix)) return { name: tool.name };
    for (const inner of Array.isArray(tool?.tools) ? tool.tools : []) {
      if (typeof inner?.name === 'string' && inner.name.endsWith(suffix)) return { name: inner.name, namespace: tool.name };
    }
  }
  return undefined;
}

/** Which reply the stand-in plays for one request. A caller's `reply` can
 * override it, for example to call a FLUJO tool. */
export function defaultReply(body, call) {
  const text = lastUserText(body);
  if (text.includes(USAGE_LIMIT_PROMPT)) return { usageLimit: true };
  if (COMPACTION_PROMPT.test(text)) return { text: `Fixture summary ${call}.` };
  if (text.includes(HANG_PROMPT)) return { hang: true };
  // A structured-output request gets an answer that matches FLUJO's fixture schema.
  if (body?.text?.format?.type === 'json_schema') return { text: JSON.stringify({ answer: `Fixture reply ${call}.` }) };
  return { text: `Fixture reply ${call}.` };
}

/**
 * Start the stand-in. `reply(body, call)` may return `{ text }`,
 * `{ toolCall: { name, namespace?, arguments } }`, `{ usageLimit: true }`, `{ hang: true }`
 * or undefined for the default. Every request body is kept in `requests`.
 */
/** @param {{ reply?: (body: any, call: number) => any, inputTokens?: (call: number) => number }} [options] */
export async function startStandInModel({ reply, inputTokens = call => 120 * call } = {}) {
  let calls = 0;
  const requests = [];
  const open = new Set();
  const waiters = [];
  const server = createServer(async (incoming, outgoing) => {
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    if (incoming.method !== 'POST' || !incoming.url.endsWith('/responses')) {
      outgoing.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}');
      return;
    }
    const call = ++calls;
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw }; }
    requests.push(body);
    for (const waiter of [...waiters]) if (waiter.match(body, call)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(body); }
    const limitHeaders = used => ({
      'x-codex-primary-used-percent': String(used), 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(RESET_AT), 'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(RESET_AT + 86400),
    });
    const action = reply?.(body, call) ?? defaultReply(body, call);
    if (action.usageLimit) {
      outgoing.writeHead(429, { 'Content-Type': 'application/json', ...limitHeaders(100) }).end(JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: RESET_AT },
      }));
      return;
    }
    const usage = { input_tokens: inputTokens(call), output_tokens: 18, total_tokens: inputTokens(call) + 18,
      input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 6 } };
    const base = { id: `resp_fixture_${call}`, object: 'response', created_at: 1700000000, model: STAND_IN_MODEL };
    outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', ...limitHeaders(42) });
    const send = (event, index) => outgoing.write(`data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);
    if (action.hang) {
      // Start a reply and never finish it, so a caller can cancel mid-answer.
      open.add(outgoing);
      outgoing.on('close', () => open.delete(outgoing));
      send({ type: 'response.created', response: { ...base, status: 'in_progress', output: [] } }, 0);
      return;
    }
    let item;
    const events = [];
    if (action.toolCall) {
      item = { type: 'function_call', id: `fc_fixture_${call}`, call_id: `call_fixture_${call}`, status: 'completed',
        name: action.toolCall.name, ...(action.toolCall.namespace ? { namespace: action.toolCall.namespace } : {}),
        arguments: JSON.stringify(action.toolCall.arguments ?? {}) };
      events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
    } else {
      const text = String(action.text ?? '');
      item = { type: 'message', id: `msg_fixture_${call}`, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }] };
      const split = Math.min(text.length, 'Fixture '.length);
      events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text.slice(0, split) },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text.slice(split) });
    }
    const response = { ...base, status: 'completed', output: [item], usage };
    events.unshift({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response });
    events.forEach(send);
    outgoing.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    requests,
    get calls() { return calls; },
    /** Resolves with the first request (from now on) that matches. */
    nextRequest(match = () => true) { return new Promise(resolve => waiters.push({ match, resolve })); },
    /** Requests whose text contains `needle`. */
    requestsContaining(needle) { return requests.filter(body => allText(body).includes(needle)); },
    async close() {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

/** An empty Codex home and workspace that point Codex at the stand-in. */
/** @param {number} port @param {{ config?: string[] }} [options] */
export async function prepareStandInHome(port, { config = [] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-stand-in-'));
  const codexHome = path.join(home, 'codex-home'), workspace = path.join(home, 'workspace');
  await fs.mkdir(codexHome); await fs.mkdir(workspace);
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "flujo_fixture"', `model = "${STAND_IN_MODEL}"`, 'cli_auth_credentials_store = "file"',
    ...config,
    '[model_providers.flujo_fixture]', 'name = "FLUJO fixture"', `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n'));
  const env = { PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? '',
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home, TMPDIR: home,
    CODEX_HOME: codexHome, NODE_ENV: 'production' };
  return {
    home, codexHome, workspace, env,
    async remove() { await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}); },
  };
}

/** The start-up switches FLUJO's ordinary conversation path uses. */
export const FLUJO_APP_SERVER_ARGS = Object.freeze([
  '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
  '-c', 'tools.experimental_request_user_input.enabled=false',
  '-c', 'features.default_mode_request_user_input=false', 'app-server',
]);

export function withTimeout(promise, label, milliseconds = 60000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

/** A plain app-server client that keeps every message in `frames`. Server
 * requests (approval prompts) are refused unless `onRequest` answers them. */
export function startAppServer({ executable, env, cwd, frames = [], args = FLUJO_APP_SERVER_ARGS, onRequest }) {
  const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  let sequence = 0, buffer = '';
  const pending = new Map(), waiters = [];
  const exited = new Promise(resolve => child.once('close', resolve));
  const send = message => { frames.push({ direction: 'out', message }); child.stdin.write(JSON.stringify(message) + '\n'); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      frames.push({ direction: 'in', message });
      if (message.id !== undefined && message.method) {
        const answer = onRequest?.(message);
        send(answer === undefined
          ? { id: message.id, error: { code: -32601, message: 'Not enabled in the recording.' } }
          : { id: message.id, result: answer });
      } else if (message.id !== undefined) {
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
      for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    }
  });
  return {
    child, frames,
    /** Resolves with the result; rejects with the error a refusal carries. */
    async request(method, params, milliseconds) {
      const id = ++sequence;
      const reply = new Promise(resolve => pending.set(id, resolve));
      send({ id, method, params });
      const message = await withTimeout(reply, `${method} response`, milliseconds);
      if (message.error) throw Object.assign(new Error(`${method} was refused: ${JSON.stringify(message.error)}`), { rpc: message.error });
      return message.result;
    },
    /** Write a request without waiting for its answer. */
    write(method, params) { const id = ++sequence; send({ id, method, params }); return id; },
    notify(method) { send({ method, params: {} }); },
    waitFor(match, label, milliseconds) { return withTimeout(new Promise(resolve => waiters.push({ match, resolve })), label, milliseconds); },
    async stop() { child.stdin.end(); const timer = setTimeout(() => child.kill(), 20000); await exited; clearTimeout(timer); },
    async kill() { child.kill(); await exited; },
    exited,
  };
}

/** Every running process as pid -> parent pid, from one OS listing. The
 * listing program itself (and its console host) is left out. */
export async function listProcesses() {
  let lister;
  const listing = await new Promise((resolve, reject) => {
    const command = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']]
      : ['ps', ['-A', '-o', 'pid=,ppid=']];
    lister = spawn(command[0], command[1], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    lister.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    lister.once('error', reject);
    lister.once('close', () => resolve(output));
  });
  const table = new Map();
  for (const line of listing.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid) && pid !== ppid) table.set(pid, ppid);
  }
  for (const [pid, ppid] of [...table]) if (pid === lister.pid || ppid === lister.pid) table.delete(pid);
  return table;
}

/** Process ids below `root` (not including it). */
export async function descendantProcessIds(root = process.pid) {
  const table = await listProcesses();
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = new Set();
  const visit = pid => { for (const child of children.get(pid) ?? []) if (!found.has(child)) { found.add(child); visit(child); } };
  visit(root);
  return found;
}

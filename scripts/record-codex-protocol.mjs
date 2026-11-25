#!/usr/bin/env node
// Record what the bundled Codex CLI really sends over its app-server stdio
// connection, so tests can replay it after every Codex update.
//
// Safe to run anywhere: it uses an empty temporary Codex home, no login and no
// account. Model calls go to a small local server on 127.0.0.1 that plays a
// fixed reply, sends ChatGPT-style rate-limit headers and, for one turn,
// refuses with a usage-limit error. Nothing leaves this machine.
//
// Usage: node scripts/record-codex-protocol.mjs
// Writes __tests__/model/fixtures/codexAppServerProtocol.json.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(repo, '__tests__', 'model', 'fixtures', 'codexAppServerProtocol.json');
const MODEL = 'flujo-fixture-model';
const RESET_AT = 1893456000; // 2030-01-01, a fixed time so recordings stay stable.

/** Same lookup as bundledCodexExecutable() in codexRestrictedProfile.ts. */
export function bundledCodex(root = repo) {
  const triples = {
    'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
    'darwin:x64': 'x86_64-apple-darwin', 'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc', 'win32:arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[`${process.platform}:${process.arch}`];
  if (!triple) throw new Error('No bundled Codex CLI for this platform.');
  const local = createRequire(path.join(root, 'package.json'));
  const codexRequire = createRequire(local.resolve('@openai/codex/package.json'));
  const platformRoot = path.dirname(codexRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  return {
    executable: path.join(platformRoot, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    cliVersion: JSON.parse(String(local('fs').readFileSync(local.resolve('@openai/codex/package.json')))).version,
    sdkVersion: JSON.parse(String(local('fs').readFileSync(path.join(root, 'node_modules', '@openai', 'codex-sdk', 'package.json')))).version,
  };
}

/** Local stand-in for the Responses API. Plays one short reply per call. */
function fixtureProvider() {
  let calls = 0;
  const server = createServer(async (incoming, outgoing) => {
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    if (incoming.method !== 'POST' || !incoming.url.endsWith('/responses')) {
      outgoing.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}');
      return;
    }
    const call = ++calls;
    const limitHeaders = (used) => ({
      'x-codex-primary-used-percent': String(used), 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(RESET_AT), 'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(RESET_AT + 86400),
    });
    if (raw.includes('FLUJO_FIXTURE_USAGE_LIMIT')) {
      outgoing.writeHead(429, { 'Content-Type': 'application/json', ...limitHeaders(100) }).end(JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: RESET_AT },
      }));
      return;
    }
    const text = `Fixture reply ${call}.`;
    const item = { type: 'message', id: `msg_fixture_${call}`, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: `resp_fixture_${call}`, object: 'response', status: 'completed', created_at: 1700000000,
      model: MODEL, output: [item], usage: { input_tokens: 120 * call, output_tokens: 18, total_tokens: 120 * call + 18,
        input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 6 } } };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture ' },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text.slice('Fixture '.length) },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', ...limitHeaders(42) });
    outgoing.end(events.map((event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''));
  });
  return server;
}

/** One app-server process with the same start-up switches FLUJO uses. */
function appServer({ executable, env, cwd, frames }) {
  const child = spawn(executable, [
    '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
    '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'features.default_mode_request_user_input=false', 'app-server',
  ], { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  let sequence = 0, buffer = '';
  const pending = new Map(), waiters = [];
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      frames.push({ direction: 'in', message });
      if (message.id !== undefined && message.method) {
        // FLUJO's ordinary path never enables Codex's own approvals; record any ask.
        const reply = { id: message.id, error: { code: -32601, message: 'Not enabled in the recording.' } };
        frames.push({ direction: 'out', message: reply });
        child.stdin.write(JSON.stringify(reply) + '\n');
      } else if (message.id !== undefined) {
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
      for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    }
  });
  const send = message => { frames.push({ direction: 'out', message }); child.stdin.write(JSON.stringify(message) + '\n'); };
  return {
    async request(method, params) {
      const id = ++sequence;
      const reply = new Promise(resolve => pending.set(id, resolve));
      send({ id, method, params });
      const message = await withTimeout(reply, `${method} response`);
      if (message.error) throw new Error(`${method} was refused: ${JSON.stringify(message.error)}`);
      return message.result;
    },
    notify(method) { send({ method, params: {} }); },
    waitFor(match, label) { return withTimeout(new Promise(resolve => waiters.push({ match, resolve })), label); },
    async stop() { child.stdin.end(); const timer = setTimeout(() => child.kill(), 20000); await exited; clearTimeout(timer); },
  };
}

function withTimeout(promise, label, milliseconds = 60000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

const turnDone = (threadId) => message => message.method === 'turn/completed' && message.params?.threadId === threadId;

export async function recordCodexProtocol({ output = FIXTURE } = {}) {
  const { executable, cliVersion, sdkVersion } = bundledCodex();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-protocol-'));
  const provider = fixtureProvider();
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  try {
    const codexHome = path.join(home, 'codex-home'), cwd = path.join(home, 'workspace');
    await fs.mkdir(codexHome); await fs.mkdir(cwd);
    const port = provider.address().port;
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "flujo_fixture"', `model = "${MODEL}"`, 'cli_auth_credentials_store = "file"',
      '[model_providers.flujo_fixture]', 'name = "FLUJO fixture"', `base_url = "http://127.0.0.1:${port}/v1"`,
      'env_key = "FLUJO_FIXTURE_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
      'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n'));
    const env = { PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? '',
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home, TMPDIR: home,
      CODEX_HOME: codexHome, FLUJO_FIXTURE_KEY: randomBytes(12).toString('hex'), NODE_ENV: 'production' };
    const threadParams = { model: MODEL, cwd, approvalPolicy: 'never', sandbox: 'read-only',
      config: { service_tier: 'default', web_search: 'disabled', features: { shell_tool: false } },
      developerInstructions: 'You are the FLUJO protocol recording fixture.' };
    const turn = (threadId, text) => ({ threadId, model: MODEL, effort: 'low', input: [{ type: 'text', text }] });
    const initialize = { clientInfo: { name: 'flujo_conversation', title: 'FLUJO', version: '1' } };
    const sessions = [];

    // 1. A new conversation with one ordinary turn.
    const started = { name: 'start', frames: [] };
    sessions.push(started);
    let server = appServer({ executable, env, cwd, frames: started.frames });
    await server.request('initialize', initialize); server.notify('initialized');
    const thread = await server.request('thread/start', { ...threadParams, ephemeral: false });
    const threadId = thread.thread.id;
    let done = server.waitFor(turnDone(threadId), 'first turn');
    const firstTurn = await server.request('turn/start', turn(threadId, 'Say the fixture reply.'));
    await done;
    await server.stop();

    // 2. A fresh process resumes the saved conversation (FLUJO restart).
    // Steps 2-4 share one process; its frames are split once it has exited,
    // so late notifications stay with the step that caused them.
    const frames = [];
    server = appServer({ executable, env, cwd, frames });
    await server.request('initialize', initialize); server.notify('initialized');
    await server.request('thread/resume', { ...threadParams, threadId });
    done = server.waitFor(turnDone(threadId), 'resumed turn');
    await server.request('turn/start', turn(threadId, 'Say the next fixture reply.'));
    await done;

    // 3. The provider refuses because the plan's usage limit is used up.
    const limitStart = frames.length;
    done = server.waitFor(turnDone(threadId), 'usage-limit turn');
    await server.request('turn/start', turn(threadId, 'FLUJO_FIXTURE_USAGE_LIMIT'));
    await done;

    // 4. Fork after the first completed turn, as FLUJO does when history is restored.
    const forkStart = frames.length;
    const forkStarted = server.waitFor(message => message.method === 'thread/started'
      && message.params?.thread?.forkedFromId === threadId, 'fork start');
    await server.request('thread/fork', { ...threadParams, threadId, lastTurnId: firstTurn.turn.id, ephemeral: false });
    await forkStarted;
    await server.stop();
    sessions.push({ name: 'resume', frames: frames.slice(0, limitStart) },
      { name: 'usage-limit', frames: frames.slice(limitStart, forkStart) },
      { name: 'fork', frames: frames.slice(forkStart) });

    // Remove the machine name and install id the CLI reports for remote control.
    for (const { message } of sessions.flatMap(session => session.frames)) {
      if (message.method === 'remoteControl/status/changed' && message.params) {
        if ('serverName' in message.params) message.params.serverName = '<HOST>';
        if ('installationId' in message.params) message.params.installationId = '<INSTALLATION_ID>';
      }
    }
    const escape = value => JSON.stringify(value).slice(1, -1);
    let text = JSON.stringify({
      recordedWith: { cliVersion, sdkVersion, recordedAt: new Date().toISOString().slice(0, 10),
        provider: 'Local fixture Responses server on 127.0.0.1. No login, no account and no real model call.' },
      sessions,
    }, null, 1);
    for (const [value, placeholder] of [[cwd, '<WORKSPACE>'], [codexHome, '<CODEX_HOME>'], [home, '<HOME>'], [String(port), '<PORT>']]) {
      for (const spelling of new Set([escape(value), escape(value.replaceAll('\\', '/'))])) text = text.split(spelling).join(placeholder);
    }
    await fs.writeFile(output, text + '\n');
    return { output, cliVersion, sessions: sessions.map(session => [session.name, session.frames.length]) };
  } finally {
    provider.close();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recordCodexProtocol().then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}

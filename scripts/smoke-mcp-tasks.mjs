#!/usr/bin/env node
/** Production-only Tasks proof: real Next, owner issuer, private encryption and Flow engine.
 * The sole model is an owned loopback fixture. No operator credentials are inherited.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';
import { ensurePrivateDirectory } from './local-instance.mjs';

if (process.argv.slice(2).join(' ') !== '--production') throw new Error('Usage: smoke-mcp-tasks.mjs --production (build first)');
const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.access(path.join(application, '.next', 'BUILD_ID'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-tasks-smoke-'));
const runtimeApplication = path.join(root, 'application'), data = path.join(root, 'data');
const links = ['.next', 'node_modules', 'public', 'scripts'];
const workspace = 'default-workspace';
const answer = 'mcp-tasks-production-smoke-response', privateInput = 'private-mcp-task-input';
const password = randomBytes(32).toString('hex');
const clients = new Set();
const held = new Set();
let child, childClosed, operator, otherOperator, base, log = '', providerCalls = 0, holdProvider = false;

const provider = http.createServer(async (request, response) => {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 256 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer synthetic-smoke-key');
    providerCalls++;
    if (holdProvider) {
      held.add(response); response.once('close', () => held.delete(response)); return;
    }
    const info = { id: `tasks-smoke-${providerCalls}`, model: 'tasks-smoke-model', created: Math.floor(Date.now() / 1000) };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...info, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'The synthetic Tasks provider rejected the request.' } }));
  }
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function port() { const server = http.createServer(), value = await listen(server); await new Promise(resolve => server.close(resolve)); return value; }
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error(`Tasks smoke timed out: ${label}`);
}
function safeEnvironment() {
  const safe = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name) && value) safe[name] = value;
  }
  return { ...safe, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home', 'roaming'), LOCALAPPDATA: path.join(root, 'home', 'local'),
    XDG_CONFIG_HOME: path.join(root, 'home', 'config'), XDG_CACHE_HOME: path.join(root, 'home', 'cache'),
    TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp') };
}
async function api(endpoint, body, token = operator.token) {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `Tasks smoke API ${endpoint} returned ${response.status}`);
  return response.json();
}
async function stop() {
  for (const client of clients) { await client.close().catch(() => undefined); clients.delete(client); }
  if (!child) return;
  const owned = child, receipt = childClosed;
  if (owned.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', resolve); killer.once('exit', resolve);
      });
    } else {
      try { process.kill(-owned.pid, 'SIGTERM'); } catch { /* already closed */ }
      if (!await Promise.race([receipt.then(() => true), delay(5000).then(() => false)])) {
        try { process.kill(-owned.pid, 'SIGKILL'); } catch { /* already closed */ }
      }
    }
  }
  if (!await Promise.race([receipt.then(() => true), delay(5000).then(() => false)])) throw new Error('Owned Tasks server did not close; cleanup refused.');
  child = undefined;
}
async function start(enabled = true) {
  const value = await port(); base = `http://127.0.0.1:${value}`; log = '';
  child = spawn(process.execPath, [path.join(application, 'scripts', 'launch-next.mjs'), 'start', '-p', String(value), '-H', '127.0.0.1'], {
    cwd: runtimeApplication, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...safeEnvironment(), ...operator.env, FLUJO_DATA_DIR: data, FLUJO_APP_ROOT: runtimeApplication,
      FLUJO_BASE_URL: base, FLUJO_PORT: String(value), FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await port()),
      FLUJO_MCP_TASKS_SERVER: String(enabled), FLUJO_MCP_TASKS_CLIENT: 'true' },
  });
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => { log = `${log}\n${error.name}`.slice(-40000); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = `${log}${bytes}`.slice(-40000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error('Owned Tasks server exited during startup.');
    try {
      // A fresh private workspace is locked until the next step initializes its
      // encryption key. Readiness must use a route available before unlock.
      const response = await fetch(new URL('/api/encryption/secure', base), {
        method: 'POST', headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch { return false; }
  }, 'server readiness', 120000);
}
let taskEquipment;
async function equipment() {
  // Fixture compilation uses the real host adapter and pinned vendor packages.
  // The server under test remains the emitted production build, with no mocks.
  const filename = path.join(application, 'src/backend/services/mcp/tasksExtensionSession.ts');
  const source = await fs.readFile(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: filename }).outputText.replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) =>
    specifier.startsWith('node:') ? match : `from ${quote}${import.meta.resolve(specifier)}${quote}`);
  const destination = path.join(root, 'host-task-equipment.mjs');
  await fs.writeFile(destination, output, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ taskHostSourceSha256: createHash('sha256').update(source).digest('hex'),
    taskHostEquipment: 'compiled-production-source', smokeOwnerIssuerEquipment: operator.issuerEquipment }));
  taskEquipment = await import(pathToFileURL(destination).href);
}
async function connect({ token = operator.token, selectedWorkspace = workspace, form = true } = {}) {
  const url = new URL('/mcp-flows', base); url.searchParams.set('workspace', selectedWorkspace);
  const clientInfo = { name: 'flujo-tasks-production-smoke', version: '1.0.0' };
  const clientCapabilities = { roots: { listChanged: false }, ...(form ? { elicitation: { form: {} } } : {}) };
  const client = new Client(clientInfo, { capabilities: clientCapabilities, versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  taskEquipment.registerTasksExtensionClient(client, { endpointId: 'owned-production-flows', clientInfo, clientCapabilities,
    authorizeLateTaskCancellation: () => clients.has(client), isAuthorityCurrent: () => clients.has(client) });
  clients.add(client); await client.connect(transport);
  return { client, tasks: taskEquipment.getTasksExtensionSession(client) };
}
async function legacy() {
  const url = new URL('/mcp-flows', base); url.searchParams.set('workspace', workspace);
  const client = new LegacyClient({ name: 'flujo-legacy-tasks-smoke', version: '1.0.0' });
  clients.add(client);
  await client.connect(new LegacyTransport(url, { requestInit: { headers: { authorization: `Bearer ${operator.token}` } } }));
  const listed = await client.listTools(); assert.ok(listed.tools.some(tool => tool.name === 'tasks_smoke'));
  assert.equal(client.getServerCapabilities()?.tasks, undefined);
}
async function waitTask(tasks, id, status) {
  let task;
  await until(async () => {
    task = await tasks.getTask(id, { context: { requestTimeoutMs: 15000 } });
    if (['completed', 'failed', 'cancelled'].includes(task.status) && task.status !== status) {
      throw new Error(`Tasks smoke expected ${status}, received ${task.status} (${task.error?.message ?? 'terminal'}).`);
    }
    return task.status === status;
  }, `task ${status}`);
  return task;
}

try {
  await ensurePrivateDirectory(root);
  for (const name of ['application', 'data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  for (const name of ['roaming', 'local', 'config', 'cache']) await fs.mkdir(path.join(root, 'home', name));
  for (const name of links) await fs.symlink(path.join(application, name), path.join(runtimeApplication, name), process.platform === 'win32' ? 'junction' : 'dir');
  // Shipped-package admission rejects links, so exercise an actual distribution
  // directory while sharing only immutable build/dependency artifacts.
  await fs.cp(path.join(application, 'mcp-servers'), path.join(runtimeApplication, 'mcp-servers'), { recursive: true });
  for (const name of ['package.json', 'next.config.mjs']) await fs.copyFile(path.join(application, name), path.join(runtimeApplication, name));
  operator = await createSmokeOperator(); otherOperator = await createSmokeOperator();
  // Both grants use production issuance; combine before launch so policy revision is stable.
  const policy = JSON.parse(await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE, 'utf8'));
  const otherPolicy = JSON.parse(await fs.readFile(otherOperator.env.FLUJO_OWNER_AUTH_FILE, 'utf8'));
  policy.credentials.push(...otherPolicy.credentials);
  await fs.writeFile(operator.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify(policy), { mode: 0o600 });
  await equipment();
  const modelPort = await listen(provider);
  console.log('Starting private production Tasks server and creating the authored Flow through its APIs...');
  await start();
  assert.equal((await api('/api/encryption/secure', { action: 'initialize', password })).success, true);
  assert.equal((await api('/api/encryption/secure', { action: 'authenticate', password })).success, true);
  await api('/api/model', { id: 'tasks-smoke-model', name: 'tasks-smoke-model', provider: 'openai', adapter: 'openai',
    ApiKey: 'synthetic-smoke-key', baseUrl: `http://127.0.0.1:${modelPort}/v1` });
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} Node`, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'tasks-smoke-model', promptTemplate: 'Reply to the user.', inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  await api('/api/flow', { id: 'tasks-smoke-flow', name: 'Tasks Smoke', nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() });
  await api('/api/workspaces', { name: 'tasks-other' });
  await legacy();
  let main = await connect(); assert.ok(main.tasks); assert.equal(main.client.getNegotiatedProtocolVersion(), '2026-07-28');
  const task = await main.tasks.callTool({ name: 'tasks_smoke', arguments: { input: privateInput } });
  assert.equal(task.resultType, 'task');
  const completed = await waitTask(main.tasks, task.taskId, 'completed');
  assert.ok(JSON.stringify(completed.result).includes(answer)); assert.ok(providerCalls >= 1);
  const wrongCredential = await connect({ token: otherOperator.token });
  await assert.rejects(wrongCredential.tasks.getTask(task.taskId));
  const wrongWorkspace = await connect({ selectedWorkspace: 'tasks-other' });
  await assert.rejects(wrongWorkspace.tasks.getTask(task.taskId));
  const beforeConfirmation = providerCalls;
  const confirmation = await main.tasks.callTool({ name: 'tasks_smoke', arguments: { input: privateInput, confirm: true } });
  const input = await waitTask(main.tasks, confirmation.taskId, 'input_required');
  assert.equal(providerCalls, beforeConfirmation);
  assert.equal(input.inputRequests.confirmation.method, 'elicitation/create');
  await Promise.all([main.tasks.updateTask(confirmation.taskId, { confirmation: { action: 'accept', content: { confirmed: true } } }),
    main.tasks.updateTask(confirmation.taskId, { confirmation: { action: 'accept', content: { confirmed: true } } })]);
  await waitTask(main.tasks, confirmation.taskId, 'completed'); assert.equal(providerCalls, beforeConfirmation + 1);
  const declined = await main.tasks.callTool({ name: 'tasks_smoke', arguments: { input: privateInput, confirm: true } });
  await waitTask(main.tasks, declined.taskId, 'input_required');
  await main.tasks.updateTask(declined.taskId, { confirmation: { action: 'decline' } });
  await waitTask(main.tasks, declined.taskId, 'completed'); assert.equal(providerCalls, beforeConfirmation + 1);
  console.log('Authored Flow, encrypted results, confirmation, input idempotence and owner/workspace fences passed.');
  holdProvider = true;
  const cancelled = await main.tasks.callTool({ name: 'tasks_smoke', arguments: { input: privateInput } });
  await until(() => held.size === 1, 'provider cancellation boundary');
  await main.tasks.cancelTask(cancelled.taskId);
  await waitTask(main.tasks, cancelled.taskId, 'cancelled');
  await until(() => held.size === 0, 'actual provider AbortSignal propagation');
  const interrupted = await main.tasks.callTool({ name: 'tasks_smoke', arguments: { input: privateInput } });
  await until(() => held.size === 1, 'provider restart boundary');
  const beforeRestart = providerCalls;
  await stop(); await until(() => held.size === 0, 'provider closed with process receipt'); holdProvider = false;
  await start();
  assert.equal((await api('/api/encryption/secure', { action: 'authenticate', password })).success, true);
  main = await connect(); assert.ok(main.tasks);
  assert.deepEqual((await waitTask(main.tasks, task.taskId, 'completed')).result, completed.result);
  assert.equal((await waitTask(main.tasks, interrupted.taskId, 'failed')).error.message, 'TASK_INTERRUPTED');
  assert.equal(providerCalls, beforeRestart, 'Restart must never replay an authored task');
  const ledger = await fs.readFile(path.join(data, '.mcp-server-tasks', 'ledger.json'), 'utf8');
  for (const secret of [operator.token, otherOperator.token, password, privateInput, answer, 'synthetic-smoke-key']) assert.ok(!ledger.includes(secret));
  await stop(); await start(false);
  await legacy();
  const disabled = await connect(); assert.equal(disabled.tasks, undefined);
  assert.equal(disabled.client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/tasks'], undefined);
  assert.equal(providerCalls, beforeRestart);
  console.log('PASS: production authored Flow Tasks, official modern client/extension, private results, confirmation/input idempotence, cancellation, owner/workspace fences, restart without replay, legacy and disabled feature.');
} catch (error) {
  // Fixture secrets stay out of diagnostics, even if framework logs echoed input.
  let diagnostic = `${error?.stack ?? error}\n${log.slice(-10000)}`;
  for (const secret of [operator?.token, otherOperator?.token, password, privateInput, 'synthetic-smoke-key']) {
    if (secret) diagnostic = diagnostic.split(secret).join('[synthetic-secret]');
  }
  console.error(diagnostic); process.exitCode = 1;
} finally {
  const errors = [];
  try { await stop(); } catch (error) { errors.push(error); }
  provider.closeAllConnections();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
  for (const issued of [otherOperator, operator]) { try { await issued?.restore(); } catch (error) { errors.push(error); } }
  if (!child) {
    try {
      for (const name of links) {
        const filename = path.join(runtimeApplication, name);
        try {
          const stat = await fs.lstat(filename);
          if (!stat.isSymbolicLink() || await fs.realpath(filename) !== await fs.realpath(path.join(application, name))) throw new Error('Owned smoke link identity changed; cleanup refused.');
          await fs.unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const resolved = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), resolved);
      if (path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('flujo-mcp-tasks-smoke-')
        || (await fs.lstat(resolved)).isSymbolicLink()) throw new Error('Unsafe Tasks smoke cleanup path.');
      await fs.rm(resolved, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Tasks smoke cleanup failed.');
}

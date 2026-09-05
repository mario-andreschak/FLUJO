#!/usr/bin/env node
/** Real Next/engine/MCP smoke. --production tests the packaged Docker application. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkHealth } from './healthcheck.mjs';

const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
if (process.argv.slice(2).some(argument => argument !== '--production')) throw new Error('Usage: smoke-cloud-worker.mjs [--production]');
const packageJson = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-cloud-worker-smoke-'));
const runtimeApplication = production ? application : path.join(root, 'application');
const overlayLinks = ['public', 'mcp-servers', 'node_modules', 'scripts'];
const workspace = 'cloud-smoke';
const conversationId = 'cloud-smoke-conversation';
const answer = 'cloud-worker-smoke-response';
const sourceWorkspaceRoot = 'C:\\synthetic-source\\workspaces\\cloud-smoke';
const sourceFilesystemRoot = `${sourceWorkspaceRoot}\\mcp-servers\\filesystem`;
const subtrees = ['db', 'mcp-servers', 'userdata', 'snapshots', 'screenshots', 'recordings', 'browser-profile', 'bash-utils', 'artifacts'];
const controlToken = randomBytes(32).toString('hex');
const key = randomBytes(32);
const sha256 = value => createHash('sha256').update(value).digest('hex');
let child;
let childClosed;
let childLog = '';
let providerCalls = 0;

const modelServer = http.createServer(async (request, response) => {
  try {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer synthetic-smoke-key');
    providerCalls++;
    const base = { id: `smoke-${providerCalls}`, created: Math.floor(Date.now() / 1000), model: 'cloud-smoke-model' };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `Smoke provider rejected request: ${error.message}` } }));
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopChild() {
  if (!child) return;
  const stopped = child;
  const closed = childClosed;
  child = undefined;
  if (stopped.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(stopped.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', resolve);
        killer.once('exit', resolve);
      });
    } else {
      try { process.kill(-stopped.pid, 'SIGTERM'); } catch { /* already stopped */ }
      const exited = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]);
      if (!exited) { try { process.kill(-stopped.pid, 'SIGKILL'); } catch { /* already stopped */ } }
    }
  }
  await Promise.race([closed, delay(5_000)]);
}

function safeEnvironment() {
  // Do not inherit model keys, CLI auth homes, FLUJO settings, or user NODE_OPTIONS.
  const safe = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name) && value) safe[name] = value;
  }
  return { ...safe, NODE_ENV: production ? 'production' : 'development', NEXT_TELEMETRY_DISABLED: '1',
    ...(production ? { FLUJO_CONTAINER: '1', FLUJO_BUILD_REVISION: process.env.FLUJO_BUILD_REVISION } : {}),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp') };
}

async function startWorker(port, archivePath, archiveHash, harness) {
  childLog = '';
  const sandboxPort = await unusedPort();
  const args = production
    ? [path.join(application, 'scripts', 'launch-next.mjs'), 'start', '-p', String(port), '-H', '127.0.0.1']
    : [harness];
  child = spawn(process.execPath, args, {
    cwd: runtimeApplication, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...safeEnvironment(), FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: archivePath,
      FLUJO_WORKER_SNAPSHOT_SHA256: archiveHash, FLUJO_WORKER_SNAPSHOT_KEY: key.toString('base64'),
      FLUJO_SNAPSHOT_CONTROL_TOKEN: controlToken, FLUJO_DATA_DIR: path.join(root, 'data'),
      FLUJO_APP_ROOT: runtimeApplication,
      FLUJO_PORT: String(port), FLUJO_BASE_URL: `http://127.0.0.1:${port}`,
      FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1',
      FLUJO_EXPOSURE_MODE: 'localhost', SMOKE_PORT: String(port) },
  });
  childClosed = new Promise(resolve => child.once('exit', resolve));
  child.on('error', error => { childLog += `\n${error.message}`; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { childLog = (childLog + data.toString()).slice(-80_000); });
  const started = Date.now();
  let lastState;
  while (Date.now() - started < 240_000) {
    if (child.exitCode !== null) throw new Error(`Worker exited during startup (${child.exitCode}).`);
    try {
      const result = await fetch(`http://127.0.0.1:${port}/api/worker/status`, { headers: { authorization: `Bearer ${controlToken}` }, signal: AbortSignal.timeout(15_000) });
      if (result.status === 404) throw new Error('Worker status route unavailable in the smoke application.');
      const state = await result.json();
      lastState = state;
      if (state.state === 'error') throw new Error(`Worker reported bootstrap failure: ${state.error}`);
      if (result.ok && state.state === 'ready') return state;
    } catch (error) {
      if (/bootstrap failure|status route unavailable/.test(String(error.message))) throw error;
    }
    await delay(500);
  }
  throw new Error(`Worker did not become ready: ${JSON.stringify(lastState)}`);
}

try {
  for (const name of ['home', 'temp']) await fs.mkdir(path.join(root, name));
  // Next's programmatic custom server ignores conf.distDir in dev startup.
  // A private app overlay keeps its cache/lock/config writes away from any
  // concurrently running user server, without copying dependencies or secrets.
  if (!production) {
    await fs.mkdir(runtimeApplication);
    // Next's route discovery does not walk a junctioned src directory on Windows.
    // Copy only repository source code; runtime workspaces and .env files are absent.
    await fs.cp(path.join(application, 'src'), path.join(runtimeApplication, 'src'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts',
      'postcss.config.mjs', 'postcss.config.js', 'tailwind.config.ts', 'tailwind.config.js']) {
      try { await fs.copyFile(path.join(application, name), path.join(runtimeApplication, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const name of overlayLinks) {
      await fs.symlink(path.join(application, name), path.join(runtimeApplication, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  const modelPort = await listen(modelServer);
  const workerPort = await unusedPort();
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type[0].toUpperCase()}${type.slice(1)} Node`, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'smoke-model', promptTemplate: 'Reply to the user.', inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  const flow = { id: 'smoke-flow', name: 'CloudSmoke', nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() };
  const files = {
    'db/mcp_servers.json': JSON.stringify({ filesystem: {
      name: 'filesystem', transport: 'stdio', command: 'node',
      args: [`${sourceFilesystemRoot}\\dist\\index.js`], rootPath: sourceFilesystemRoot,
      env: {}, roots: [`${sourceWorkspaceRoot}\\userdata`], disabled: false,
      exposeAsMcpServer: true, source: { type: 'marketplace', id: '@mario.andreschak/mcp-filesystem' },
    } }),
    'db/models.json': JSON.stringify([{ id: 'smoke-model', name: 'cloud-smoke-model', provider: 'openai', adapter: 'openai', ApiKey: 'synthetic-smoke-key', baseUrl: `http://127.0.0.1:${modelPort}/v1` }]),
    'db/flows/smoke-flow.json': JSON.stringify(flow),
    'userdata/mcp-smoke-input.txt': 'restored filesystem smoke input',
  };
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  zip.file('snapshot-manifest.json', JSON.stringify({ formatVersion: 2, layoutVersion: 2, workspace, generation: 0,
    createdAt: new Date().toISOString(), coherence: 'registered-flujo-writers', externalRootsIncluded: false, subtrees,
    files: Object.entries(files).map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: sha256(content) })),
    source: { version: packageJson.version, platform: process.platform },
    runtime: { codexAuth: 'none', encryption: 'default', mcpTransfer: { formatVersion: 1, sourceWorkspaceRoot,
      servers: [{ name: 'filesystem', kind: 'bundled', sourceRootPath: sourceFilesystemRoot }] } },
  }));
  const plaintext = await zip.generateAsync({ type: 'nodebuffer' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const archivePath = path.join(root, 'worker.snapshot');
  await fs.writeFile(archivePath, JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  const harness = path.join(root, 'next-harness.mjs');
  if (!production) await fs.writeFile(harness, `import {createRequire} from 'node:module';
import http from 'node:http';
const require=createRequire(${JSON.stringify(path.join(runtimeApplication, 'package.json'))});
const next=require('next');
const app=next({dev:true,dir:${JSON.stringify(runtimeApplication)},webpack:true});
const handler=app.getRequestHandler();
await app.prepare();
const server=http.createServer((req,res)=>handler(req,res));
server.listen(Number(process.env.SMOKE_PORT),'127.0.0.1');
`);
  console.log(`Starting ${production ? 'packaged production' : 'isolated development'} worker with an encrypted synthetic snapshot...`);
  const ready = await startWorker(workerPort, archivePath, sha256(plaintext), harness);
  assert.equal(ready.workspace, workspace);
  assert.deepEqual(ready.servers, [{ name: 'filesystem', status: 'ready' }]);
  assert.equal(await checkHealth({ env: { FLUJO_WORKER_MODE: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: controlToken, FLUJO_PORT: String(workerPort) } }), true);
  assert.equal(await checkHealth({ env: { FLUJO_WORKER_MODE: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'incorrect-synthetic-token', FLUJO_PORT: String(workerPort) } }), false);
  assert.equal(providerCalls, 0, 'Bootstrap must not execute flows.');
  for (const route of ['/api/worker/status', '/api/env', '/api/snapshot/info', '/v1/chat/completions', '/mcp-flows', '/mcp-proxy/filesystem']) {
    const result = await fetch(`http://127.0.0.1:${workerPort}${route}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(result.status, 401, `Unauthenticated ${route} must be denied.`);
  }
  const infoResponse = await fetch(`http://127.0.0.1:${workerPort}/api/snapshot/info?workspace=${workspace}`, {
    headers: { authorization: `Bearer ${controlToken}` }, signal: AbortSignal.timeout(15_000),
  });
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.deepEqual(info.workerCompatibility, {
    applicationVersion: packageJson.version, snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1,
    ...(production && /^[a-f0-9]{40}$/.test(process.env.FLUJO_BUILD_REVISION ?? '') ? { revision: process.env.FLUJO_BUILD_REVISION } : {}),
  });
  const filesystem = new Client({ name: 'flujo-worker-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await filesystem.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${workerPort}/mcp-proxy/filesystem?workspace=${workspace}`), {
      requestInit: { headers: { authorization: `Bearer ${controlToken}` } },
    }));
    const targetRoot = path.join(root, 'data', 'workspaces', workspace, 'userdata');
    const allowed = await filesystem.callTool({ name: 'get_allowed_directories', arguments: {} });
    assert.notEqual(allowed.isError, true);
    assert.ok(allowed.structuredContent?.directories?.includes(targetRoot), 'MCP roots must move from the Windows snapshot to this worker.');
    const read = await filesystem.callTool({ name: 'read_file', arguments: { path: path.join(targetRoot, 'mcp-smoke-input.txt') } });
    assert.notEqual(read.isError, true);
    assert.ok(JSON.stringify(read).includes('restored filesystem smoke input'));
    const written = await filesystem.callTool({ name: 'write_file', arguments: { path: path.join(targetRoot, 'mcp-smoke-output.txt'), content: 'worker MCP write succeeded' } });
    assert.notEqual(written.isError, true);
    assert.equal(await fs.readFile(path.join(targetRoot, 'mcp-smoke-output.txt'), 'utf8'), 'worker MCP write succeeded');
  } finally {
    await filesystem.close();
  }
  const result = await fetch(`http://127.0.0.1:${workerPort}/v1/chat/completions?workspace=${workspace}`, {
    method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'flow-CloudSmoke', stream: false, messages: [{ role: 'user', content: 'Run the smoke flow.' }],
      metadata: { conversationId, flujo: 'true' } }), signal: AbortSignal.timeout(180_000),
  });
  const completion = await result.json();
  assert.equal(result.status, 200, `Flow failed: ${JSON.stringify(completion)}`);
  assert.equal(completion.choices?.[0]?.message?.content, answer);
  assert.ok(providerCalls >= 1, 'The real engine must reach the loopback mock model.');
  const conversationFile = path.join(root, 'data', 'workspaces', workspace, 'db', 'conversations', `${conversationId}.json`);
  const saved = await fs.readFile(conversationFile, 'utf8');
  const conversation = JSON.parse(saved);
  assert.equal(conversation.flowId, flow.id);
  assert.equal(conversation.unattended, true, 'A cloud worker must use unattended engine behavior.');
  assert.ok(saved.includes(answer), 'The conversation must contain the engine result.');
  const callsBeforeRestart = providerCalls;
  console.log('HTTP auth, real flow execution, and conversation persistence passed; restarting worker...');
  await stopChild();
  await startWorker(workerPort, archivePath, sha256(plaintext), harness);
  assert.equal(await fs.readFile(conversationFile, 'utf8'), saved, 'Restart must preserve worker results.');
  assert.equal(await fs.readFile(path.join(root, 'data', 'workspaces', workspace, 'userdata', 'mcp-smoke-output.txt'), 'utf8'), 'worker MCP write succeeded');
  assert.equal(providerCalls, callsBeforeRestart, 'Restart must not replay the completed flow.');
  console.log('PASS: encrypted restore, compatibility metadata, private ingress, restored MCP read/write, real ExecutionEngine/model dispatch, unattended flow, and restart preservation.');
} catch (error) {
  console.error(error.stack ?? error.message);
  if (childLog) console.error(childLog.slice(-16_000));
  process.exitCode = 1;
} finally {
  await stopChild();
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
  const expectedPrefix = path.join(os.tmpdir(), 'flujo-cloud-worker-smoke-');
  if (!path.resolve(root).startsWith(path.resolve(expectedPrefix))) throw new Error('Refusing unsafe smoke cleanup path.');
  for (const name of production ? [] : overlayLinks) {
    const link = path.join(runtimeApplication, name);
    const stat = await fs.lstat(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) await fs.unlink(link);
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}

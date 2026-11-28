/**
 * #1423: sandbox cleanup is asynchronous end to end. These tests drive the real
 * launch, transport, isolation and application shutdown code against a
 * stand-in Docker program, so the sandboxed server, its worker process and the
 * private control folder are real; only the daemon is a small state file.
 *
 * Covered: normal exit (the app's shutdown hook), Ctrl+C (the real SIGINT
 * handler armed by startup), a crash of the server (it dies by itself), a crash
 * of FLUJO itself (a separate process is killed and the next start cleans up
 * after it) and a restart (a new launch of the same server while its
 * predecessor is removed).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPStdioConfig } from '@/shared/types/mcp';

jest.mock('@/backend/services/security/isolatedMcpInspection', () => ({
  ...jest.requireActual('@/backend/services/security/isolatedMcpInspection'),
  // The stand-in daemon has no full container record; inspection has its own tests.
  assertIsolatedMcpContainerInspection: jest.fn(),
}));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => undefined),
  saveItem: jest.fn(),
  // Startup stops right after it arms the process shutdown hooks.
  verifyStorage: jest.fn(async () => { throw new Error('Startup stops after arming shutdown hooks.'); }),
}));
jest.mock('@/backend/services/workspace/migration', () => ({ migrateWorkspaceLayout: jest.fn(async () => undefined) }));

import { loadServerConfigs } from '@/backend/services/mcp/config';
import { createStdioTransport } from '@/backend/services/mcp/connection';
import { getManagedMcpIsolation } from '@/backend/services/mcp/isolation';
import { _resetLifecycleForTests, markConnected } from '@/backend/services/mcp/lifecycleCoordinator';
import { isolatedMcpPolicyDigest } from '@/backend/services/security/isolatedMcp';
import { ensureBackendInitialized, shutdownBackendServices } from '@/backend/init';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';

// The stand-in Docker program must be an executable named `docker`. Windows
// runs only real executables by that name, so these process tests are POSIX only;
// the asynchronous Docker calls themselves are covered on every platform in
// __tests__/security/isolatedMcp.test.ts.
const posix = process.platform === 'win32' ? describe.skip : describe;

interface DaemonContainer { id: string; name: string; labels: Record<string, string>; pids: number[] }
interface Sandbox {
  client: Client;
  closed: Promise<void>;
  containerId: string;
  controlDir: string;
  pids: number[];
}

const fakeDocker = (node: string) => `#!${node}
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const stateFile = path.join(__dirname, 'daemon.json');
const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { containers: [] }; } };
const write = state => { fs.writeFileSync(stateFile + '.next', JSON.stringify(state)); fs.renameSync(stateFile + '.next', stateFile); };
const operation = process.argv.slice(6);
const out = text => { process.stdout.write(text); process.exit(0); };
const fail = text => { process.stderr.write(text); process.exit(1); };
const after = flag => operation.flatMap((value, index) => operation[index - 1] === flag ? [value] : []);
const running = pid => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\\s+Z/m.test(fs.readFileSync('/proc/' + pid + '/status', 'utf8')); } catch { return true; }
};
// Like Docker: created until started, running while its main process runs, then exited.
const status = container => !container.pids.length ? 'created' : running(container.pids[0]) ? 'running' : 'exited';
if (operation[0] === 'info') out(JSON.stringify({ OSType: 'linux', SecurityOptions: [], MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true }));
if (operation[0] === 'image') out(JSON.stringify({ Id: operation[2], Config: { Volumes: null } }));
const verb = operation[1];
if (verb === 'create') {
  const state = read();
  const name = operation[operation.indexOf('--name') + 1];
  const labels = Object.fromEntries(after('--label').map(label => [label.slice(0, label.indexOf('=')), label.slice(label.indexOf('=') + 1)]));
  fs.appendFileSync(path.join(__dirname, 'creates.log'), (labels['co.flujo.mcp-control'] ?? '') + '\\n');
  if (state.containers.some(container => container.name === name)) fail('Conflict: the name is in use');
  const id = crypto.randomBytes(32).toString('hex');
  state.containers.push({ id, name, labels, pids: [] });
  write(state);
  out(id + '\\n');
}
if (verb === 'ls') {
  // Different filter keys must all match; several status filters match any one of them.
  const filters = after('--filter');
  const statuses = filters.filter(filter => filter.startsWith('status=')).map(filter => filter.slice('status='.length));
  const matches = (container, filter) => {
    if (filter.startsWith('status=')) return statuses.includes(status(container));
    if (filter.startsWith('label=')) {
      const label = filter.slice('label='.length);
      return container.labels[label.slice(0, label.indexOf('='))] === label.slice(label.indexOf('=') + 1);
    }
    return filter === 'id=' + container.id || filter === 'name=^/' + container.name + '$';
  };
  const format = operation[operation.indexOf('--format') + 1];
  const row = container => ['co.flujo.mcp-generation', 'co.flujo.mcp-control'].reduce(
    (line, label) => line.split('{{.Label "' + label + '"}}').join(container.labels[label] ?? ''), format.split('{{.ID}}').join(container.id));
  out(read().containers.filter(container => filters.every(filter => matches(container, filter))).map(container => row(container) + '\\n').join(''));
}
if (verb === 'inspect') out(JSON.stringify({ Id: operation[2] }));
if (verb === 'rm') {
  if (fs.existsSync(path.join(__dirname, 'slow-removal'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  const id = operation[operation.length - 1];
  const state = read();
  const container = state.containers.find(candidate => candidate.id === id);
  if (container && status(container) === 'running' && !operation.includes('--force')) fail('You cannot remove a running container');
  for (const pid of container?.pids ?? []) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  state.containers = state.containers.filter(container => container.id !== id);
  write(state);
  out(id + '\\n');
}
if (verb === 'start') {
  const id = operation[operation.length - 1];
  const state = read();
  const container = state.containers.find(candidate => candidate.id === id);
  if (!container) process.exit(125);
  const worker = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  container.pids = [process.pid, worker.pid];
  write(state);
  const reply = (message, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  const lines = require('readline').createInterface({ input: process.stdin });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    if (message.method === 'initialize') return reply(message, { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'sandbox-stand-in', version: '1.0.0' } });
    if (message.method === 'tools/list') return reply(message, { tools: [] });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported' } }) + '\\n');
  });
  // The server ends when its input closes, and the container's other processes end with it.
  lines.on('close', () => { try { process.kill(worker.pid, 'SIGKILL'); } catch {} process.exit(0); });
}
`;

let fixture: string;
let bin: string;
let config: MCPStdioConfig;
let saved: Record<string, string | undefined>;
const signalListeners = new Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>();
/** FLUJO stand-in processes and the control folders they made, removed even when a test fails. */
const hosts: Array<{ pid?: number; controlDir?: string }> = [];

const daemon = (): { containers: DaemonContainer[] } => {
  try { return JSON.parse(fs.readFileSync(path.join(bin, 'daemon.json'), 'utf8')); } catch { return { containers: [] }; }
};
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // An exited child of a reaped-late parent is a zombie: it can no longer run.
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
}
async function eventually(check: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
}

async function connect(register: boolean): Promise<Sandbox> {
  const transport = await createStdioTransport(config);
  const client = new Client({ name: 'sandbox-shutdown-test', version: '1.0.0' });
  const closed = new Promise<void>(resolve => { client.onclose = () => resolve(); });
  await client.connect(transport);
  const managed = getManagedMcpIsolation(transport)!;
  const container = daemon().containers.find(candidate => candidate.id === managed.launch.containerId)!;
  expect(container.pids).toHaveLength(2);
  for (const pid of container.pids) expect(alive(pid)).toBe(true);
  expect(fs.existsSync(managed.launch.cwd)).toBe(true);
  if (register) {
    global.__mcp_clients!.set(config.name, client);
    markConnected(config.name);
  }
  return { client, closed, containerId: managed.launch.containerId, controlDir: managed.launch.cwd, pids: container.pids };
}

async function expectCleanedUp(sandbox: Sandbox) {
  await new Promise(resolve => { setImmediate(resolve); });
  // FLUJO removes the container before it closes the server's input, and removal stops every process in it.
  await eventually(() => sandbox.pids.every(pid => !alive(pid)), 'the sandboxed processes to stop');
  expect(daemon().containers.map(container => container.id)).not.toContain(sandbox.containerId);
  expect(fs.existsSync(sandbox.controlDir)).toBe(false);
  expect(global.__flujo_mcp_isolated_generations?.size ?? 0).toBe(0);
  expect(global.__flujo_mcp_authority_retirements?.size ?? 0).toBe(0);
}

posix('sandbox cleanup through the real shutdown paths', () => {
  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-sandbox-shutdown-'));
    bin = path.join(fixture, 'bin');
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'docker'), fakeDocker(process.execPath), { mode: 0o700 });
    saved = { FLUJO_MCP_ISOLATION_FILE: process.env.FLUJO_MCP_ISOLATION_FILE, FLUJO_OWNER_AUTH_FILE: process.env.FLUJO_OWNER_AUTH_FILE };
    process.env.FLUJO_MCP_ISOLATION_FILE = path.join(fixture, 'approvals.json');
    process.env.FLUJO_OWNER_AUTH_FILE = path.join(fixture, 'owner.json');
    config = { name: 'sandbox-fixture', transport: 'stdio', command: 'node', args: ['server.js'], disabled: false,
      env: {}, rootPath: '', _buildCommand: '', _installCommand: '',
      isolation: { schemaVersion: 1, kind: 'docker-deny-egress', image: `sha256:${'a'.repeat(64)}`,
        dockerExecutable: path.join(bin, 'docker'), daemon: 'unix:///var/run/docker.sock', command: ['node', 'server.js'],
        environmentNames: [], mounts: [], memoryMiB: 128, cpus: 0.5, pidsLimit: 32 },
    };
    fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'approved-owner', credentials: [] }), { mode: 0o600 });
    fs.writeFileSync(process.env.FLUJO_MCP_ISOLATION_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'approved-owner',
      approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name, policyDigest: isolatedMcpPolicyDigest(config.isolation),
        expiresAt: Date.now() + 120_000 }] }), { mode: 0o600 });
    jest.mocked(loadServerConfigs).mockReset().mockResolvedValue([config]);
    global.__flujo_mcp_isolated_generations?.clear();
    global.__mcp_clients?.clear();
    global.__flujo_shutdown_promise = undefined;
    _resetLifecycleForTests();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) signalListeners.set(signal, new Set(process.listeners(signal)));
  });

  afterEach(async () => {
    // Remove only what this test armed; never run a stray handler.
    for (const [signal, before] of signalListeners) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
    global.__flujo_shutdown_hooks_registered = undefined;
    global.__flujo_shutdown_promise = undefined;
    jest.restoreAllMocks();
    for (const container of daemon().containers) for (const pid of container.pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    for (const host of hosts.splice(0)) {
      if (host.pid) { try { process.kill(host.pid, 'SIGKILL'); } catch { /* already stopped */ } }
      if (host.controlDir && /^flujo-mcp-isolation-[A-Za-z0-9]+$/.test(path.relative(os.tmpdir(), host.controlDir))) {
        fs.rmSync(host.controlDir, { recursive: true, force: true });
      }
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (!/^flujo-sandbox-shutdown-[A-Za-z0-9]+$/.test(path.relative(os.tmpdir(), fixture))) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  test('normal exit: the application shutdown removes the sandbox, its processes and its control folder', async () => {
    const sandbox = await connect(true);
    await shutdownBackendServices('normal exit');
    await expectCleanedUp(sandbox);
    await sandbox.closed;
  }, 30_000);

  test('Ctrl+C: the SIGINT handler armed by startup finishes the same cleanup before it exits', async () => {
    await expect(ensureBackendInitialized()).rejects.toThrow('Startup stops after arming shutdown hooks.');
    const armed = process.listeners('SIGINT').filter(listener => !signalListeners.get('SIGINT')!.has(listener));
    expect(armed).toHaveLength(1);
    const sandbox = await connect(true);
    // What is left at the moment the handler exits the process.
    const atExit = new Promise<{ code: unknown; containers: string[]; controlFolder: boolean }>(resolve => {
      jest.spyOn(process, 'exit').mockImplementation(code => {
        resolve({ code, containers: daemon().containers.map(container => container.id), controlFolder: fs.existsSync(sandbox.controlDir) });
        return undefined as never;
      });
    });
    armed[0]('SIGINT');
    expect(await atExit).toEqual({ code: 0, containers: [], controlFolder: false });
    await expectCleanedUp(sandbox);
  }, 30_000);

  test('crash of FLUJO itself: the next start removes the stopped sandbox and the control folder left behind', async () => {
    // Same key as the launch path: the workspace folder and the server name.
    const workspaceRoot = path.resolve(getWorkspaceDataDir());
    const key = createHash('sha256').update(JSON.stringify([workspaceRoot, config.name])).digest('hex');
    const host = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'sandboxCrashHost.cjs'), JSON.stringify(config.isolation), workspaceRoot, key],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    hosts.push({ pid: host.pid });
    const [line] = await Promise.race([
      readline.createInterface({ input: host.stdout! })[Symbol.asyncIterator]().next().then(next => [next.value as string]),
      new Promise<never>((_, reject) => { host.once('exit', code => reject(new Error(`The FLUJO stand-in stopped early (${code}).`))); }),
    ]);
    const crashed = JSON.parse(line) as { containerId: string; controlDir: string };
    hosts[hosts.length - 1].controlDir = crashed.controlDir;
    await eventually(() => daemon().containers.find(container => container.id === crashed.containerId)?.pids.length === 2, 'the sandbox to start');
    const orphaned = daemon().containers.find(container => container.id === crashed.containerId)!.pids;
    const exited = new Promise(resolve => { host.once('exit', resolve); });
    host.kill('SIGKILL');
    await exited;
    // Its pipe to the server closed with it: the sandbox stopped, but nothing removed it.
    await eventually(() => orphaned.every(pid => !alive(pid)), 'the orphaned sandbox to stop');
    expect(daemon().containers.map(container => container.id)).toEqual([crashed.containerId]);
    expect(fs.existsSync(crashed.controlDir)).toBe(true);
    const restarted = await connect(true);
    expect(daemon().containers.map(container => container.id)).toEqual([restarted.containerId]);
    expect(fs.existsSync(crashed.controlDir)).toBe(false);
    await shutdownBackendServices('exit after a start that followed a crash');
    await expectCleanedUp(restarted);
  }, 30_000);

  test('a still running sandbox under the same name is never removed by a start', async () => {
    const live = await connect(false);
    // Forget it without any cleanup, as a second process sharing the name would.
    global.__flujo_mcp_isolated_generations!.clear();
    await expect(createStdioTransport(config)).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
    expect(daemon().containers.map(container => container.id)).toEqual([live.containerId]);
    for (const pid of live.pids) expect(alive(pid)).toBe(true);
    expect(fs.existsSync(live.controlDir)).toBe(true);
    // The refused start leaves no control folder of its own behind.
    const refused = fs.readFileSync(path.join(bin, 'creates.log'), 'utf8').trim().split('\n').at(-1)!;
    expect(refused).toMatch(/^flujo-mcp-isolation-[A-Za-z0-9]+$/);
    expect(path.join(os.tmpdir(), refused)).not.toBe(live.controlDir);
    expect(fs.existsSync(path.join(os.tmpdir(), refused))).toBe(false);
    await live.client.close();
    await expectCleanedUp(live);
  }, 30_000);

  test('crash of a server: one that dies by itself is removed without a caller, and shutdown waits for that removal', async () => {
    const sandbox = await connect(false);
    fs.writeFileSync(path.join(bin, 'slow-removal'), '');
    process.kill(sandbox.pids[0], 'SIGKILL');
    await sandbox.closed;
    // The SDK reported the close synchronously; the removal is still running.
    expect(daemon().containers.map(container => container.id)).toContain(sandbox.containerId);
    expect(global.__flujo_mcp_isolated_generations?.size).toBe(1);
    await shutdownBackendServices('exit after a crash');
    await expectCleanedUp(sandbox);
  }, 30_000);

  test('restart: a new launch of the same server waits for its predecessor removal instead of refusing', async () => {
    const first = await connect(false);
    fs.writeFileSync(path.join(bin, 'slow-removal'), '');
    process.kill(first.pids[0], 'SIGKILL');
    await first.closed;
    expect(daemon().containers.map(container => container.id)).toContain(first.containerId);
    // The predecessor still holds the container name; the new launch waits for it.
    const second = await connect(true);
    expect(second.containerId).not.toBe(first.containerId);
    expect(daemon().containers.map(container => container.id)).toEqual([second.containerId]);
    expect(fs.existsSync(first.controlDir)).toBe(false);
    for (const pid of first.pids) expect(alive(pid)).toBe(false);
    fs.unlinkSync(path.join(bin, 'slow-removal'));
    await shutdownBackendServices('exit after a restart');
    await expectCleanedUp(second);
  }, 30_000);
});

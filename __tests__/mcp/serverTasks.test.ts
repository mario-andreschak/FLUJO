import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { ServerTaskStore, type ServerTaskView } from '@/backend/services/mcp/serverTasks';
import type { OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { runWithWorkspace } from '@/utils/workspace';
import { writeFileAtomic } from '@/utils/storage/backend';
import * as storageBackend from '@/utils/storage/backend';

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual<typeof import('@/utils/storage/backend')>('@/utils/storage/backend');
  return { ...actual, writeFileAtomic: jest.fn(actual.writeFileAtomic) };
});

// Exercise actual filesystem and authenticated payload encryption without creating
// a real user's workspace keyring or requiring their unlock material.
jest.mock('@/utils/encryption/secure', () => {
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const key = crypto.randomBytes(32);
  return {
    _testKey: key.toString('hex'),
    encryptWithPassword: jest.fn(async (text: string) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `v2:${Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64')}`;
    }),
    decryptWithPassword: jest.fn(async (text: string) => {
      const data = Buffer.from(text.slice(3), 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }),
  };
});

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const inputRequests = { approval: { method: 'elicitation/create' as const,
  params: { mode: 'form' as const, message: 'Approve private-operation-label', requestedSchema: { type: 'object' as const, properties: {} } } } };
const response = { approval: { action: 'accept' as const, content: { secret: 'elicited-private-value' } } };
const childSource = `
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const crypto = require('node:crypto'), key = Buffer.from(process.env.TASK_TEST_KEY, 'hex');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === '@/utils/encryption/secure') return {
    encryptWithPassword: async text => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return 'v2:' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    },
    decryptWithPassword: async text => {
      const data = Buffer.from(text.slice(3), 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
  return originalLoad.call(this, request, ...args);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  return originalResolve.call(this, request.startsWith('@/') ? path.join(process.cwd(), 'src', request.slice(2)) : request, ...args);
};
require.extensions['.ts'] = function(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  }, fileName: filename }).outputText, filename);
};
const { ServerTaskStore } = require('@/backend/services/mcp/serverTasks');
const { runWithWorkspace } = require('@/utils/workspace');
const auth = { principal: { ownerId: 'owner', credentialId: 'credential', policyRevision: 'revision',
  expiresAt: Number(process.env.TASK_TEST_EXPIRY), scopes: ['mcp:access', 'control:admin', 'secrets:read'] }, recheck: () => null };
const keepAlive = setInterval(() => {}, 1000);
let remaining = Number(process.env.TASK_TEST_COUNT);
runWithWorkspace('tasks-workspace', async () => {
  const store = new ServerTaskStore(), ids = [];
  for (let n = 0; n < Number(process.env.TASK_TEST_COUNT); n++) {
    const task = await store.create(auth, 'tasks-workspace', { run: ctx => new Promise(() => {
      ctx.signal.addEventListener('abort', () => {
        if (--remaining === 0) { process.send({ aborted: true }); clearInterval(keepAlive); }
      });
    }) });
    ids.push(task.taskId);
  }
  process.send({ ids });
}).catch(error => { process.send({ error: String(error) }); clearInterval(keepAlive); process.exitCode = 1; });
`;

describe('durable MCP server Tasks', () => {
  let root: string, store: ServerTaskStore, now: number, revoked: boolean, auth: OwnerRequestAuthorization;
  let previousRoot: string | undefined;
  const children = new Set<ChildProcess>();
  const inWorkspace = <T>(action: () => Promise<T>, workspace = 'tasks-workspace') => runWithWorkspace(workspace, action);
  async function waitFor(id: string, status: string, authorization = auth): Promise<ServerTaskView> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await inWorkspace(() => store.get(authorization, 'tasks-workspace', id));
      if (value.status === status) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Task did not reach ${status}`);
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-server-tasks-'));
    previousRoot = process.env.FLUJO_DATA_DIR; process.env.FLUJO_DATA_DIR = root;
    now = Date.now(); revoked = false;
    auth = { principal: { ownerId: 'owner', credentialId: 'credential', policyRevision: 'revision',
      expiresAt: now + 3600000, scopes: ['mcp:access', 'control:admin', 'secrets:read'] },
      recheck: () => revoked ? new Response(null, { status: 401 }) : null };
    store = new ServerTaskStore({ directory: root, now: () => now });
  });
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
      }
      children.delete(child);
    }
    // Cancel each test's owned jobs before cleaning only its verified temporary root.
    revoked = false;
    const filename = path.join(root, '.mcp-server-tasks', 'ledger.json');
    try {
      const ledger = JSON.parse(await fs.readFile(filename, 'utf8')) as { tasks: { taskId: string; workspaceId: string }[] };
      for (const task of ledger.tasks) {
        await inWorkspace(() => store.cancel(auth, task.workspaceId, task.taskId), task.workspaceId).catch(() => undefined);
      }
    } catch { /* A failed initial write intentionally creates no ledger. */ }
    if (previousRoot === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = previousRoot;
    const absolute = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (!relative.startsWith('flujo-server-tasks-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unsafe cleanup');
    await fs.rm(absolute, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  it('writes the durable handle before running, encrypts results and retrieves after store recreation', async () => {
    const gate = deferred<Record<string, unknown>>();
    let executed = false;
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async ctx => {
      ctx.assertAuthorized();
      const ledger = await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8');
      expect(ledger).toContain('"status":"working"'); executed = true;
      return gate.promise;
    } }));
    expect(created).toMatchObject({ status: 'working', resultType: 'task' });
    await waitFor(created.taskId, 'working');
    gate.resolve({ content: [{ type: 'text', text: 'private-terminal-result' }] });
    const complete = await waitFor(created.taskId, 'completed');
    expect(executed).toBe(true);
    expect(complete.result).toEqual({ content: [{ type: 'text', text: 'private-terminal-result' }] });
    const disk = await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8');
    expect(disk).not.toContain('private-terminal-result');
    store = new ServerTaskStore({ directory: root, now: () => now });
    expect(await inWorkspace(() => store.get(auth, 'tasks-workspace', created.taskId))).toEqual(complete);
  });
  it('does not execute when durable admission fails', async () => {
    await fs.mkdir(path.join(root, '.mcp-server-tasks'));
    await fs.mkdir(path.join(root, '.mcp-server-tasks', 'ledger.json'));
    const run = jest.fn(async () => ({}));
    await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { run }))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });
  it('does not execute when the initial atomic commit or encryption fails', async () => {
    const run = jest.fn(async () => ({}));
    const write = jest.mocked(storageBackend.writeFileAtomic).mockRejectedValueOnce(new Error('disk full private-details'));
    await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { run }))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
    const encryption = jest.requireMock('@/utils/encryption/secure') as { encryptWithPassword: jest.Mock };
    encryption.encryptWithPassword.mockResolvedValueOnce(null);
    await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { run }))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, '.mcp-server-tasks', 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects other owner, credential, policy revision, workspace and ambient workspace before results', async () => {
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ secret: 'result' }) }));
    await waitFor(created.taskId, 'completed');
    for (const principal of [{ ownerId: 'other' }, { credentialId: 'other' }, { policyRevision: 'other' }]) {
      const wrong = { ...auth, principal: { ...auth.principal, ...principal } };
      await expect(inWorkspace(() => store.get(wrong, 'tasks-workspace', created.taskId))).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    }
    await expect(inWorkspace(() => store.get(auth, 'other-workspace', created.taskId), 'other-workspace')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(inWorkspace(() => store.get(auth, 'other-workspace', created.taskId))).rejects.toMatchObject({ code: 'TASK_ACCESS_DENIED' });
    revoked = true;
    await expect(inWorkspace(() => store.get(auth, 'tasks-workspace', created.taskId))).rejects.toMatchObject({ code: 'TASK_ACCESS_DENIED' });
  });
  it('enforces per-owner active admission across reconstructed instances and credentials', async () => {
    const gate = deferred<Record<string, unknown>>();
    for (let n = 0; n < 4; n++) await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: () => gate.promise }));
    const other = new ServerTaskStore({ directory: root, now: () => now });
    const anotherCredential = { ...auth, principal: { ...auth.principal, credentialId: 'credential2' } };
    await expect(inWorkspace(() => other.create(anotherCredential, 'tasks-workspace', { run: async () => ({}) }))).rejects.toMatchObject({ code: 'TASK_LIMIT' });
    gate.resolve({});
  });
  it('enforces the shared global active cap across distinct owners', async () => {
    const gate = deferred<Record<string, unknown>>(), tasks: { id: string; auth: OwnerRequestAuthorization }[] = [];
    try {
      for (let n = 0; n < 32; n++) {
        const owner = { ...auth, principal: { ...auth.principal, ownerId: `owner${Math.floor(n / 4)}` } };
        const created = await inWorkspace(() => store.create(owner, 'tasks-workspace', { run: () => gate.promise }));
        tasks.push({ id: created.taskId, auth: owner });
      }
      const anotherOwner = { ...auth, principal: { ...auth.principal, ownerId: 'owner33' } };
      await expect(inWorkspace(() => store.create(anotherOwner, 'tasks-workspace', { run: async () => ({}) }))).rejects.toMatchObject({ code: 'TASK_LIMIT' });
    } finally { gate.resolve({}); }
    for (const task of tasks) await waitFor(task.id, 'completed', task.auth);
  }, 15000);
  it('fails dead-process handles after restart without replaying or exposing old input', async () => {
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({}) }));
    await waitFor(created.taskId, 'completed');
    const file = path.join(root, '.mcp-server-tasks', 'ledger.json');
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    ledger.tasks[0].status = 'input_required'; ledger.tasks[0].executionPending = true; ledger.tasks[0].process.pid = 2147483647;
    ledger.tasks[0].process.processInstanceId = randomBytes(16).toString('hex');
    delete ledger.tasks[0].process.processBirthMarkerV2;
    await inWorkspace(() => writeFileAtomic(file, JSON.stringify(ledger)));
    store = new ServerTaskStore({ directory: root, now: () => now });
    const result = await inWorkspace(() => store.get(auth, 'tasks-workspace', created.taskId));
    expect(result).toMatchObject({ status: 'failed', error: { message: 'TASK_INTERRUPTED' } });
    expect(result.result).toBeUndefined(); expect(result.inputRequests).toBeUndefined();
  });
  it('delivers concurrent keyed input only once and keeps input private on disk', async () => {
    const accepted = jest.fn();
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async ctx => {
      const input = await ctx.requestInput(inputRequests); ctx.assertAuthorized(); accepted(input); return { ok: true };
    } }));
    const pending = await waitFor(created.taskId, 'input_required');
    expect(pending.inputRequests).toEqual(inputRequests);
    await inWorkspace(() => Promise.all([store.update(auth, 'tasks-workspace', created.taskId, response),
      store.update(auth, 'tasks-workspace', created.taskId, response)]));
    await waitFor(created.taskId, 'completed');
    expect(accepted).toHaveBeenCalledTimes(1); expect(accepted).toHaveBeenCalledWith(response);
    const disk = await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8');
    expect(disk).not.toContain('elicited-private-value'); expect(disk).not.toContain('private-operation-label');
    expect(await inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, response))).toEqual({ resultType: 'complete' });
  });
  it('acknowledges unknown, empty and already-satisfied input without executing twice', async () => {
    const accepted = jest.fn();
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async ctx => {
      await ctx.requestInput(inputRequests); accepted(); return {};
    } }));
    await waitFor(created.taskId, 'input_required');
    await inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, {}));
    await inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, { unknown: response.approval }));
    expect((await waitFor(created.taskId, 'input_required')).status).toBe('input_required'); expect(accepted).not.toHaveBeenCalled();
    await inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, { ...response, unknown: response.approval }));
    await waitFor(created.taskId, 'completed'); expect(accepted).toHaveBeenCalledTimes(1);
  });
  it('cancels an input waiter without fulfilling it; cancellation cannot overwrite completion', async () => {
    const effect = jest.fn();
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async ctx => {
      await ctx.requestInput(inputRequests); ctx.assertAuthorized(); effect(); return {};
    } }));
    await waitFor(created.taskId, 'input_required');
    expect(await inWorkspace(() => store.cancel(auth, 'tasks-workspace', created.taskId))).toEqual({ resultType: 'complete' });
    expect(await inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, response))).toEqual({ resultType: 'complete' });
    expect((await waitFor(created.taskId, 'cancelled')).status).toBe('cancelled'); expect(effect).not.toHaveBeenCalled();
    const complete = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ ok: true }) }));
    await waitFor(complete.taskId, 'completed');
    await inWorkspace(() => store.cancel(auth, 'tasks-workspace', complete.taskId));
    expect((await waitFor(complete.taskId, 'completed')).result).toEqual({ ok: true });
  });
  it('retains execution slots for cancelled callbacks until they actually settle', async () => {
    const gate = deferred<Record<string, unknown>>(), ids: string[] = [];
    try {
      for (let n = 0; n < 4; n++) {
        const task = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: () => gate.promise }));
        ids.push(task.taskId);
      }
      for (const id of ids) await inWorkspace(() => store.cancel(auth, 'tasks-workspace', id));
      await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({}) }))).rejects.toMatchObject({ code: 'TASK_LIMIT' });
    } finally { gate.resolve({ late: 'ignored' }); }
    let cleared = false;
    const deadline = Date.now() + 3000;
    while (!cleared && Date.now() < deadline) {
      const ledger = JSON.parse(await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8'));
      cleared = ledger.tasks.every((task: { executionPending: boolean }) => !task.executionPending);
      if (!cleared) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(cleared).toBe(true);
    for (const id of ids) expect((await waitFor(id, 'cancelled')).result).toBeUndefined();
    const next = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ ok: true }) }));
    await waitFor(next.taskId, 'completed');
  });
  it.each([false, true])('repairs settled execution leases after transient finish write failures (cancelled=%s)', async cancelled => {
    const gate = deferred<Record<string, unknown>>(), run = jest.fn(() => gate.promise);
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { ttlMs: 1000, run }));
    await waitFor(created.taskId, 'working');
    if (cancelled) await inWorkspace(() => store.cancel(auth, 'tasks-workspace', created.taskId));
    const write = jest.mocked(storageBackend.writeFileAtomic);
    const original = jest.requireActual<typeof import('@/utils/storage/backend')>('@/utils/storage/backend').writeFileAtomic;
    let storageUnavailable = true, failures = 0;
    write.mockImplementation(async (...args) => {
      if (storageUnavailable) { failures++; throw new Error('Transient finish write failure'); }
      return original(...args);
    });
    gate.resolve({ private: 'callback-result-must-not-be-replayed' });
    const deadline = Date.now() + 3000;
    const expectedFailures = cancelled ? 1 : 2;
    while (failures < expectedFailures && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(failures).toBeGreaterThanOrEqual(expectedFailures);
    // Allow the finish attempts to reject and the callback to fully retire.
    await new Promise(resolve => setTimeout(resolve, 30));
    const reconstructed = new ServerTaskStore({ directory: root, now: () => now });
    await expect(inWorkspace(() => reconstructed.get(auth, 'tasks-workspace', created.taskId)))
      .rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    storageUnavailable = false;
    const repaired = await inWorkspace(() => reconstructed.get(auth, 'tasks-workspace', created.taskId));
    expect(repaired.status).toBe(cancelled ? 'cancelled' : 'failed');
    expect(repaired.result).toBeUndefined();
    const repairedLedger = JSON.parse(await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8'));
    expect(repairedLedger.tasks[0].executionPending).toBe(false);
    now += 1001;
    // The same owner's different credential regains all four admitted slots.
    const anotherCredential = { ...auth, principal: { ...auth.principal, credentialId: 'credential2' } };
    const pending = deferred<Record<string, unknown>>(), tasks: string[] = [];
    try {
      for (let n = 0; n < 4; n++) {
        const task = await inWorkspace(() => reconstructed.create(anotherCredential, 'tasks-workspace', { run: () => pending.promise }));
        tasks.push(task.taskId);
      }
      const ledger = JSON.parse(await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8'));
      expect(ledger.tasks.find((task: { taskId: string }) => task.taskId === created.taskId)).toBeUndefined();
      expect(ledger.tasks.filter((task: { executionPending: boolean }) => task.executionPending)).toHaveLength(4);
      expect(run).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(ledger)).not.toContain('callback-result-must-not-be-replayed');
    } finally { pending.resolve({}); }
    for (const taskId of tasks) await waitFor(taskId, 'completed', anotherCredential);
  });
  it('revocation aborts a waiting task and prevents subsequent input delivery', async () => {
    const effect = jest.fn(), aborted = deferred<void>();
    const created = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async ctx => {
      ctx.signal.addEventListener('abort', () => aborted.resolve());
      await ctx.requestInput(inputRequests); ctx.assertAuthorized(); effect(); return {};
    } }));
    await waitFor(created.taskId, 'input_required'); revoked = true;
    await expect(inWorkspace(() => store.update(auth, 'tasks-workspace', created.taskId, response))).rejects.toMatchObject({ code: 'TASK_ACCESS_DENIED' });
    await aborted.promise; expect(effect).not.toHaveBeenCalled();
    revoked = false;
    expect((await waitFor(created.taskId, 'failed')).error?.message).toBe('TASK_AUTH_REVOKED');
  });
  it('bounds input/output and TTL; expiry releases active capacity without replay', async () => {
    await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { ttlMs: 999, run: async () => ({}) }))).rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });
    const oversized = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ text: 'x'.repeat(64 * 1024) }) }));
    expect((await waitFor(oversized.taskId, 'failed')).error?.message).toBe('TASK_FAILED');
    const gate = deferred<Record<string, unknown>>();
    const expiring = await inWorkspace(() => store.create(auth, 'tasks-workspace', { ttlMs: 1000, run: () => gate.promise }));
    now += 1001;
    await expect(inWorkspace(() => store.get(auth, 'tasks-workspace', expiring.taskId))).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    gate.resolve({ private: 'late-result' });
    const newTask = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ ok: true }) }));
    expect((await waitFor(newTask.taskId, 'completed')).result).toEqual({ ok: true });
  });
  it('never persists operation arguments, bearer material or thrown error text', async () => {
    const privateArguments = { token: 'private-bearer-value', input: 'private-call-argument' };
    const task = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => {
      throw new Error(JSON.stringify(privateArguments));
    } }));
    expect((await waitFor(task.taskId, 'failed')).error?.message).toBe('TASK_FAILED');
    const disk = await fs.readFile(path.join(root, '.mcp-server-tasks', 'ledger.json'), 'utf8');
    expect(disk).not.toContain(privateArguments.token); expect(disk).not.toContain(privateArguments.input);
  });
  it('bounds index bytes before parse and fails closed on truncated terminal payloads or changed encryption binding', async () => {
    const task = await inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({ secret: 'terminal' }) }));
    await waitFor(task.taskId, 'completed');
    const file = path.join(root, '.mcp-server-tasks', 'ledger.json'), raw = await fs.readFile(file, 'utf8');
    const truncated = JSON.parse(raw); delete truncated.tasks[0].payload;
    await inWorkspace(() => writeFileAtomic(file, JSON.stringify(truncated)));
    await expect(inWorkspace(() => store.get(auth, 'tasks-workspace', task.taskId))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    const changed = JSON.parse(raw); changed.tasks[0].policyRevision = 'changed';
    const changedAuth = { ...auth, principal: { ...auth.principal, policyRevision: 'changed' } };
    await inWorkspace(() => writeFileAtomic(file, JSON.stringify(changed)));
    await expect(inWorkspace(() => store.get(changedAuth, 'tasks-workspace', task.taskId))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
    await inWorkspace(() => writeFileAtomic(file, ' '.repeat(6 * 1024 * 1024 + 1)));
    await expect(inWorkspace(() => store.get(auth, 'tasks-workspace', task.taskId))).rejects.toMatchObject({ code: 'TASK_STORAGE_UNAVAILABLE' });
  });
  async function startChild(count: number): Promise<{ child: ChildProcess; ids: string[] }> {
    const child = spawn(process.execPath, ['-e', childSource], { cwd: process.cwd(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, FLUJO_DATA_DIR: root,
        TASK_TEST_COUNT: String(count), TASK_TEST_EXPIRY: String(auth.principal.expiresAt),
        TASK_TEST_KEY: (jest.requireMock('@/utils/encryption/secure') as { _testKey: string })._testKey } });
    children.add(child);
    let errors = ''; child.stderr?.on('data', data => { errors += String(data).slice(0, 4096); });
    const ids = await new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Task child timed out: ${errors}`)), 12000);
      child.on('message', message => {
        const value = message as { ids?: string[]; error?: string };
        if (value.ids) { clearTimeout(timeout); resolve(value.ids); }
        if (value.error) { clearTimeout(timeout); reject(new Error(value.error)); }
      });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Task child exited ${code}: ${errors}`)); });
    });
    return { child, ids };
  }
  it('enforces cross-process admission and delivers cancellation to the actual owning process', async () => {
    const { child, ids } = await startChild(4);
    await expect(inWorkspace(() => store.create(auth, 'tasks-workspace', { run: async () => ({}) }))).rejects.toMatchObject({ code: 'TASK_LIMIT' });
    const aborted = new Promise<void>(resolve => child.on('message', message => { if ((message as { aborted?: boolean }).aborted) resolve(); }));
    for (const id of ids) await inWorkspace(() => store.cancel(auth, 'tasks-workspace', id));
    await aborted;
    expect((await waitFor(ids[0], 'cancelled')).status).toBe('cancelled');
  }, 20000);
  it('retains and fails an actual crashed child handle without silently replaying its callback', async () => {
    const { child, ids } = await startChild(1);
    expect((await waitFor(ids[0], 'working')).status).toBe('working');
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    const interrupted = await waitFor(ids[0], 'failed');
    expect(interrupted.error?.message).toBe('TASK_INTERRUPTED');
    store = new ServerTaskStore({ directory: root, now: () => now });
    expect(await inWorkspace(() => store.get(auth, 'tasks-workspace', ids[0]))).toEqual(interrupted);
  }, 20000);
});

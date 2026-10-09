/** Durable server Tasks. Only metadata and workspace-key encrypted payloads reach disk.
 * A persisted handle precedes execution. Dead process owners fail without replay;
 * uncertain process observations retain ownership rather than stealing a job.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InputRequestsV2, InputResponsesV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import type { OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { getRuntimeProcessIdentity, isRuntimeProcessIdentityAlive, withWorkspaceRuntimeLock,
  type RuntimeProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';
import { assertLinkFreeFileParent } from '@/backend/services/workspace/backupRestoreFs';
import { readPlainFile } from '@/utils/readPlainFile';
import { writeFileAtomic } from '@/utils/storage/backend';
import { encryptWithPassword, decryptWithPassword } from '@/utils/encryption/secure';
import { getDataDir } from '@/utils/paths';
import { DEFAULT_WORKSPACE, getCurrentWorkspace, isValidWorkspaceName, runWithWorkspace } from '@/utils/workspace';

export type ServerTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
export interface ServerTaskMetadata {
  taskId: string; status: ServerTaskStatus; createdAt: string; lastUpdatedAt: string;
  ttlMs: number; pollIntervalMs: number;
}
export interface ServerTaskView extends ServerTaskMetadata {
  resultType: 'complete'; result?: Record<string, unknown>; error?: { code: number; message: string };
  inputRequests?: InputRequestsV2;
}
export interface ServerTaskExecution {
  readonly signal: AbortSignal;
  /** Call immediately before each provider/tool/workspace effect, in addition to its own consent fence. */
  assertAuthorized(): void;
  requestInput(requests: InputRequestsV2): Promise<InputResponsesV2>;
}
export interface ServerTaskCreation {
  ttlMs?: number; pollIntervalMs?: number;
  run(context: ServerTaskExecution): Promise<Record<string, unknown>>;
}
export class ServerTaskError extends Error {
  constructor(readonly code: 'TASK_ACCESS_DENIED' | 'TASK_NOT_FOUND' | 'TASK_LIMIT' | 'TASK_INPUT_INVALID'
    | 'TASK_STORAGE_UNAVAILABLE' | 'TASK_PAYLOAD_LIMIT' | 'TASK_RETIRED') {
    super(code); this.name = 'ServerTaskError';
  }
}

interface TaskRecord extends ServerTaskMetadata {
  ownerId: string; credentialId: string; workspaceId: string; policyRevision: string;
  expiresAt: number; process: RuntimeProcessIdentity;
  executionPending: boolean;
  payload?: string; errorCode?: 'TASK_INTERRUPTED' | 'TASK_FAILED' | 'TASK_AUTH_REVOKED' | 'TASK_EXPIRED';
  acceptedInputIds: string[];
}
interface TaskPayload { result?: Record<string, unknown>; inputRequests?: InputRequestsV2; inputResponses?: InputResponsesV2 }
interface Ledger { schemaVersion: 1; tasks: TaskRecord[] }
interface LiveTask {
  controller: AbortController; monitor?: ReturnType<typeof setInterval>; busy: boolean;
  pending?: { resolve(value: InputResponsesV2): void; reject(error: unknown): void };
  authorization: OwnerRequestAuthorization;
}
interface SharedTasks { live: Map<string, LiveTask>; chains: Map<string, Promise<unknown>> }
declare global { var __flujo_server_tasks_v1: SharedTasks | undefined }
const shared = globalThis.__flujo_server_tasks_v1 ??= { live: new Map(), chains: new Map() };
const LIMITS = Object.freeze({ records: 128, active: 32, perOwnerActive: 4, payloadBytes: 32 * 1024,
  ledgerBytes: 6 * 1024 * 1024, inputCount: 16, ttlMs: 24 * 60 * 60 * 1000 });
const terminal = (status: ServerTaskStatus) => ['completed', 'failed', 'cancelled'].includes(status);
function fail(code: ConstructorParameters<typeof ServerTaskError>[0]): never { throw new ServerTaskError(code); }
const metadata = (record: TaskRecord): ServerTaskMetadata => ({ taskId: record.taskId, status: record.status,
  createdAt: record.createdAt, lastUpdatedAt: record.lastUpdatedAt, ttlMs: record.ttlMs, pollIntervalMs: record.pollIntervalMs });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate JSON incrementally before stringify can allocate an oversized string. */
function boundedJson(value: unknown, maxBytes: number): string {
  let bytes = 0, nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 32) fail('TASK_PAYLOAD_LIMIT');
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > maxBytes) fail('TASK_PAYLOAD_LIMIT');
      bytes += Buffer.byteLength(JSON.stringify(item));
    }
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item)) bytes += 32;
    else if (typeof item === 'object' && item !== null) {
      if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
        && Object.getPrototypeOf(item) !== null)) fail('TASK_INPUT_INVALID');
      seen.add(item); bytes += 2;
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) fail('TASK_INPUT_INVALID');
        if (Buffer.byteLength(key) > maxBytes) fail('TASK_PAYLOAD_LIMIT');
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        if (bytes > maxBytes) fail('TASK_PAYLOAD_LIMIT');
        visit(descriptor.value, depth + 1);
      }
      seen.delete(item);
    } else fail('TASK_INPUT_INVALID');
    if (bytes > maxBytes) fail('TASK_PAYLOAD_LIMIT');
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) fail('TASK_PAYLOAD_LIMIT');
  return text;
}

/** One instance may serve many requests; jobs also survive Next route-bundle recreation. */
export class ServerTaskStore {
  private readonly filename: string;
  constructor(private readonly options: { now?: () => number; directory?: string } = {}) {
    this.filename = path.join(path.resolve(options.directory ?? getDataDir()), '.mcp-server-tasks', 'ledger.json');
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private key(id: string) { return `${this.filename}:${id}`; }
  private assertAuthority(auth: OwnerRequestAuthorization, workspace: string): void {
    let refused = true;
    try { refused = auth.recheck(this.now()) !== null; } catch { /* Authority uncertainty denies access. */ }
    if (!isValidWorkspaceName(workspace) || workspace !== getCurrentWorkspace()
      || (auth.principal.workspaceId !== undefined && auth.principal.workspaceId !== workspace)
      || !(['mcp:access', 'control:admin', 'secrets:read'] as const).every(scope => auth.principal.scopes.includes(scope))
      || auth.principal.expiresAt <= this.now()
      || refused) fail('TASK_ACCESS_DENIED');
  }
  private owned(ledger: Ledger, auth: OwnerRequestAuthorization, workspace: string, id: string): TaskRecord {
    this.assertAuthority(auth, workspace);
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) fail('TASK_NOT_FOUND');
    const task = ledger.tasks.find(value => value.taskId === id);
    if (!task || task.ownerId !== auth.principal.ownerId || task.credentialId !== auth.principal.credentialId
      || task.workspaceId !== workspace || task.policyRevision !== auth.principal.policyRevision
      || task.expiresAt <= this.now()) fail('TASK_NOT_FOUND');
    return task;
  }
  private async read(): Promise<Ledger> {
    try {
      const raw = await readPlainFile(this.filename, { maxBytes: LIMITS.ledgerBytes,
        verifyPath: () => assertLinkFreeFileParent(path.dirname(path.dirname(this.filename)), this.filename) });
      const value: unknown = JSON.parse(raw.toString('utf8'));
      if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)
        || value.tasks.length > LIMITS.records || Object.keys(value).some(key => !['schemaVersion', 'tasks'].includes(key))) fail('TASK_STORAGE_UNAVAILABLE');
      const ids = new Set<string>();
      for (const item of value.tasks) {
        if (!isRecord(item) || typeof item.taskId !== 'string' || !/^[0-9a-f-]{36}$/.test(item.taskId)
          || Object.keys(item).some(key => !['taskId', 'status', 'createdAt', 'lastUpdatedAt', 'ttlMs', 'pollIntervalMs',
            'ownerId', 'credentialId', 'workspaceId', 'policyRevision', 'expiresAt', 'process', 'payload', 'errorCode', 'acceptedInputIds', 'executionPending'].includes(key))
          || ids.has(item.taskId) || !['working', 'input_required', 'completed', 'failed', 'cancelled'].includes(String(item.status))
          || !isValidWorkspaceName(item.workspaceId) || typeof item.ownerId !== 'string' || item.ownerId.length > 64
          || typeof item.credentialId !== 'string' || item.credentialId.length > 64
          || typeof item.policyRevision !== 'string' || item.policyRevision.length > 256
          || typeof item.executionPending !== 'boolean'
          || (!terminal(item.status as ServerTaskStatus) && item.executionPending !== true)
          || !Number.isSafeInteger(item.expiresAt) || !Number.isSafeInteger(item.ttlMs)
          || Number(item.ttlMs) < 1000 || Number(item.ttlMs) > LIMITS.ttlMs
          || !Number.isSafeInteger(item.pollIntervalMs) || Number(item.pollIntervalMs) < 100
          || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
          || typeof item.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(item.lastUpdatedAt))
          || !isRecord(item.process) || !Number.isSafeInteger(item.process.pid) || Number(item.process.pid) <= 0
          || typeof item.process.processInstanceId !== 'string' || item.process.processInstanceId.length > 128
          || (item.process.processBirthMarkerV2 !== undefined && (typeof item.process.processBirthMarkerV2 !== 'string'
            || item.process.processBirthMarkerV2.length > 256))
          || !Array.isArray(item.acceptedInputIds) || item.acceptedInputIds.length > LIMITS.inputCount
          || item.acceptedInputIds.some(id => typeof id !== 'string' || id.length > 128)
          || (item.errorCode !== undefined && !['TASK_INTERRUPTED', 'TASK_FAILED', 'TASK_AUTH_REVOKED', 'TASK_EXPIRED'].includes(String(item.errorCode)))
          || (item.payload !== undefined && (typeof item.payload !== 'string' || !item.payload.startsWith('v2:')
            || Buffer.byteLength(item.payload) > LIMITS.payloadBytes * 2))) fail('TASK_STORAGE_UNAVAILABLE');
        ids.add(item.taskId);
      }
      return value as unknown as Ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, tasks: [] };
      throw error instanceof ServerTaskError ? error : new ServerTaskError('TASK_STORAGE_UNAVAILABLE');
    }
  }
  private async write(ledger: Ledger, guard?: () => void): Promise<void> {
    const text = boundedJson(ledger, LIMITS.ledgerBytes);
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    await assertLinkFreeFileParent(path.dirname(path.dirname(this.filename)), this.filename);
    try { await writeFileAtomic(this.filename, text, async () => { guard?.();
      await assertLinkFreeFileParent(path.dirname(path.dirname(this.filename)), this.filename); }); }
    catch (error) { throw error instanceof ServerTaskError ? error : new ServerTaskError('TASK_STORAGE_UNAVAILABLE'); }
  }
  private async transaction<T>(workspace: string, action: (ledger: Ledger) => Promise<T>): Promise<T> {
    const previous = shared.chains.get(this.filename) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => runWithWorkspace(DEFAULT_WORKSPACE, () =>
      withWorkspaceRuntimeLock('mcp-server-tasks', lock => runWithWorkspace(workspace, async () => {
        await lock.assertOwned();
        const ledger = await this.read();
        let changed = false;
        for (const task of ledger.tasks) {
          const dead = task.executionPending && !(await isRuntimeProcessIdentityAlive(task.process));
          if (dead) { task.executionPending = false; changed = true; }
          if (!terminal(task.status) && (task.expiresAt <= this.now() || dead)) {
            task.status = 'failed'; task.errorCode = task.expiresAt <= this.now() ? 'TASK_EXPIRED' : 'TASK_INTERRUPTED';
            delete task.payload; task.lastUpdatedAt = new Date(this.now()).toISOString(); changed = true;
            this.retire(task.taskId);
          }
        }
        if (changed) { await lock.assertOwned(); await this.write(ledger); }
        return action(ledger);
      }))));
    shared.chains.set(this.filename, current);
    try { return await current; }
    finally { if (shared.chains.get(this.filename) === current) shared.chains.delete(this.filename); }
  }
  private async seal(task: TaskRecord, payload: TaskPayload): Promise<string> {
    const serialized = boundedJson({ format: 'flujo-server-task-v1', taskId: task.taskId,
      workspaceId: task.workspaceId, ownerId: task.ownerId, credentialId: task.credentialId,
      policyRevision: task.policyRevision, payload }, LIMITS.payloadBytes);
    const ciphertext = await encryptWithPassword(serialized);
    if (!ciphertext?.startsWith('v2:') || Buffer.byteLength(ciphertext) > LIMITS.payloadBytes * 2) fail('TASK_STORAGE_UNAVAILABLE');
    return ciphertext;
  }
  private async open(task: TaskRecord): Promise<TaskPayload> {
    if (!task.payload) return {};
    try {
      const serialized = await decryptWithPassword(task.payload);
      if (!serialized || Buffer.byteLength(serialized) > LIMITS.payloadBytes) fail('TASK_STORAGE_UNAVAILABLE');
      const envelope: unknown = JSON.parse(serialized);
      if (!isRecord(envelope) || envelope.format !== 'flujo-server-task-v1' || envelope.taskId !== task.taskId
        || envelope.workspaceId !== task.workspaceId || envelope.ownerId !== task.ownerId
        || envelope.credentialId !== task.credentialId || envelope.policyRevision !== task.policyRevision
        || !isRecord(envelope.payload)
        || Object.keys(envelope.payload).some(key => !['result', 'inputRequests', 'inputResponses'].includes(key))) fail('TASK_STORAGE_UNAVAILABLE');
      return envelope.payload;
    } catch { return fail('TASK_STORAGE_UNAVAILABLE'); }
  }
  private retire(id: string): void {
    const live = shared.live.get(this.key(id));
    if (!live) return;
    live.controller.abort(new ServerTaskError('TASK_RETIRED'));
    live.pending?.reject(new ServerTaskError('TASK_RETIRED'));
    if (live.monitor) clearInterval(live.monitor);
    shared.live.delete(this.key(id));
  }

  async create(auth: OwnerRequestAuthorization, workspace: string, options: ServerTaskCreation): Promise<ServerTaskMetadata & { resultType: 'task' }> {
    this.assertAuthority(auth, workspace);
    const ttlMs = options.ttlMs ?? 10 * 60 * 1000, pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > LIMITS.ttlMs
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) fail('TASK_INPUT_INVALID');
    const task = await this.transaction(workspace, async ledger => {
      this.assertAuthority(auth, workspace);
      // Expired terminal metadata is pruned only under the global admission lock.
      ledger.tasks = ledger.tasks.filter(record => record.expiresAt > this.now() || record.executionPending);
      const active = ledger.tasks.filter(record => record.executionPending);
      if (ledger.tasks.length >= LIMITS.records || active.length >= LIMITS.active
        || active.filter(record => record.ownerId === auth.principal.ownerId).length >= LIMITS.perOwnerActive) fail('TASK_LIMIT');
      const now = this.now();
      const record: TaskRecord = { taskId: randomUUID(), status: 'working', createdAt: new Date(now).toISOString(),
        lastUpdatedAt: new Date(now).toISOString(), ttlMs, pollIntervalMs, expiresAt: Math.min(now + ttlMs, auth.principal.expiresAt),
        ownerId: auth.principal.ownerId, credentialId: auth.principal.credentialId, policyRevision: auth.principal.policyRevision,
        workspaceId: workspace, process: await getRuntimeProcessIdentity(), acceptedInputIds: [], executionPending: true };
      // Refuse effects up front if the workspace cannot retain private task results.
      record.payload = await this.seal(record, {});
      ledger.tasks.push(record);
      await this.write(ledger, () => this.assertAuthority(auth, workspace));
      return record;
    });
    const live: LiveTask = { controller: new AbortController(), authorization: auth, busy: false };
    shared.live.set(this.key(task.taskId), live);
    const assertAuthorized = () => { live.controller.signal.throwIfAborted(); this.assertAuthority(auth, workspace);
      if (task.expiresAt <= this.now()) fail('TASK_RETIRED'); };
    live.monitor = setInterval(() => {
      if (live.busy) return;
      live.busy = true;
      void runWithWorkspace(workspace, () => this.monitor(auth, workspace, task.taskId, live))
        .catch(() => this.retire(task.taskId)).finally(() => { live.busy = false; });
    }, 200);
    live.monitor.unref?.();
    // Detach from HTTP request cancellation. Admission is complete and durably recorded.
    void Promise.resolve().then(() => runWithWorkspace(workspace, async () => {
      try {
        assertAuthorized();
        const result = await options.run({ signal: live.controller.signal, assertAuthorized,
          requestInput: requests => this.requestInput(auth, workspace, task.taskId, live, requests) });
        assertAuthorized();
        await this.finish(auth, workspace, task.taskId, result);
      } catch { await this.finish(auth, workspace, task.taskId).catch(() => undefined); }
      finally { this.retire(task.taskId); }
    }));
    return { ...metadata(task), resultType: 'task' };
  }
  private async finish(auth: OwnerRequestAuthorization, workspace: string, id: string, result?: Record<string, unknown>): Promise<void> {
    await this.transaction(workspace, async ledger => {
      const task = ledger.tasks.find(record => record.taskId === id);
      if (!task) return;
      // A cancelled callback retains its execution slot until it actually settles.
      // Releasing that lease changes no terminal outcome or persisted result.
      if (terminal(task.status)) {
        if (task.executionPending) { task.executionPending = false; await this.write(ledger); }
        return;
      }
      let permitted = true;
      try { this.assertAuthority(auth, workspace); } catch { permitted = false; }
      if (permitted && result !== undefined && isRecord(result)) {
        task.payload = await this.seal(task, { result });
        this.assertAuthority(auth, workspace);
        task.status = 'completed';
      } else { task.status = 'failed'; task.errorCode = permitted ? 'TASK_FAILED' : 'TASK_AUTH_REVOKED'; delete task.payload; }
      task.lastUpdatedAt = new Date(this.now()).toISOString();
      task.executionPending = false;
      await this.write(ledger, permitted ? () => this.assertAuthority(auth, workspace) : undefined);
    });
  }
  async get(auth: OwnerRequestAuthorization, workspace: string, id: string): Promise<ServerTaskView> {
    this.assertAuthority(auth, workspace);
    return this.transaction(workspace, async ledger => {
      const task = this.owned(ledger, auth, workspace, id), payload = await this.open(task);
      if ((task.status === 'completed' && !isRecord(payload.result))
        || (task.status === 'input_required' && !isRecord(payload.inputRequests))) fail('TASK_STORAGE_UNAVAILABLE');
      this.assertAuthority(auth, workspace);
      return { ...metadata(task), resultType: 'complete',
        ...(task.status === 'completed' ? { result: payload.result ?? {} } : {}),
        ...(task.status === 'input_required' ? { inputRequests: payload.inputRequests ?? {} } : {}),
        ...(task.status === 'failed' ? { error: { code: -32603, message: task.errorCode ?? 'TASK_FAILED' } } : {}) };
    });
  }
  async cancel(auth: OwnerRequestAuthorization, workspace: string, id: string): Promise<{ resultType: 'complete' }> {
    this.assertAuthority(auth, workspace);
    await this.transaction(workspace, async ledger => {
      const task = this.owned(ledger, auth, workspace, id);
      if (!terminal(task.status)) {
        task.status = 'cancelled'; delete task.payload; task.lastUpdatedAt = new Date(this.now()).toISOString();
        await this.write(ledger, () => this.assertAuthority(auth, workspace));
        this.retire(id);
      }
    });
    return { resultType: 'complete' };
  }
  async update(auth: OwnerRequestAuthorization, workspace: string, id: string, responses: InputResponsesV2): Promise<{ resultType: 'complete' }> {
    this.assertAuthority(auth, workspace);
    boundedJson(responses, LIMITS.payloadBytes);
    const ids = Object.keys(responses);
    if (ids.length > LIMITS.inputCount || ids.some(key => key.length > 128 || !key.length)) fail('TASK_INPUT_INVALID');
    await this.transaction(workspace, async ledger => {
      const task = this.owned(ledger, auth, workspace, id);
      // The extension acknowledges unknown/already-satisfied keys. This includes
      // a retried update whose original operation completed before its ACK arrived.
      if (task.status !== 'input_required' || ids.every(key => task.acceptedInputIds.includes(key))) return;
      const payload = await this.open(task);
      const fresh = ids.filter(key => Object.hasOwn(payload.inputRequests ?? {}, key) && !task.acceptedInputIds.includes(key));
      if (!fresh.length) return;
      if (task.acceptedInputIds.length + fresh.length > LIMITS.inputCount) fail('TASK_INPUT_INVALID');
      const merged: InputResponsesV2 = { ...(payload.inputResponses ?? {}) };
      for (const key of fresh) Object.defineProperty(merged, key, { value: responses[key], enumerable: true });
      task.acceptedInputIds.push(...fresh);
      task.payload = await this.seal(task, { ...payload, inputResponses: merged });
      task.lastUpdatedAt = new Date(this.now()).toISOString();
      await this.write(ledger, () => this.assertAuthority(auth, workspace));
    });
    return { resultType: 'complete' };
  }
  private async requestInput(auth: OwnerRequestAuthorization, workspace: string, id: string, live: LiveTask,
    requests: InputRequestsV2): Promise<InputResponsesV2> {
    boundedJson(requests, LIMITS.payloadBytes);
    const ids = Object.keys(requests);
    if (!ids.length || ids.length > LIMITS.inputCount || ids.some(key => key.length > 128 || !key.length)) fail('TASK_INPUT_INVALID');
    let resolve!: (responses: InputResponsesV2) => void, reject!: (error: unknown) => void;
    const response = new Promise<InputResponsesV2>((yes, no) => { resolve = yes; reject = no; });
    // Install rejection handling before a concurrent cancellation can settle it.
    void response.catch(() => undefined);
    await this.transaction(workspace, async ledger => {
      const task = this.owned(ledger, auth, workspace, id);
      if (task.status !== 'working' || live.pending || ids.some(key => task.acceptedInputIds.includes(key))) fail('TASK_INPUT_INVALID');
      task.payload = await this.seal(task, { inputRequests: requests });
      task.status = 'input_required'; task.lastUpdatedAt = new Date(this.now()).toISOString();
      await this.write(ledger, () => this.assertAuthority(auth, workspace));
      live.pending = { resolve, reject };
    });
    return response;
  }
  private async monitor(auth: OwnerRequestAuthorization, workspace: string, id: string, live: LiveTask): Promise<void> {
    await this.transaction(workspace, async ledger => {
      const task = ledger.tasks.find(record => record.taskId === id);
      if (!task || terminal(task.status)) { this.retire(id); return; }
      try { this.assertAuthority(auth, workspace); }
      catch {
        task.status = 'failed'; task.errorCode = 'TASK_AUTH_REVOKED'; delete task.payload;
        task.lastUpdatedAt = new Date(this.now()).toISOString();
        await this.write(ledger); this.retire(id); return;
      }
      if (task.status !== 'input_required' || !live.pending) return;
      const payload = await this.open(task), ids = Object.keys(payload.inputRequests ?? {});
      if (!ids.length || ids.some(key => !Object.hasOwn(payload.inputResponses ?? {}, key))) return;
      task.status = 'working'; delete task.payload; task.lastUpdatedAt = new Date(this.now()).toISOString();
      await this.write(ledger, () => this.assertAuthority(auth, workspace));
      this.assertAuthority(auth, workspace);
      const pending = live.pending; live.pending = undefined;
      pending.resolve(payload.inputResponses ?? {});
    });
  }
}

export const serverTaskStore = new ServerTaskStore();

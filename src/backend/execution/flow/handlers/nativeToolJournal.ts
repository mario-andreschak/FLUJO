import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readNativeHeldFile } from './nativeHeldFile';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** This journal is private runtime state, never part of a Flow or provider wire. */
export interface NativeInvocationOwner {
  conversationId: string;
  runId: string;
  nodeId: string;
  modelId: string;
  leaseEpoch: string;
  inventoryDigest: string;
  inputDigest: string;
  attemptOrdinal: number;
}

export interface NativeInvocationReceipt {
  invocationId: string;
  owner: NativeInvocationOwner;
  state: 'prepared' | 'begin-may-have-been-sent' | 'unknown' | 'terminal';
  createdAt: number;
  outcome?: 'completed' | 'error' | 'cancelled';
}

interface ToolReceipt {
  invocationId: string;
  conversationId: string;
  toolInvocationId: string;
  fingerprint: string;
  state: 'pending' | 'effect-unknown' | 'terminal';
  result?: { result: CallToolResult; transcriptText: string; kind: 'mcp' | 'synthetic' | 'handoff' };
}

export class NativeInvocationHeldError extends Error {
  constructor(readonly invocationId: string) {
    super('A native invocation in this conversation is unresolved; reconcile its original ID before starting another.');
    this.name = 'NativeInvocationHeldError';
  }
}

let rootOverride: string | undefined;
export function _setNativeToolJournalRootForTests(root: string | undefined): void {
  rootOverride = root;
}

const root = (workspace?: string) => rootOverride ?? path.join(getWorkspaceDataDir(workspace), 'db', 'native-tool-journal');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A later Process node, model or lease in the same conversation must not evade
// an uncertain native call. Product transport adds its stricter fleet-run scope.
const scopeFile = (owner: Pick<NativeInvocationOwner, 'conversationId'>, workspace?: string) =>
  path.join(root(workspace), 'scopes', `${digest(owner.conversationId)}.json`);
const holdFile = (owner: Pick<NativeInvocationOwner, 'conversationId'>, workspace?: string) =>
  path.join(root(workspace), 'holds', `${digest(owner.conversationId)}.json`);
const callFile = (id: string, workspace?: string) => path.join(root(workspace), 'calls', `${id}.json`);
const toolFile = (invocationId: string, toolInvocationId: string) =>
  path.join(root(), 'tools', invocationId, `${digest(toolInvocationId)}.json`);
const withNativeScopeMutation = <T>(conversationId: string, task: (assertOwned: () => Promise<void>) => Promise<T>,
  workspace?: string) =>
  withWorkspaceMutation(() => withWorkspaceRuntimeLock(`native-tool-${digest(conversationId).slice(0, 40)}`, async lock => {
    await lock.assertOwned();
    return task(() => lock.assertOwned());
  }), workspace);

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readTerminalJson<T>(file: string): Promise<T | undefined> {
  let bytes;
  try { bytes = await readNativeHeldFile(file, 64 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
    return JSON.parse(bytes.toString('utf8')) as T;
}

async function assertTerminalDirectory(directory: string, optional = false): Promise<boolean> {
  let entry;
  try { entry = await fs.lstat(directory); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Native terminal source directory is unsafe.');
  return true;
}

async function unresolvedCallForConversation(conversationId: string): Promise<NativeInvocationReceipt | undefined> {
  const directory = path.join(root(), 'calls');
  const names = await fs.readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  // Orphan call records from an interrupted two-file transition must not be
  // bypassed by a missing/terminal scope pointer. Ignore only temp files.
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const call = await readJson<NativeInvocationReceipt>(path.join(directory, name));
    if (!call) throw new Error('Native call record vanished during admission.');
    if (call.owner?.conversationId === conversationId && call.state !== 'terminal') return call;
  }
  return undefined;
}

async function writeDurable(file: string, value: unknown, assertOwned?: () => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await assertOwned?.(); await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
  // Directory fsync is unavailable on some Windows filesystems. The file itself
  // was flushed before the atomic rename; never report a failed rename as saved.
  try {
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* unsupported directory fsync */ }
}

/** Allocate once. An unresolved scope holds every later key, even changed input/lease. */
export async function prepareNativeInvocation(owner: NativeInvocationOwner): Promise<NativeInvocationReceipt> {
  if (Object.entries(owner).some(([key, value]) => key !== 'attemptOrdinal' && (typeof value !== 'string' || !value.trim()))
    || !Number.isSafeInteger(owner.attemptOrdinal) || owner.attemptOrdinal < 1) {
    throw new Error('Native invocation requires complete owner identity.');
  }
  return withNativeScopeMutation(owner.conversationId, async assertOwned => {
    const hold = await readJson<NativeInvocationReceipt>(holdFile(owner));
    if (hold) throw new NativeInvocationHeldError(hold.invocationId);
    const previous = await readJson<NativeInvocationReceipt>(scopeFile(owner));
    if (previous && previous.state !== 'terminal') throw new NativeInvocationHeldError(previous.invocationId);
    const orphan = await unresolvedCallForConversation(owner.conversationId);
    if (orphan) throw new NativeInvocationHeldError(orphan.invocationId);
    const receipt: NativeInvocationReceipt = {
      invocationId: randomUUID(), owner: structuredClone(owner), state: 'prepared', createdAt: Date.now(),
    };
    // The hold is authoritative until the confirmed terminal commit. Even if
    // either of the following files is installed only in part, admission stays
    // closed on restart and after a failed terminal write.
    await writeDurable(holdFile(owner), receipt, assertOwned);
    await writeDurable(scopeFile(owner), receipt, assertOwned);
    await writeDurable(callFile(receipt.invocationId), receipt, assertOwned);
    return receipt;
  });
}

export async function nativeInvocationStatus(id: string, owner: NativeInvocationOwner): Promise<NativeInvocationReceipt> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid native invocation identity.');
  }
  const receipt = await readJson<NativeInvocationReceipt>(callFile(id));
  if (!receipt || JSON.stringify(receipt.owner) !== JSON.stringify(owner)) {
    throw new Error('Unknown or differently owned native invocation.');
  }
  if (receipt.state === 'terminal') {
    const hold = await readJson<NativeInvocationReceipt>(holdFile(owner));
    if (hold?.invocationId === id) return { ...receipt, state: 'unknown', outcome: undefined };
  }
  return receipt;
}

/** Trusted exact-ID reconciliation. A terminal call file is not release proof:
 * the matching scope must be terminal and its authoritative hold must be gone. */
export async function readNativeInvocationTerminalEvidence(
  id: string, owner: NativeInvocationOwner, workspace: string,
  verifySaved?: (receipt: NativeInvocationReceipt) => Promise<void>,
): Promise<{ receipt: NativeInvocationReceipt; holdAbsent: boolean; effectsResolved: boolean }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid native invocation identity.');
  }
  return withNativeScopeMutation(owner.conversationId, async () => {
    for (const part of ['', 'calls', 'scopes', 'holds']) {
      await assertTerminalDirectory(path.join(root(workspace), part));
    }
    const call = await readTerminalJson<NativeInvocationReceipt>(callFile(id, workspace));
    const scope = await readTerminalJson<NativeInvocationReceipt>(scopeFile(owner, workspace));
    const hold = await readTerminalJson<NativeInvocationReceipt>(holdFile(owner, workspace));
    if (!call || !scope || call.invocationId !== id || scope.invocationId !== id
      || JSON.stringify(call.owner) !== JSON.stringify(owner)
      || JSON.stringify(scope.owner) !== JSON.stringify(owner)
      || (hold && (hold.invocationId !== id || JSON.stringify(hold.owner) !== JSON.stringify(owner)))) {
      throw new Error('Native terminal source identity changed.');
    }
    const directory = path.join(root(workspace), 'tools', id);
    const hasTools = await assertTerminalDirectory(path.join(root(workspace), 'tools'), true);
    const names = hasTools && await assertTerminalDirectory(directory, true) ? await fs.readdir(directory) : [];
    if (names.length > 512 || names.some(name => !/^[a-f0-9]{64}\.json$/.test(name))) {
      throw new Error('Native terminal tool receipts are incomplete.');
    }
    let effectsResolved = true;
    for (const name of names) {
      const tool = await readTerminalJson<ToolReceipt>(path.join(directory, name));
      if (!tool || tool.invocationId !== id || tool.conversationId !== owner.conversationId
        || tool.state !== 'terminal') effectsResolved = false;
    }
    await verifySaved?.(call);
    return { receipt: structuredClone(call),
      holdAbsent: !hold && call.state === 'terminal' && scope.state === 'terminal'
        && JSON.stringify(scope) === JSON.stringify(call),
      effectsResolved };
  }, workspace);
}

async function updateInvocation(
  receipt: NativeInvocationReceipt,
  state: NativeInvocationReceipt['state'],
  outcome?: NativeInvocationReceipt['outcome'],
  terminalFence?: { assertCurrent: () => Promise<void>; signal: AbortSignal },
): Promise<NativeInvocationReceipt> {
  return withNativeScopeMutation(receipt.owner.conversationId, async assertOwned => {
    const current = await nativeInvocationStatus(receipt.invocationId, receipt.owner);
    const scope = await readJson<NativeInvocationReceipt>(scopeFile(receipt.owner));
    if (scope?.invocationId !== current.invocationId) throw new NativeInvocationHeldError(current.invocationId);
    if (current.state === 'terminal' || current.state === 'unknown') {
      throw new NativeInvocationHeldError(current.invocationId);
    }
    if (state === 'begin-may-have-been-sent' && current.state !== 'prepared') {
      throw new NativeInvocationHeldError(current.invocationId);
    }
    if (state === 'terminal') {
      if (current.state !== 'begin-may-have-been-sent') throw new NativeInvocationHeldError(receipt.invocationId);
      const directory = path.join(root(), 'tools', receipt.invocationId);
      const entries = await fs.readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const name of entries) {
        const tool = await readJson<ToolReceipt>(path.join(directory, name));
        if (!tool || tool.state !== 'terminal') throw new NativeInvocationHeldError(receipt.invocationId);
      }
      terminalFence?.signal.throwIfAborted();
      await terminalFence?.assertCurrent();
      terminalFence?.signal.throwIfAborted();
    }
    const next = { ...current, state, ...(outcome ? { outcome } : {}) };
    await writeDurable(callFile(next.invocationId), next, assertOwned);
    await writeDurable(scopeFile(next.owner), next, assertOwned);
    if (state === 'terminal') {
      // A Stop or lease loss during either durable write leaves the hold file
      // in place. New attempts cannot bypass it even if scope/call say terminal.
      terminalFence?.signal.throwIfAborted();
      await terminalFence?.assertCurrent();
      terminalFence?.signal.throwIfAborted();
      await assertOwned();
      await fs.unlink(holdFile(next.owner));
      // Unlink is the release decision. A later Stop loses to the already
      // confirmed original SDK terminal; callers must not reject after this.
    }
    return next;
  });
}

export const submitNativeInvocation = (receipt: NativeInvocationReceipt) => updateInvocation(receipt, 'begin-may-have-been-sent');
export async function finishNativeInvocation(
  receipt: NativeInvocationReceipt, outcome: NonNullable<NativeInvocationReceipt['outcome']>,
  terminalFence: { assertCurrent: () => Promise<void>; signal: AbortSignal },
): Promise<NativeInvocationReceipt> {
  return updateInvocation(receipt, 'terminal', outcome, terminalFence);
}
export const holdNativeInvocation = (receipt: NativeInvocationReceipt) => updateInvocation(receipt, 'unknown');

/** The tool record is written before approval or any effect. Pending is never replayed. */
export async function beginNativeTool(
  receipt: NativeInvocationReceipt,
  toolInvocationId: string,
  fingerprint: string,
): Promise<{ entry: ToolReceipt; fresh: boolean }> {
  if (!toolInvocationId || !toolInvocationId.trim() || !fingerprint) {
    throw new Error('Native tool requires an SDK callback identity and fingerprint.');
  }
  return withNativeScopeMutation(receipt.owner.conversationId, async assertOwned => {
    const current = await nativeInvocationStatus(receipt.invocationId, receipt.owner);
    const scope = await readJson<NativeInvocationReceipt>(scopeFile(receipt.owner));
    if (scope?.invocationId !== receipt.invocationId) throw new NativeInvocationHeldError(receipt.invocationId);
    const file = toolFile(receipt.invocationId, toolInvocationId);
    const prior = await readJson<ToolReceipt>(file);
    if (prior) {
      if (prior.conversationId !== receipt.owner.conversationId
        || prior.toolInvocationId !== toolInvocationId || prior.fingerprint !== fingerprint) {
        throw new Error('Conflicting native tool invocation identity.');
      }
      // An unknown parent fences fresh tools, but an already terminal exact
      // callback may still return its durable result to the original live SDK.
      if (current.state === 'terminal' || current.state === 'prepared') {
        throw new NativeInvocationHeldError(receipt.invocationId);
      }
      return { entry: prior, fresh: false };
    }
    if (current.state !== 'begin-may-have-been-sent') throw new NativeInvocationHeldError(receipt.invocationId);
    const entry: ToolReceipt = { invocationId: receipt.invocationId, conversationId: receipt.owner.conversationId,
      toolInvocationId, fingerprint, state: 'pending' };
    await writeDurable(file, entry, assertOwned);
    return { entry, fresh: true };
  });
}

export async function finishNativeTool(
  entry: ToolReceipt,
  result: NonNullable<ToolReceipt['result']>,
  terminalFence?: { assertCurrent: () => Promise<void>; signal: AbortSignal },
): Promise<void> {
  await withNativeScopeMutation(entry.conversationId, async assertOwned => {
    const invocation = await readJson<NativeInvocationReceipt>(callFile(entry.invocationId));
    if (invocation?.owner.conversationId !== entry.conversationId) throw new Error('Native tool owner changed.');
    const scope = await readJson<NativeInvocationReceipt>(scopeFile(invocation.owner));
    if (scope?.invocationId !== entry.invocationId) throw new NativeInvocationHeldError(entry.invocationId);
    const file = toolFile(entry.invocationId, entry.toolInvocationId);
    const current = await readJson<ToolReceipt>(file);
    if (!current || current.fingerprint !== entry.fingerprint || current.state === 'terminal') {
      throw new Error('Native tool invocation is not pending.');
    }
    await writeDurable(file, { ...current, state: 'terminal', result }, async () => {
      terminalFence?.signal.throwIfAborted();
      await terminalFence?.assertCurrent();
      await assertOwned();
      terminalFence?.signal.throwIfAborted();
    });
  });
}

/** Persist uncertainty before the first call into an effectful executor. */
export async function markNativeToolEffectMayHaveStarted(entry: ToolReceipt): Promise<void> {
  await withNativeScopeMutation(entry.conversationId, async assertOwned => {
    const invocation = await readJson<NativeInvocationReceipt>(callFile(entry.invocationId));
    if (invocation?.owner.conversationId !== entry.conversationId) throw new Error('Native tool owner changed.');
    const scope = await readJson<NativeInvocationReceipt>(scopeFile(invocation.owner));
    if (scope?.invocationId !== entry.invocationId) throw new NativeInvocationHeldError(entry.invocationId);
    const file = toolFile(entry.invocationId, entry.toolInvocationId);
    const current = await readJson<ToolReceipt>(file);
    if (!current || current.fingerprint !== entry.fingerprint || current.state !== 'pending') {
      throw new Error('Native tool invocation cannot enter the effect boundary.');
    }
    await writeDurable(file, { ...current, state: 'effect-unknown' }, assertOwned);
  });
}

export function nativeToolFingerprint(name: string, args: Record<string, unknown>, inventoryDigest: string): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical([name, args, inventoryDigest])).digest('hex');
}

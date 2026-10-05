import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

const root = () => rootOverride ?? path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A later Process node, model or lease in the same conversation must not evade
// an uncertain native call. Product transport adds its stricter fleet-run scope.
const scopeFile = (owner: Pick<NativeInvocationOwner, 'conversationId'>) =>
  path.join(root(), 'scopes', `${digest(owner.conversationId)}.json`);
const callFile = (id: string) => path.join(root(), 'calls', `${id}.json`);
const toolFile = (invocationId: string, toolInvocationId: string) =>
  path.join(root(), 'tools', invocationId, `${digest(toolInvocationId)}.json`);
const withNativeScopeMutation = <T>(conversationId: string, task: (assertOwned: () => Promise<void>) => Promise<T>) =>
  withWorkspaceMutation(() => withWorkspaceRuntimeLock(`native-tool-${digest(conversationId).slice(0, 40)}`, async lock => {
    await lock.assertOwned();
    return task(() => lock.assertOwned());
  }));

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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
    const previous = await readJson<NativeInvocationReceipt>(scopeFile(owner));
    if (previous && previous.state !== 'terminal') throw new NativeInvocationHeldError(previous.invocationId);
    const orphan = await unresolvedCallForConversation(owner.conversationId);
    if (orphan) throw new NativeInvocationHeldError(orphan.invocationId);
    const receipt: NativeInvocationReceipt = {
      invocationId: randomUUID(), owner: structuredClone(owner), state: 'prepared', createdAt: Date.now(),
    };
    // The scope pointer goes first: a failed second write leaves a hold, never
    // an unindexed SDK call that could be replaced on restart.
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
  return receipt;
}

async function updateInvocation(
  receipt: NativeInvocationReceipt,
  state: NativeInvocationReceipt['state'],
  outcome?: NativeInvocationReceipt['outcome'],
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
    }
    const next = { ...current, state, ...(outcome ? { outcome } : {}) };
    await writeDurable(callFile(next.invocationId), next, assertOwned);
    await writeDurable(scopeFile(next.owner), next, assertOwned);
    return next;
  });
}

export const submitNativeInvocation = (receipt: NativeInvocationReceipt) => updateInvocation(receipt, 'begin-may-have-been-sent');
export async function finishNativeInvocation(
  receipt: NativeInvocationReceipt, outcome: NonNullable<NativeInvocationReceipt['outcome']>,
): Promise<NativeInvocationReceipt> {
  return updateInvocation(receipt, 'terminal', outcome);
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
    await writeDurable(file, { ...current, state: 'terminal', result }, assertOwned);
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
  return digest([name, args, inventoryDigest]);
}

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
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

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeDurable(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temp, file); }
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
  return withWorkspaceMutation(async () => {
    const previous = await readJson<NativeInvocationReceipt>(scopeFile(owner));
    if (previous && previous.state !== 'terminal') throw new NativeInvocationHeldError(previous.invocationId);
    const receipt: NativeInvocationReceipt = {
      invocationId: randomUUID(), owner: structuredClone(owner), state: 'prepared', createdAt: Date.now(),
    };
    await writeDurable(callFile(receipt.invocationId), receipt);
    await writeDurable(scopeFile(owner), receipt);
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
  return withWorkspaceMutation(async () => {
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
    await writeDurable(callFile(next.invocationId), next);
    await writeDurable(scopeFile(next.owner), next);
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
  return withWorkspaceMutation(async () => {
    const current = await nativeInvocationStatus(receipt.invocationId, receipt.owner);
    if (current.state !== 'begin-may-have-been-sent') throw new NativeInvocationHeldError(receipt.invocationId);
    const file = toolFile(receipt.invocationId, toolInvocationId);
    const prior = await readJson<ToolReceipt>(file);
    if (prior) {
      if (prior.toolInvocationId !== toolInvocationId || prior.fingerprint !== fingerprint) {
        throw new Error('Conflicting native tool invocation identity.');
      }
      return { entry: prior, fresh: false };
    }
    const entry: ToolReceipt = { invocationId: receipt.invocationId, toolInvocationId, fingerprint, state: 'pending' };
    await writeDurable(file, entry);
    return { entry, fresh: true };
  });
}

export async function finishNativeTool(
  entry: ToolReceipt,
  result: NonNullable<ToolReceipt['result']>,
): Promise<void> {
  await withWorkspaceMutation(async () => {
    const file = toolFile(entry.invocationId, entry.toolInvocationId);
    const current = await readJson<ToolReceipt>(file);
    if (!current || current.fingerprint !== entry.fingerprint || current.state === 'terminal') {
      throw new Error('Native tool invocation is not pending.');
    }
    await writeDurable(file, { ...current, state: 'terminal', result });
  });
}

/** Persist uncertainty before the first call into an effectful executor. */
export async function markNativeToolEffectMayHaveStarted(entry: ToolReceipt): Promise<void> {
  await withWorkspaceMutation(async () => {
    const file = toolFile(entry.invocationId, entry.toolInvocationId);
    const current = await readJson<ToolReceipt>(file);
    if (!current || current.fingerprint !== entry.fingerprint || current.state !== 'pending') {
      throw new Error('Native tool invocation cannot enter the effect boundary.');
    }
    await writeDurable(file, { ...current, state: 'effect-unknown' });
  });
}

export function nativeToolFingerprint(name: string, args: Record<string, unknown>, inventoryDigest: string): string {
  return digest([name, args, inventoryDigest]);
}

import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readNativeModelTurnSnapshot } from '../modelTurnArchive';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { readNativeOriginLineage, type NativeLineageRootBinding } from './nativeOriginLineage';
import { nativeDigest, nativeToolInventoryDigest, type NativeBrokerAuthority } from './nativeToolBroker';
import { nativeInvocationStatus, readNativeInvocationTerminalEvidence,
  type NativeInvocationOwner } from './nativeToolJournal';
import { readNativeSessionPayload } from './nativeSessionPayload';
import type { NativeInvocationSession, NativeInvocationSessionDescriptor } from './nativeInvocationSession';
import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';

const MAX_ORIGIN_BYTES = 32 * 1024;
const processGeneration = randomUUID();
let rootOverride: string | undefined;
export function _setNativeSavedOriginRootForTests(root: string | undefined): void { rootOverride = root; }
const root = (workspace?: string) => rootOverride ?? path.join(getWorkspaceDataDir(workspace), 'db', 'native-session-origins');
const fileFor = (id: string, workspace?: string) => {
  assertSafeCollectionId(id);
  return path.join(root(workspace), `${id}.json`);
};
type SavedOrigin = { version: 1; invocationId: string; processGeneration: string;
  descriptor: NativeInvocationSessionDescriptor };
const held = (): never => { throw new Error('Saved native original is unavailable or changed.'); };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Bind both archive formats explicitly. A historical descriptor can prove
 * only V1; a V2 archive requires an explicit V2 commitment in the saved origin.
 * The archive reader must validate the immutable V2 running snapshot and its
 * exact companion outcome before returning an overlaid terminal view. */
export function assertNativeArchiveFormat(snapshot: ModelTurnSnapshot,
  expectedVersion?: 1 | 2): void {
  const version: number = snapshot.version;
  const entryVersion: number = snapshot.entry.archiveVersion;
  if ((version !== 1 && version !== 2) || entryVersion !== version
    || version !== (expectedVersion ?? 1)) return held();
}

async function readSaved(id: string, workspace: string): Promise<SavedOrigin> {
  const directory = await fs.lstat(root(workspace));
  if (!directory.isDirectory() || directory.isSymbolicLink()) return held();
  const file = fileFor(id, workspace);
  const entry = await fs.lstat(file, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== BigInt(1)
    || entry.size < BigInt(1) || entry.size > BigInt(MAX_ORIGIN_BYTES)) return held();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== BigInt(1) || stat.size !== entry.size
      || stat.dev !== entry.dev || stat.ino !== entry.ino
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
      || current.dev !== entry.dev || current.ino !== entry.ino) return held();
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (BigInt(read) !== stat.size) return held();
    const record = JSON.parse(bytes.subarray(0, read).toString('utf8')) as SavedOrigin;
    if (record?.version !== 1 || record.invocationId !== id
      || typeof record.processGeneration !== 'string' || !record.processGeneration
      || record.descriptor?.receipt?.invocationId !== id) return held();
    return record;
  } finally { await handle.close(); }
}

/** Exclusive, durable, private origin publication. An interrupted write leaves
 * a blocking file for the exact ID; it never authorizes another SDK issue. */
export async function saveNativeSessionOrigin(descriptor: NativeInvocationSessionDescriptor): Promise<void> {
  const id = descriptor?.receipt?.invocationId;
  if (!id || descriptor.receipt.state !== 'begin-may-have-been-sent'
    || descriptor.archive?.dispatchId !== id || descriptor.payloadRef?.invocationId !== id
    || descriptor.lineage?.invocationId !== id
    || Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > 16 * 1024) return held();
  const record: SavedOrigin = { version: 1, invocationId: id, processGeneration,
    descriptor: structuredClone(descriptor) };
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  if (bytes.length > MAX_ORIGIN_BYTES) return held();
  await withWorkspaceMutation(async () => {
    await fs.mkdir(root(descriptor.lineage.workspace), { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(root(descriptor.lineage.workspace));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return held();
    const handle = await fs.open(fileFor(id, descriptor.lineage.workspace), 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const parent = await fs.open(root(descriptor.lineage.workspace), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch { /* Directory fsync is unavailable on some Windows filesystems. */ }
  });
}

/** Live, trusted source read for the host's preissue acceptance. */
export async function readSavedNativeOrigin(input: { invocationId: string;
  authority: NativeBrokerAuthority; root: NativeLineageRootBinding; signal: AbortSignal;
}): Promise<NativeInvocationSessionDescriptor> {
  const saved = await readSaved(input.invocationId, input.root.workspace);
  if (saved.processGeneration !== processGeneration) return held();
  const descriptor = saved.descriptor;
  const receipt = await nativeInvocationStatus(input.invocationId, descriptor.receipt.owner);
  if (receipt.state !== 'begin-may-have-been-sent' || !same(receipt.owner, descriptor.receipt.owner)) return held();
  const lineage = await readNativeOriginLineage({ receipt, authority: input.authority,
    root: input.root, signal: input.signal });
  if (!same(lineage, descriptor.lineage)) return held();
  const archived = await readNativeModelTurnSnapshot(receipt.owner.conversationId, input.invocationId,
    input.root.workspace, input.signal);
  assertNativeArchiveFormat(archived, descriptor.archive.archiveVersion);
  if (!archived || archived.entry.outcome !== 'running' || archived.entry.id !== input.invocationId
    || archived.entry.conversationId !== receipt.owner.conversationId
    || archived.entry.runId !== receipt.owner.runId
    || archived.entry.node.nodeId !== receipt.owner.nodeId
    || archived.entry.modelId !== receipt.owner.modelId
    || archived.entry.attempt !== receipt.owner.attemptOrdinal
    || archived.entry.adapter !== descriptor.archive.adapter
    || archived.entry.operation !== descriptor.archive.operation
    || archived.entry.mediaCount !== descriptor.archive.mediaCount
    || nativeDigest(archived.sdkRequest) !== descriptor.archive.sanitizedSdkRequestDigest
    || nativeDigest(archived.genericWire) !== descriptor.archive.sanitizedGenericWireDigest) return held();
  const payload = await readNativeSessionPayload(descriptor.payloadRef, input.root.workspace);
  if (payload.invocationId !== input.invocationId
    || payload.inventory.terminationProtocol !== descriptor.inventory.terminationProtocol
    || !same(payload.archive, { sdkRequest: archived.sdkRequest, genericWire: archived.genericWire, media: archived.media })
    || payload.inventory.tools.length !== descriptor.inventory.toolCount
    || nativeToolInventoryDigest(payload.inventory.tools, payload.inventory.bindings,
      Object.fromEntries(payload.inventory.syntheticNames.map(name => [name, async () => undefined])),
      descriptor.inventory.terminationProtocol)
      !== descriptor.inventory.digest
    || descriptor.inventory.digest !== receipt.owner.inventoryDigest) return held();
  input.signal.throwIfAborted();
  await input.authority.assertCurrent();
  await input.root.assertCurrent();
  return structuredClone(descriptor);
}

/** Source half of the facade's grant/invoke gate. Parent must independently
 * enforce host goal, budget and ledger blockers for each stage. */
export async function assertSavedNativePublishable(input: {
  session: NativeInvocationSession; actor: { workerId: string; goalId: string; fleetRunId: string;
    rootConversationId: string; workspace: string }; descriptor: NativeInvocationSessionDescriptor;
  invocationId: string; stage: 'grant' | 'invoke'; signal: AbortSignal; deadlineAt: number;
  authority: NativeBrokerAuthority; root: NativeLineageRootBinding;
}): Promise<true> {
  if (!['grant', 'invoke'].includes(input.stage) || !Number.isFinite(input.deadlineAt)
    || Date.now() >= input.deadlineAt || input.session.phase() !== 'prepared'
    || input.session.descriptor.receipt.invocationId !== input.invocationId
    || !same(input.session.descriptor, input.descriptor)) return held();
  input.signal.throwIfAborted();
  input.session.signal.throwIfAborted();
  const saved = await readSavedNativeOrigin({ invocationId: input.invocationId,
    authority: input.authority, root: input.root, signal: input.signal });
  if (!same(saved, input.descriptor)
    || ['workerId', 'goalId', 'fleetRunId', 'rootConversationId', 'workspace'].some(field =>
      saved.lineage[field as keyof typeof saved.lineage] !== input.actor[field as keyof typeof input.actor])) return held();
  input.signal.throwIfAborted();
  input.session.signal.throwIfAborted();
  if (Date.now() >= input.deadlineAt) return held();
  return true;
}

/** Exact source terminal read for an already admitted original. The private
 * recovery callback is distinct from a live Worker lease and must be bound by
 * the host to its saved owner; this function has no public transport. */
export async function readSavedNativeTerminal(input: { invocationId: string;
  expectedOwner: NativeInvocationOwner; expectedLineageDigest: string;
  expectedDescriptorDigest: string; expectedWorkspace: string;
  assertReadAuthorized: () => Promise<void>;
}): Promise<{ receipt: Awaited<ReturnType<typeof nativeInvocationStatus>>;
  holdAbsent: boolean; effectsResolved: boolean }> {
  if (typeof input.assertReadAuthorized !== 'function') return held();
  await input.assertReadAuthorized();
  const saved = await readSaved(input.invocationId, input.expectedWorkspace);
  const descriptor = saved.descriptor;
  if (!same(descriptor.receipt.owner, input.expectedOwner)
    || descriptor.lineage.digest !== input.expectedLineageDigest
    || nativeDigest(descriptor) !== input.expectedDescriptorDigest
    || descriptor.lineage.workspace !== input.expectedWorkspace
    || descriptor.archive.dispatchId !== input.invocationId) return held();
  const terminal = await readNativeInvocationTerminalEvidence(input.invocationId, input.expectedOwner,
    input.expectedWorkspace, async () => {
      const archived = await readNativeModelTurnSnapshot(input.expectedOwner.conversationId,
        input.invocationId, input.expectedWorkspace);
      assertNativeArchiveFormat(archived, descriptor.archive.archiveVersion);
      if (!archived || archived.entry.id !== input.invocationId
        || archived.entry.conversationId !== input.expectedOwner.conversationId
        || archived.entry.runId !== input.expectedOwner.runId
        || archived.entry.node.nodeId !== input.expectedOwner.nodeId
        || archived.entry.modelId !== input.expectedOwner.modelId
        || archived.entry.attempt !== input.expectedOwner.attemptOrdinal
        || archived.entry.adapter !== descriptor.archive.adapter
        || archived.entry.operation !== descriptor.archive.operation
        || archived.entry.outcome !== 'completed'
        || nativeDigest(archived.sdkRequest) !== descriptor.archive.sanitizedSdkRequestDigest
        || nativeDigest(archived.genericWire) !== descriptor.archive.sanitizedGenericWireDigest) return held();
      const payload = await readNativeSessionPayload(descriptor.payloadRef, input.expectedWorkspace);
      if (payload.invocationId !== input.invocationId
        || payload.inventory.terminationProtocol !== descriptor.inventory.terminationProtocol
        || !same(payload.archive, { sdkRequest: archived.sdkRequest, genericWire: archived.genericWire, media: archived.media })
        || payload.inventory.tools.length !== descriptor.inventory.toolCount
        || nativeToolInventoryDigest(payload.inventory.tools, payload.inventory.bindings,
          Object.fromEntries(payload.inventory.syntheticNames.map(name => [name, async () => undefined])),
          descriptor.inventory.terminationProtocol)
          !== descriptor.inventory.digest
        || descriptor.inventory.digest !== input.expectedOwner.inventoryDigest) return held();
    });
  if (terminal.receipt.state !== 'terminal' || terminal.receipt.outcome !== 'completed'
    || !terminal.holdAbsent || !terminal.effectsResolved) return held();
  await input.assertReadAuthorized();
  return terminal;
}

import { createHash, randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import { withArchiveWriteMemory, recheckArchiveWriteMemory, closeArchiveWriteHandle, readArchiveLocalMedia,
  settleArchiveWrites, ModelTurnArchiveMemoryError } from './modelTurnArchiveWriteBudget';
import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelInputSnapshot } from './types';
import type {
  ArchivedMediaParameter,
  ModelDispatchOutcome,
  ModelTurnIndexEntry,
  ModelTurnMediaDescriptor,
  ModelTurnSnapshot,
} from '@/shared/types/modelTurn';
import type { VisualCompactionDiagnostic } from '@/shared/types/visualArchive';
import { MODEL_TURN_OUTCOME_MAX_BYTES, parseModelTurnOutcomeRecord } from '@/shared/types/modelTurn';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { commitFlowDurableMutation, type FlowDurableMutationContext } from './executionAuthority';
import {
  MODEL_TURN_ARCHIVE_READ_LIMITS,
  readBoundedModelTurnFile,
  readBoundedModelTurnJson,
  withModelTurnArchiveRead,
  withModelTurnArchiveResponse,
} from './modelTurnArchiveReadBudget';
import { rewriteLegacyModelTurnOutcome } from './legacyModelTurnOutcomeStream';
import { closeModelTurnResponseDescriptor, prepareModelTurnSnapshotResponse } from './modelTurnSnapshotResponse';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

let archiveDirOverride: string | undefined;

const archiveRoot = (workspace?: string) =>
  archiveDirOverride ?? path.join(getWorkspaceDataDir(workspace), 'db', 'model-turns');

export function _setModelTurnArchiveDirForTests(dir: string | undefined): string | undefined {
  const previous = archiveDirOverride;
  archiveDirOverride = dir;
  return previous;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe ${label}`);
}

function conversationDir(conversationId: string, workspace?: string): string {
  assertSafeId(conversationId, 'conversation id');
  return path.join(archiveRoot(workspace), conversationId);
}

function snapshotPath(conversationId: string, dispatchId: string, version: 1 | 2 = 2, workspace?: string): string {
  assertSafeId(dispatchId, 'dispatch id');
  return path.join(conversationDir(conversationId, workspace), `${dispatchId}${version === 2 ? '.v2' : ''}.json.gz`);
}

function outcomePath(conversationId: string, dispatchId: string, workspace?: string): string {
  assertSafeId(dispatchId, 'dispatch id');
  return path.join(conversationDir(conversationId, workspace), `${dispatchId}.outcome.json`);
}

async function readOutcome(conversationId: string, dispatchId: string, signal?: AbortSignal) {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await fs.open(outcomePath(conversationId, dispatchId), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    signal?.throwIfAborted();
    if (!(await handle.stat()).isFile()) throw new Error('Model-turn outcome is not a regular file');
    // Read at most the limit plus one byte, even if the file grows after open.
    const bytes = Buffer.alloc(MODEL_TURN_OUTCOME_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      signal?.throwIfAborted();
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MODEL_TURN_OUTCOME_MAX_BYTES) throw new Error('Model-turn outcome exceeds byte limit');
    return parseModelTurnOutcomeRecord(
      JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), conversationId, dispatchId,
    );
  } finally {
    await handle.close();
  }
}

function mediaPath(conversationId: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Unsafe media hash');
  return path.join(conversationDir(conversationId), 'media', sha256);
}

function mimeFromDataUrl(value: string): { mimeType: string; data: Buffer } | undefined {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) return undefined;
  try {
    return {
      mimeType: match[1] || 'application/octet-stream',
      data: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    };
  } catch {
    return undefined;
  }
}

function inferredMime(parent: Record<string, unknown> | undefined): string | undefined {
  if (!parent) return undefined;
  for (const key of ['mimeType', 'mime_type', 'media_type']) {
    if (typeof parent[key] === 'string' && String(parent[key]).includes('/')) {
      return String(parent[key]);
    }
  }
  if (typeof parent.format === 'string') {
    const format = parent.format.toLowerCase();
    if (['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg'].includes(format)) return `audio/${format === 'mp3' ? 'mpeg' : format}`;
  }
  return undefined;
}

function isNativeBase64Field(key: string, parent: Record<string, unknown> | undefined): boolean {
  if (!parent || !['data', 'file_data'].includes(key)) return false;
  return parent.type === 'base64'
    || parent.type === 'input_audio'
    || parent.type === 'inline_data'
    || parent.type === 'inlineData'
    || Boolean(inferredMime(parent));
}

function redactRemoteUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|signature|credential|auth|secret|password)/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isSecretKey(key: string): boolean {
  return /(api[_-]?key|authorization|cookie|(?:^|[_-])(?:access[_-]?|refresh[_-]?|oauth[_-]?)?token$|secret|password|signature)/i.test(key);
}

interface SanitizeContext {
  conversationId: string;
  media: ModelTurnMediaDescriptor[];
  writes: Map<string, Buffer>;
}

async function archiveBinary(
  ctx: SanitizeContext,
  parameterPath: string,
  mimeType: string,
  data: Buffer,
  encoding: 'data-url' | 'base64' | 'file',
  filename?: string,
): Promise<ArchivedMediaParameter> {
  const sha256 = createHash('sha256').update(data).digest('hex');
  const id = randomUUID();
  ctx.writes.set(sha256, data);
  ctx.media.push({
    id,
    parameterPath,
    kind: mediaTypeFromMime(mimeType),
    mimeType,
    byteLength: data.byteLength,
    sha256,
    encoding,
    ...(filename ? { filename } : {}),
  });
  return {
    __flujoArchivedMedia: { id, mimeType, byteLength: data.byteLength, sha256, encoding },
  };
}

function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

async function sanitizeValue(
  value: unknown,
  parameterPath: string,
  ctx: SanitizeContext,
  parent?: Record<string, unknown>,
  key = '',
  seen = new WeakSet<object>(),
): Promise<unknown> {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const dataUrl = mimeFromDataUrl(value);
    if (dataUrl) {
      return archiveBinary(ctx, parameterPath, dataUrl.mimeType, dataUrl.data, 'data-url');
    }
    if (isNativeBase64Field(key, parent)) {
      try {
        const bytes = Buffer.from(value.replace(/\s/g, ''), 'base64');
        if (bytes.byteLength > 0) {
          const filename = typeof parent?.filename === 'string' ? parent.filename : undefined;
          return archiveBinary(
            ctx,
            parameterPath,
            inferredMime(parent) ?? 'application/octet-stream',
            bytes,
            'base64',
            filename,
          );
        }
      } catch {
        // Preserve malformed/non-media strings for faithful diagnostics.
      }
    }
    return redactRemoteUrl(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function omitted]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  // Zod schemas are sometimes legitimate inputs to an agent SDK (notably the
  // Claude Agent SDK's in-process MCP tools). Object.entries(schema) exposes
  // Zod's large private implementation graph, however, and that graph is not
  // what the SDK serializes for the model. Zod 4 exposes the public JSON-Schema
  // projection on each schema; archive that provider-facing representation.
  const maybeZodSchema = value as { toJSONSchema?: () => unknown };
  if (typeof maybeZodSchema.toJSONSchema === 'function') {
    try {
      return await sanitizeValue(
        maybeZodSchema.toJSONSchema(),
        parameterPath,
        ctx,
        parent,
        key,
        seen,
      );
    } catch {
      return '[schema could not be serialized]';
    }
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      out.push(await sanitizeValue(value[i], `${parameterPath}[${i}]`, ctx, undefined, String(i), seen));
    }
    return out;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(source)) {
    if (isSecretKey(childKey)) {
      out[childKey] = '[redacted]';
      continue;
    }
    if (childKey === 'env') {
      out[childKey] = '[environment omitted]';
      continue;
    }
    if (childKey === 'signal' || childKey === 'abortSignal' || childKey === 'abortController') {
      out[childKey] = childKey === 'abortController' ? '[AbortController]' : '[AbortSignal]';
      continue;
    }
    if (
      childKey === 'path'
      && source.type === 'local_image'
      && typeof childValue === 'string'
    ) {
      try {
        out[childKey] = await archiveBinary(
          ctx,
          `${parameterPath}.${childKey}`,
          mimeFromFilename(childValue),
          await readArchiveLocalMedia(childValue),
          'file',
          path.basename(childValue),
        );
        continue;
      } catch (error) {
        if (error instanceof ModelTurnArchiveMemoryError) throw error;
        // Keep the sanitized path if an SDK-provided file is no longer readable.
      }
    }
    out[childKey] = await sanitizeValue(
      childValue,
      `${parameterPath}.${childKey}`,
      ctx,
      source,
      childKey,
      seen,
    );
  }
  return out;
}

async function writeAtomic(file: string, data: Buffer, durable = false): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', durable ? 0o600 : 0o666);
    let primary: unknown;
    try { await handle.writeFile(data); if (durable) await handle.sync(); }
    catch (error) { primary = error; throw error; }
    finally { await closeArchiveWriteHandle(handle, primary); }
    await fs.rename(temp, file);
  }
  catch (error) {
    // A descriptor with uncertain close still owns this file; preserve it.
    if (!(error instanceof ModelTurnArchiveMemoryError && error.code === 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP')) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  if (durable) {
    try {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await closeArchiveWriteHandle(directory); }
    } catch (error) {
      if (error instanceof ModelTurnArchiveMemoryError) throw error;
      /* directory fsync is unavailable on some Windows filesystems */
    }
  }
}

export interface ArchiveModelDispatchInput {
  /** Mandatory preallocated origin ID for a journalled native dispatch. */
  id?: string;
  durableContext?: FlowDurableMutationContext;
  conversationId: string;
  runId?: string;
  nodeId: string;
  nodeName?: string;
  modelId: string;
  modelName: string;
  adapter: string;
  operation: string;
  attempt: number;
  canonicalMessages: FlujoChatMessage[];
  genericWire: OpenAI.ChatCompletionMessageParam[];
  sdkRequest: unknown;
  modelInput?: ModelInputSnapshot;
  visualCompaction?: VisualCompactionDiagnostic;
}

export function archiveModelDispatch(
  input: ArchiveModelDispatchInput, prepare?: () => ArchiveModelDispatchInput,
): Promise<ModelTurnIndexEntry> {
  const payload = { canonicalMessages: input.canonicalMessages, genericWire: input.genericWire,
    sdkRequest: input.sdkRequest, modelInput: input.modelInput, visualCompaction: input.visualCompaction };
  return withArchiveWriteMemory(payload, () => withWorkspaceMutation(() => commitFlowDurableMutation(
    input.durableContext ?? {}, () => {
      recheckArchiveWriteMemory(payload);
      return archiveModelDispatchWithinMutation(prepare ? prepare() : input);
    },
  )));
}

async function archiveModelDispatchWithinMutation(
  input: ArchiveModelDispatchInput,
): Promise<ModelTurnIndexEntry> {
  const id = input.id ?? randomUUID();
  assertSafeId(id, 'dispatch id');
  if (input.id) {
    try {
      await fs.access(snapshotPath(input.conversationId, id));
      throw new Error('Native dispatch archive already exists; query the original invocation.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const ctx: SanitizeContext = {
    conversationId: input.conversationId,
    media: [],
    writes: new Map(),
  };
  const [canonicalMessages, genericWire, sdkRequest] = await settleArchiveWrites([
    sanitizeValue(input.canonicalMessages, 'canonicalMessages', ctx),
    sanitizeValue(input.genericWire, 'genericWire', ctx),
    sanitizeValue(input.sdkRequest, 'sdkRequest', ctx),
  ]);

  const entry: ModelTurnIndexEntry = {
    id,
    conversationId: input.conversationId,
    runId: input.runId,
    node: { nodeId: input.nodeId, nodeName: input.nodeName },
    modelId: input.modelId,
    modelName: input.modelName,
    adapter: input.adapter,
    operation: input.operation,
    timestamp: Date.now(),
    outcome: 'running',
    attempt: input.attempt,
    inputMode: input.modelInput?.inputMode,
    canonicalMessageCount: input.canonicalMessages.length,
    wireMessageCount: input.genericWire.length,
    mediaCount: ctx.media.length,
    archiveVersion: 2,
  };
  const snapshot: ModelTurnSnapshot = {
    version: 2,
    entry,
    canonicalMessages: canonicalMessages as FlujoChatMessage[],
    genericWire: genericWire as OpenAI.ChatCompletionMessageParam[],
    sdkRequest,
    media: ctx.media,
    provenance: input.modelInput?.provenance,
    counts: input.modelInput?.counts,
    visualCompaction: input.visualCompaction,
    contextCompaction: input.modelInput?.contextCompaction,
  };
  recheckArchiveWriteMemory(snapshot);

  await settleArchiveWrites([...ctx.writes.entries()].map(async ([sha256, bytes]) => {
    const target = mediaPath(input.conversationId, sha256);
    try {
      await fs.access(target);
    } catch {
      await writeAtomic(target, bytes, Boolean(input.id));
    }
  }));
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  await writeAtomic(snapshotPath(input.conversationId, id), compressed, Boolean(input.id));
  return entry;
}

export function updateModelDispatchOutcome(
  conversationId: string,
  dispatchId: string,
  outcome: Exclude<ModelDispatchOutcome, 'running'>,
  durableContext: FlowDurableMutationContext = {},
): Promise<void> {
  return withWorkspaceMutation(() => commitFlowDurableMutation(
    durableContext, () => updateModelDispatchOutcomeWithinMutation(conversationId, dispatchId, outcome),
  ));
}

async function updateModelDispatchOutcomeWithinMutation(
  conversationId: string,
  dispatchId: string,
  outcome: Exclude<ModelDispatchOutcome, 'running'>,
): Promise<void> {
  // A v2 outcome never reads, inflates, clones or rewrites the transcript/media.
  // Separate filenames let old v1 archives retain their original semantics.
  let version2 = true;
  try {
    await fs.access(snapshotPath(conversationId, dispatchId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    version2 = false;
  }
  if (version2) {
    const record = parseModelTurnOutcomeRecord({
      version: 1, archiveVersion: 2, conversationId, dispatchId, outcome,
    }, conversationId, dispatchId);
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    if (bytes.length > MODEL_TURN_OUTCOME_MAX_BYTES) throw new Error('Model-turn outcome exceeds byte limit');
    await writeAtomic(outcomePath(conversationId, dispatchId), bytes);
    return;
  }
  // Legacy compatibility retains its JSON shape and complete historical bytes.
  // Stream validation and the outcome edit instead of allocating a transcript
  // buffer, UTF-16 source, parsed object, and serialization for every update.
  const file = snapshotPath(conversationId, dispatchId, 1);
  await withModelTurnArchiveRead(() => rewriteLegacyModelTurnOutcome(file, outcome));
}

export function readModelTurnSnapshotResponse(
  conversationId: string, dispatchId: string, signal?: AbortSignal, framed = false,
): Promise<ReadableStream<Uint8Array> | undefined> {
  return withModelTurnArchiveResponse(async () => {
    let source;
    let version: 1 | 2 = 2;
    try { source = await fs.open(snapshotPath(conversationId, dispatchId), constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      version = 1;
      try { source = await fs.open(snapshotPath(conversationId, dispatchId, 1), constants.O_RDONLY | constants.O_NONBLOCK); }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw legacyError;
      }
    }
    let outcome;
    try { outcome = version === 2 ? await readOutcome(conversationId, dispatchId, signal) : undefined; }
    catch (error) { await closeModelTurnResponseDescriptor(source, error); throw error; }
    return prepareModelTurnSnapshotResponse(source, { version, conversationId, dispatchId }, outcome?.outcome, signal, framed);
  }, signal);
}

export async function readModelTurnSnapshot(
  conversationId: string,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<ModelTurnSnapshot | undefined> {
  return withModelTurnArchiveRead(() => readModelTurnSnapshotWithinAdmission(conversationId, dispatchId, signal), signal);
}

async function readModelTurnSnapshotWithinAdmission(
  conversationId: string,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<ModelTurnSnapshot | undefined> {
  let snapshot: ModelTurnSnapshot;
  try {
    snapshot = await readBoundedModelTurnJson<ModelTurnSnapshot>(snapshotPath(conversationId, dispatchId), undefined, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      return await readBoundedModelTurnJson<ModelTurnSnapshot>(snapshotPath(conversationId, dispatchId, 1), undefined, signal);
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw legacyError;
    }
  }
  if (snapshot.version !== 2 || snapshot.entry.archiveVersion !== 2
    || snapshot.entry.id !== dispatchId || snapshot.entry.conversationId !== conversationId
    || snapshot.entry.outcome !== 'running') throw new Error('Invalid v2 model-turn snapshot');
  const record = await readOutcome(conversationId, dispatchId, signal);
  if (record) snapshot.entry.outcome = record.outcome;
  return snapshot;
}

/** Bounded private read for native original/terminal reconciliation. */
export async function readNativeModelTurnSnapshot(
  conversationId: string, dispatchId: string, workspace: string,
  signal?: AbortSignal,
): Promise<ModelTurnSnapshot> {
  return withModelTurnArchiveRead(async () => {
    signal?.throwIfAborted();
    for (const directory of [archiveRoot(workspace), conversationDir(conversationId, workspace)]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Native model-turn archive directory is unsafe.');
      }
    }
    let bytes: Buffer;
    let version: 1 | 2 = 2;
    try {
      bytes = await readNativeArchiveFile(snapshotPath(conversationId, dispatchId, 2, workspace),
        8 * 1024 * 1024, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      version = 1;
      bytes = await readNativeArchiveFile(snapshotPath(conversationId, dispatchId, 1, workspace),
        8 * 1024 * 1024, signal);
    }
    const snapshot = JSON.parse((await gunzipAsync(bytes,
      { maxOutputLength: 32 * 1024 * 1024 })).toString('utf8')) as ModelTurnSnapshot;
    signal?.throwIfAborted();
    if (snapshot.version !== version || snapshot.entry?.archiveVersion !== version
      || snapshot.entry.id !== dispatchId || snapshot.entry.conversationId !== conversationId
      || !['running', 'completed', 'error', 'cancelled'].includes(snapshot.entry.outcome)
      || (version === 2 && snapshot.entry.outcome !== 'running')) {
      throw new Error('Invalid native model-turn snapshot');
    }
    if (version === 2) {
      let outcome: Buffer | undefined;
      try {
        outcome = await readNativeArchiveFile(outcomePath(conversationId, dispatchId, workspace),
          MODEL_TURN_OUTCOME_MAX_BYTES, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (outcome) snapshot.entry.outcome = parseModelTurnOutcomeRecord(
        JSON.parse(outcome.toString('utf8')), conversationId, dispatchId).outcome;
    }
    return snapshot;
  }, signal);
}

/** The private snapshot and V2 outcome share admission and the same strict
 * descriptor/path identity checks. No public inspection reader is substituted. */
async function readNativeArchiveFile(file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  // Open first with no-follow and validate the authoritative descriptor before
  // reading any body bytes. A pathname check is not permission to open later.
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== BigInt(1) || stat.size < BigInt(1) || stat.size > BigInt(maxBytes)
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
      || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) {
      throw new Error('Native model-turn archive changed.');
    }
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (BigInt(read) !== stat.size) throw new Error('Native model-turn archive changed.');
    const after = await handle.stat({ bigint: true });
    const finalPath = await fs.lstat(file, { bigint: true });
    if (!after.isFile() || after.nlink !== BigInt(1) || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
      || !finalPath.isFile() || finalPath.isSymbolicLink() || finalPath.nlink !== BigInt(1)
      || finalPath.dev !== stat.dev || finalPath.ino !== stat.ino
      || finalPath.size !== stat.size || finalPath.mtimeNs !== stat.mtimeNs
      || finalPath.ctimeNs !== stat.ctimeNs) throw new Error('Native model-turn archive changed.');
    signal?.throwIfAborted();
    return bytes.subarray(0, read);
  } finally { await handle.close(); }
}

export async function readModelTurnMedia(
  conversationId: string,
  dispatchId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<{ descriptor: ModelTurnMediaDescriptor; bytes: Buffer } | undefined> {
  return withModelTurnArchiveRead(() => readModelTurnMediaWithinAdmission(conversationId, dispatchId, mediaId, signal), signal);
}

async function readModelTurnMediaWithinAdmission(
  conversationId: string,
  dispatchId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<{ descriptor: ModelTurnMediaDescriptor; bytes: Buffer } | undefined> {
  // Snapshot + media share one slot; nested admission could reject the last
  // admitted media operation or count one pipeline twice.
  const snapshot = await readModelTurnSnapshotWithinAdmission(conversationId, dispatchId, signal);
  const descriptor = snapshot?.media.find(item => item.id === mediaId);
  if (!descriptor) return undefined;
  try {
    return {
      descriptor,
      bytes: await readBoundedModelTurnFile(mediaPath(conversationId, descriptor.sha256), MODEL_TURN_ARCHIVE_READ_LIMITS.mediaBytes, signal),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function deleteModelTurnArchive(conversationId: string): Promise<void> {
  return withWorkspaceMutation(() => deleteModelTurnArchiveWithinMutation(conversationId));
}

async function deleteModelTurnArchiveWithinMutation(conversationId: string): Promise<void> {
  const target = conversationDir(conversationId);
  const resolvedRoot = path.resolve(archiveRoot());
  const resolvedTarget = path.resolve(target);
  if (path.dirname(resolvedTarget) !== resolvedRoot) throw new Error('Unsafe model-turn archive deletion target');
  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

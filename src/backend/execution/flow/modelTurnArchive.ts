import { createHash, randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
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
import { mediaTypeFromMime } from '@/shared/types/model/media';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { commitFlowDurableMutation, type FlowDurableMutationContext } from './executionAuthority';

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

function snapshotPath(conversationId: string, dispatchId: string, workspace?: string): string {
  assertSafeId(dispatchId, 'dispatch id');
  return path.join(conversationDir(conversationId, workspace), `${dispatchId}.json.gz`);
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
          await fs.readFile(childValue),
          'file',
          path.basename(childValue),
        );
        continue;
      } catch {
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
  if (durable) {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
  } else {
    await fs.writeFile(temp, data);
  }
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
  if (durable) {
    try {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* directory fsync is unavailable on some Windows filesystems */ }
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

export function archiveModelDispatch(input: ArchiveModelDispatchInput): Promise<ModelTurnIndexEntry> {
  return withWorkspaceMutation(() => commitFlowDurableMutation(
    input.durableContext ?? {}, () => archiveModelDispatchWithinMutation(input),
  ));
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
  const [canonicalMessages, genericWire, sdkRequest] = await Promise.all([
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
    archiveVersion: 1,
  };
  const snapshot: ModelTurnSnapshot = {
    version: 1,
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

  await Promise.all([...ctx.writes.entries()].map(async ([sha256, bytes]) => {
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
  const file = snapshotPath(conversationId, dispatchId);
  const compressed = await fs.readFile(file);
  const snapshot = JSON.parse((await gunzipAsync(compressed)).toString('utf8')) as ModelTurnSnapshot;
  snapshot.entry.outcome = outcome;
  await writeAtomic(file, await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8')));
}

export async function readModelTurnSnapshot(
  conversationId: string,
  dispatchId: string,
  workspace?: string,
): Promise<ModelTurnSnapshot | undefined> {
  try {
    const compressed = await fs.readFile(snapshotPath(conversationId, dispatchId, workspace));
    return JSON.parse((await gunzipAsync(compressed)).toString('utf8')) as ModelTurnSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Bounded private read for native original/terminal reconciliation. */
export async function readNativeModelTurnSnapshot(
  conversationId: string, dispatchId: string, workspace: string,
): Promise<ModelTurnSnapshot> {
  for (const directory of [archiveRoot(workspace), conversationDir(conversationId, workspace)]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Native model-turn archive directory is unsafe.');
    }
  }
  const file = snapshotPath(conversationId, dispatchId, workspace);
  const entry = await fs.lstat(file, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== BigInt(1)
    || entry.size < BigInt(1) || entry.size > BigInt(8 * 1024 * 1024)) {
    throw new Error('Native model-turn archive is missing or unsafe.');
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== BigInt(1) || stat.size !== entry.size
      || stat.dev !== entry.dev || stat.ino !== entry.ino
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
      || current.dev !== entry.dev || current.ino !== entry.ino) {
      throw new Error('Native model-turn archive changed.');
    }
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (BigInt(read) !== stat.size) throw new Error('Native model-turn archive changed.');
    return JSON.parse((await gunzipAsync(bytes.subarray(0, read),
      { maxOutputLength: 32 * 1024 * 1024 })).toString('utf8')) as ModelTurnSnapshot;
  } finally { await handle.close(); }
}

export async function readModelTurnMedia(
  conversationId: string,
  dispatchId: string,
  mediaId: string,
): Promise<{ descriptor: ModelTurnMediaDescriptor; bytes: Buffer } | undefined> {
  const snapshot = await readModelTurnSnapshot(conversationId, dispatchId);
  const descriptor = snapshot?.media.find(item => item.id === mediaId);
  if (!descriptor) return undefined;
  try {
    return { descriptor, bytes: await fs.readFile(mediaPath(conversationId, descriptor.sha256)) };
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

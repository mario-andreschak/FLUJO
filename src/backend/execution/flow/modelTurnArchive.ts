import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
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

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

let archiveDirOverride: string | undefined;

const archiveRoot = () =>
  archiveDirOverride ?? path.join(getWorkspaceDataDir(), 'db', 'model-turns');

export function _setModelTurnArchiveDirForTests(dir: string | undefined): string | undefined {
  const previous = archiveDirOverride;
  archiveDirOverride = dir;
  return previous;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe ${label}`);
}

function conversationDir(conversationId: string): string {
  assertSafeId(conversationId, 'conversation id');
  return path.join(archiveRoot(), conversationId);
}

function snapshotPath(conversationId: string, dispatchId: string): string {
  assertSafeId(dispatchId, 'dispatch id');
  return path.join(conversationDir(conversationId), `${dispatchId}.json.gz`);
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
  return /(api[_-]?key|authorization|cookie|(?:^|[_-])(?:access[_-]?|refresh[_-]?|oauth[_-]?)?token$|secret|password)/i.test(key);
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

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

export interface ArchiveModelDispatchInput {
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

export async function archiveModelDispatch(
  input: ArchiveModelDispatchInput,
): Promise<ModelTurnIndexEntry> {
  const id = randomUUID();
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
  };

  await Promise.all([...ctx.writes.entries()].map(async ([sha256, bytes]) => {
    const target = mediaPath(input.conversationId, sha256);
    try {
      await fs.access(target);
    } catch {
      await writeAtomic(target, bytes);
    }
  }));
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  await writeAtomic(snapshotPath(input.conversationId, id), compressed);
  return entry;
}

export async function updateModelDispatchOutcome(
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
): Promise<ModelTurnSnapshot | undefined> {
  try {
    const compressed = await fs.readFile(snapshotPath(conversationId, dispatchId));
    return JSON.parse((await gunzipAsync(compressed)).toString('utf8')) as ModelTurnSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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

export async function deleteModelTurnArchive(conversationId: string): Promise<void> {
  const target = conversationDir(conversationId);
  const resolvedRoot = path.resolve(archiveRoot());
  const resolvedTarget = path.resolve(target);
  if (path.dirname(resolvedTarget) !== resolvedRoot) throw new Error('Unsafe model-turn archive deletion target');
  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

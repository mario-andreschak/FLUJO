/**
 * Opening and unpacking an MCP bundle file (#1230) without trusting it.
 *
 * - Every name in the zip is checked before anything is written: no absolute
 *   paths, no `..`, no drive letters, no names Windows cannot store. A bad
 *   name refuses the whole bundle ("zip slip").
 * - Sizes are checked twice: the sizes the zip claims (before unpacking) and
 *   the bytes that really come out (while unpacking). A file that grows past
 *   the size it claims stops the unpacking at once, so a zip bomb stops early.
 * - Files are streamed to disk, a few at a time, and never executed here.
 *
 * Limits: the upload passes FLUJO's request proxy, which keeps at most
 * `proxyClientMaxBodySize` (next.config.mjs) of a request body, and the whole
 * file sits in memory while it is read, so the file limit follows the smaller
 * of that and the computer's memory. The unpacked limit is disk space and
 * scales with memory too. A bundle that is too big is refused with its size and
 * the limit; nothing stays blocked, so the next file can be tried at once.
 */
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { createHash } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import JSZip from 'jszip';
import type { McpbSignature } from '@/shared/types/mcp/mcpb';
import { McpbError } from './manifest';
import { checkMcpbSignature, feedInChunks, splitMcpbSignature } from './signature';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const WRITE_CONCURRENCY = 8;

export interface McpbLimits {
  /** Largest bundle file accepted. */
  bundleBytes: number;
  /** Largest total size after unpacking. */
  unpackedBytes: number;
  /** Most files in one bundle. */
  entries: number;
  /** Largest manifest.json. */
  manifestBytes: number;
}

/** Must stay below `proxyClientMaxBodySize` in next.config.mjs (checked by a test). */
export const MCPB_UPLOAD_CEILING_BYTES = 99 * MIB;

/**
 * File: 1/32 of the memory, at least 32 MB, at most {@link MCPB_UPLOAD_CEILING_BYTES}.
 * Unpacked: 1/4 of the memory, between 1 GB and 8 GB.
 */
export function mcpbLimits(totalMemory: number = os.totalmem()): McpbLimits {
  const bundleBytes = Math.min(MCPB_UPLOAD_CEILING_BYTES, Math.max(32 * MIB, Math.floor(totalMemory / 32)));
  const unpackedBytes = Math.min(8 * GIB, Math.max(GIB, Math.floor(totalMemory / 4)));
  return { bundleBytes, unpackedBytes, entries: 200_000, manifestBytes: 4 * MIB };
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** SHA-256 of the whole file, in chunks so a big bundle never stalls the app. */
export async function digestBytes(bytes: Buffer): Promise<string> {
  const hash = createHash('sha256');
  await feedInChunks([bytes], (chunk) => hash.update(chunk));
  return hash.digest('hex');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Check one name from the zip and return it with `/` separators. Throws for
 * names that would land outside the bundle folder or that some computers
 * cannot store, so a bundle unpacks the same on Windows, macOS and Linux.
 */
export function checkEntryPath(name: string): string {
  const portable = name.replace(/\\/g, '/').replace(/\/+$/, '');
  const refuse = () => new McpbError(
    `This bundle tries to put a file outside its own folder, or uses a file name computers cannot store ("${name.slice(0, 160)}"). FLUJO will not install it.`,
    'unsafe-path',
  );
  if (!portable || /[\u0000-\u001f]/.test(portable) || portable.startsWith('/') || portable.includes(':')) throw refuse();
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
    || WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment) || /[<>"|?*]/.test(segment))) {
    throw refuse();
  }
  return segments.join('/');
}

export interface McpbArchiveEntry {
  path: string;
  /** The size the zip claims; undefined when JSZip does not expose it. */
  declaredBytes?: number;
  executable: boolean;
  object: JSZip.JSZipObject;
}

export interface OpenedMcpbArchive {
  digest: string;
  packedBytes: number;
  signature: McpbSignature;
  manifestText: string;
  entries: McpbArchiveEntry[];
  files: ReadonlySet<string>;
  unpackedBytes: number;
}

function declaredSize(object: JSZip.JSZipObject): number | undefined {
  const data: unknown = Reflect.get(object, '_data');
  const size = data && typeof data === 'object' ? Reflect.get(data, 'uncompressedSize') : undefined;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

function unixMode(object: JSZip.JSZipObject): number | undefined {
  const raw = object.unixPermissions;
  const mode = typeof raw === 'string' ? Number.parseInt(raw, 8) : raw;
  return typeof mode === 'number' && Number.isFinite(mode) ? mode : undefined;
}

const SYMLINK_TYPE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

async function loadZip(bytes: Buffer, content: Buffer): Promise<JSZip> {
  const notZip = () => new McpbError('This file is not an MCP bundle: it is not a readable zip file.', 'not-a-bundle');
  try {
    return await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    if (content === bytes) throw notZip();
  }
  try {
    return await JSZip.loadAsync(content, { checkCRC32: false, createFolders: false });
  } catch {
    throw notZip();
  }
}

/** Read the zip's table of contents, manifest.json and signature. Nothing is written. */
export async function openMcpbArchive(bytes: Buffer, limits: McpbLimits = mcpbLimits()): Promise<OpenedMcpbArchive> {
  if (bytes.length > limits.bundleBytes) {
    throw new McpbError(
      `This bundle is ${formatBytes(bytes.length)}. FLUJO accepts bundles up to ${formatBytes(limits.bundleBytes)} on this computer.`,
      'too-large',
      413,
    );
  }
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new McpbError('This file is not an MCP bundle: it is not a zip file.', 'not-a-bundle');
  }
  const split = splitMcpbSignature(bytes);
  const [digest, zip, signature] = await Promise.all([
    digestBytes(bytes),
    loadZip(bytes, split.content),
    checkMcpbSignature(bytes, split),
  ]);

  const entries: McpbArchiveEntry[] = [];
  const files = new Set<string>();
  let unpackedBytes = 0;
  let manifestObject: JSZip.JSZipObject | undefined;
  for (const object of Object.values(zip.files)) {
    const entryPath = checkEntryPath(object.unsafeOriginalName ?? object.name);
    if (object.dir) continue;
    const mode = unixMode(object);
    if (mode !== undefined && (mode & FILE_TYPE_MASK) === SYMLINK_TYPE) continue;
    if (entries.length >= limits.entries) {
      throw new McpbError(`This bundle holds more than ${limits.entries.toLocaleString('en-US')} files, more than FLUJO unpacks.`, 'too-large', 413);
    }
    const declaredBytes = declaredSize(object);
    unpackedBytes += declaredBytes ?? 0;
    entries.push({
      path: entryPath,
      ...(declaredBytes !== undefined ? { declaredBytes } : {}),
      executable: mode !== undefined && (mode & 0o111) !== 0,
      object,
    });
    files.add(entryPath);
    if (entryPath === 'manifest.json') manifestObject = object;
  }
  if (unpackedBytes > limits.unpackedBytes) {
    throw new McpbError(
      `This bundle unpacks to ${formatBytes(unpackedBytes)}. FLUJO unpacks at most ${formatBytes(limits.unpackedBytes)} on this computer.`,
      'too-large',
      413,
    );
  }
  if (!manifestObject) {
    throw new McpbError('This file has no manifest.json at its top level, so it is not an MCP bundle.', 'not-a-bundle');
  }
  if ((declaredSize(manifestObject) ?? 0) > limits.manifestBytes) {
    throw new McpbError('The bundle’s manifest.json is too large to be real.', 'invalid-manifest');
  }
  let manifestText: string;
  try {
    manifestText = await manifestObject.async('string');
  } catch {
    throw new McpbError('The bundle’s manifest.json cannot be read; the file may be damaged.', 'not-a-bundle');
  }
  return { digest, packedBytes: bytes.length, signature, manifestText, entries, files, unpackedBytes };
}

/** Free space where the bundle goes, or undefined when the system cannot tell. */
async function freeBytes(directory: string): Promise<number | undefined> {
  try {
    const stats = await fs.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

export async function assertFreeSpace(directory: string, neededBytes: number): Promise<void> {
  const available = await freeBytes(directory);
  const margin = 64 * MIB;
  if (available !== undefined && available < neededBytes + margin) {
    throw new McpbError(
      `Not enough free disk space: the bundle needs about ${formatBytes(neededBytes)}, and ${formatBytes(available)} is free.`,
      'disk-full',
      507,
    );
  }
}

/**
 * Write every file into `targetDir`, which must be new and empty. Counts the
 * real bytes as they come out and stops when they pass the limit.
 */
export async function unpackMcpbArchive(
  archive: OpenedMcpbArchive,
  targetDir: string,
  limits: McpbLimits = mcpbLimits(),
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const root = path.resolve(targetDir);
  const madeDirectories = new Set<string>([root]);
  let written = 0;
  const tooLarge = () => new McpbError(
    `This bundle unpacks to more than ${formatBytes(limits.unpackedBytes)}, more than it claims. FLUJO stopped unpacking it.`,
    'too-large',
    413,
  );

  const writeEntry = async (entry: McpbArchiveEntry): Promise<void> => {
    const target = path.resolve(root, ...entry.path.split('/'));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new McpbError(`This bundle tries to put a file outside its own folder ("${entry.path}"). FLUJO will not install it.`, 'unsafe-path');
    }
    const directory = path.dirname(target);
    if (!madeDirectories.has(directory)) {
      await fs.mkdir(directory, { recursive: true });
      madeDirectories.add(directory);
    }
    let entryWritten = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        entryWritten += chunk.length;
        if (written > limits.unpackedBytes) callback(tooLarge());
        else if (entry.declaredBytes !== undefined && entryWritten > entry.declaredBytes) {
          callback(new McpbError(`"${entry.path}" in this bundle is bigger than the bundle says. The file is damaged or unsafe; FLUJO stopped unpacking it.`, 'unsafe-path'));
        } else callback(null, chunk);
      },
    });
    const mode = process.platform === 'win32' ? undefined : entry.executable ? 0o755 : 0o644;
    try {
      await pipeline(entry.object.nodeStream('nodebuffer'), counter, createWriteStream(target, { flags: 'wx', ...(mode ? { mode } : {}) }));
    } catch (error) {
      if (error instanceof McpbError) throw error;
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') {
        throw new McpbError(`This bundle lists "${entry.path}" twice, or as both a file and a folder. FLUJO will not install it.`, 'unsafe-path');
      }
      if (code === 'ENOSPC') throw new McpbError('The disk ran out of space while unpacking the bundle.', 'disk-full', 507);
      throw error;
    }
  };

  const queue = [...archive.entries];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      try {
        await writeEntry(entry);
      } catch (error) {
        queue.length = 0;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(WRITE_CONCURRENCY, queue.length) }, worker);
  const results = await Promise.allSettled(workers);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

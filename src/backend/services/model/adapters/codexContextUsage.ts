import path from 'path';
import { constants, promises as fs, type Dirent } from 'fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zstdConstants, createZstdDecompress } from 'node:zlib';
import type { ModelContextUsage } from '@/shared/types/model/contextUsage';
import type { CodexUsageLike } from './codexUsage';

export interface CodexTokenSnapshot {
  timestamp: number;
  totalUsage: CodexUsageLike;
  contextUsage: ModelContextUsage;
}

const rolloutPaths = new Map<string, string>();
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_SEARCH_ENTRIES = 16384;

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Only token-count events are consumed; transcript content is never returned. */
export function parseCodexTokenSnapshot(line: string): CodexTokenSnapshot | undefined {
  if (!line.includes('"token_count"')) return undefined;
  try {
    const event = JSON.parse(line);
    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return undefined;
    const info = event.payload.info;
    const total = info?.total_token_usage;
    const last = info?.last_token_usage;
    if (!total || !last) return undefined;
    for (const usage of [total, last]) {
      if (!tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens)) return undefined;
      for (const field of ['cached_input_tokens', 'cache_write_input_tokens']) {
        if (usage[field] != null && (!tokenCount(usage[field]) || usage[field] > usage.input_tokens)) {
          return undefined;
        }
      }
      if (usage.reasoning_output_tokens != null
        && (!tokenCount(usage.reasoning_output_tokens) || usage.reasoning_output_tokens > usage.output_tokens)) return undefined;
    }
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) return undefined;
    const contextTotal = last.input_tokens + last.output_tokens;
    if (!tokenCount(contextTotal) || (last.total_tokens != null && last.total_tokens !== contextTotal)) return undefined;
    const contextWindow = info.model_context_window;
    return {
      timestamp,
      totalUsage: {
        input_tokens: total.input_tokens,
        output_tokens: total.output_tokens,
        ...(total.cached_input_tokens != null ? { cached_input_tokens: total.cached_input_tokens } : {}),
        ...(total.cache_write_input_tokens != null ? { cache_write_input_tokens: total.cache_write_input_tokens } : {}),
        ...(total.reasoning_output_tokens != null ? { reasoning_output_tokens: total.reasoning_output_tokens } : {}),
      },
      contextUsage: {
        promptTokens: last.input_tokens,
        completionTokens: last.output_tokens,
        totalTokens: contextTotal,
        ...(tokenCount(contextWindow) && contextWindow > 0 ? { contextWindow, contextWindowSource: 'runtime' as const } : {}),
      },
    };
  } catch {
    // A live JSONL writer may not have finished its final line yet.
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function safeParents(home: string, file: string): Promise<void> {
  const root = path.resolve(home, 'sessions');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Rollout escaped its sessions directory.');
  let directory = root;
  for (const component of ['', ...path.dirname(relative).split(path.sep).filter(value => value !== '.')]) {
    if (component) directory = path.join(directory, component);
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) {
      throw new Error('Rollout directory is not a regular owned directory.');
    }
  }
}

/** The shipping writer materializes plain JSONL before append; plain wins. */
async function representation(home: string, plain: string): Promise<string | undefined> {
  await safeParents(home, plain);
  for (const file of [plain, `${plain}.zst`]) {
    try {
      const stats = await fs.lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink() || !samePath(await fs.realpath(file), file)) {
        throw new Error('Rollout is not a regular owned file.');
      }
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function findRollout(home: string, threadId: string): Promise<string | undefined> {
  // IDs come from Codex, but never allow them to become paths or glob patterns.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) return undefined;
  home = path.resolve(home);
  threadId = threadId.toLowerCase();
  const key = `${home}\0${threadId}`;
  const cached = rolloutPaths.get(key);
  if (cached) {
    try {
      if (await representation(home, cached)) return cached;
    } catch {
      rolloutPaths.delete(key);
    }
  }
  const pending = [{ directory: path.join(home, 'sessions'), depth: 0 }];
  let visited = 0;
  let searched = 0;
  while (pending.length && visited++ < 4096) {
    const { directory, depth } = pending.pop()!;
    await safeParents(home, path.join(directory, 'placeholder.jsonl'));
    const entries: Dirent[] = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES || ++searched > MAX_SEARCH_ENTRIES) return undefined;
      entries.push(entry);
    }
    for (const entry of entries) {
      const name = entry.name.toLowerCase().replace(/\.zst$/, '');
      if (entry.isFile() && name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)) {
        const file = path.join(directory, entry.name.replace(/\.zst$/i, ''));
        if (!(await representation(home, file))) continue;
        if (rolloutPaths.size >= 256) rolloutPaths.delete(rolloutPaths.keys().next().value!);
        rolloutPaths.set(key, file);
        return file;
      }
    }
    // Only the runtime's YYYY/MM/DD hierarchy; never follow symlinks.
    if (depth < 3) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) {
          pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
        }
      }
    }
  }
  return undefined;
}

function latestInTail(bytes: Buffer, beginsAtStart: boolean): CodexTokenSnapshot | undefined {
  let start = 0;
  if (!beginsAtStart) {
    start = bytes.indexOf(10) + 1;
    if (start === 0) return undefined;
  }
  // A valid Zstandard frame with an incomplete JSON record is still unavailable.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  if (text.length && !text.endsWith('\n')) return undefined;
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const snapshot = parseCodexTokenSnapshot(line);
    if (snapshot) return snapshot;
    if (line.includes('"token_count"')) return undefined;
  }
  return undefined;
}

async function compressedSnapshot(handle: Awaited<ReturnType<typeof fs.open>>, size: number): Promise<CodexTokenSnapshot | undefined> {
  if (size <= 0 || size > MAX_TAIL_BYTES || typeof createZstdDecompress !== 'function') return undefined;
  const tail = Buffer.alloc(MAX_TAIL_BYTES);
  let offset = 0;
  let decoded = 0;
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
    decoded += chunk.length;
    if (decoded > MAX_DECODED_BYTES) { done(new Error('Decoded rollout exceeds its read budget.')); return; }
    const first = Math.min(chunk.length, tail.length - offset);
    chunk.copy(tail, offset, 0, first);
    if (first < chunk.length) chunk.copy(tail, 0, first);
    offset = (offset + chunk.length) % tail.length;
    done();
  } });
  // zstd level-3 shipping frames fit this window; refuse larger windows before
  // decoder allocation. Input, output, retained tail and native window are bounded.
  const decoder = createZstdDecompress({ chunkSize: READ_BLOCK_BYTES,
    params: { [zstdConstants.ZSTD_d_windowLogMax]: 23 } });
  await pipeline(handle.createReadStream({ autoClose: false, start: 0, end: size - 1 }), decoder, sink);
  const bytes = decoded <= tail.length ? tail.subarray(0, decoded)
    : Buffer.concat([tail.subarray(offset), tail.subarray(0, offset)]);
  return latestInTail(bytes, decoded <= tail.length);
}

async function plainSnapshot(handle: Awaited<ReturnType<typeof fs.open>>, size: number): Promise<CodexTokenSnapshot | undefined> {
  const lowerBound = Math.max(0, size - MAX_TAIL_BYTES);
  let position = size;
  let suffix = Buffer.alloc(0);
  while (position > lowerBound) {
    const length = Math.min(READ_BLOCK_BYTES, position - lowerBound);
    position -= length;
    const block = Buffer.alloc(length);
    const { bytesRead } = await handle.read(block, 0, length, position);
    const combined = Buffer.concat([block.subarray(0, bytesRead), suffix]);
    let end = combined.length;
    for (let index = combined.length - 1; index >= 0; index--) {
      if (combined[index] !== 10) continue;
      const line = combined.subarray(index + 1, end).toString('utf8');
      const snapshot = parseCodexTokenSnapshot(line);
      if (snapshot) return snapshot;
      if (line.includes('"token_count"')) {
        // Skip a partial final write, never a completed invalid latest counter.
        if (position + end < size) return undefined;
        try {
          const event = JSON.parse(line);
          if (event?.type === 'event_msg' && event.payload?.type === 'token_count') return undefined;
        } catch { /* The live writer may still be completing its final record. */ }
      }
      end = index;
    }
    suffix = combined.subarray(0, end);
  }
  return position === 0 ? parseCodexTokenSnapshot(suffix.toString('utf8')) : undefined;
}

/**
 * The SDK exposes aggregate turn/thread usage, not current context. Read the
 * latest native token_count from FLUJO's own persistent Codex home instead.
 * Reads are bounded and optional: a missing/changed rollout yields unknown.
 */
export async function readCodexTokenSnapshot(home: string, threadId: string): Promise<CodexTokenSnapshot | undefined> {
  try {
    const plain = await findRollout(home, threadId);
    if (!plain) return undefined;
    // A compression/materialization rename may occur between discovery and open.
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await representation(path.resolve(home), plain);
      if (!file) return undefined;
      const before = await fs.lstat(file);
      let handle;
      try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || before.dev !== stats.dev || before.ino !== stats.ino) return undefined;
        await safeParents(path.resolve(home), file);
        if (!samePath(await fs.realpath(file), file)) return undefined;
        const { size } = stats;
        if (!Number.isSafeInteger(size) || size < 0) return undefined;
        if (file.endsWith('.zst')) {
          const snapshot = await compressedSnapshot(handle, size);
          const after = await handle.stat();
          if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) return undefined;
          if ((await representation(path.resolve(home), plain)) !== file) continue;
          return snapshot;
        }
        return await plainSnapshot(handle, size);
      } finally {
        await handle.close();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

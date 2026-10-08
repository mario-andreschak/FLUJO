import path from 'path';
import { promises as fs } from 'fs';
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
    }
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) return undefined;
    const contextWindow = info.model_context_window;
    return {
      timestamp,
      totalUsage: {
        input_tokens: total.input_tokens,
        output_tokens: total.output_tokens,
        ...(total.cached_input_tokens != null ? { cached_input_tokens: total.cached_input_tokens } : {}),
        ...(total.cache_write_input_tokens != null ? { cache_write_input_tokens: total.cache_write_input_tokens } : {}),
      },
      contextUsage: {
        promptTokens: last.input_tokens,
        completionTokens: last.output_tokens,
        totalTokens: tokenCount(last.total_tokens)
          ? last.total_tokens
          : last.input_tokens + last.output_tokens,
        ...(tokenCount(contextWindow) && contextWindow > 0 ? { contextWindow, contextWindowSource: 'runtime' as const } : {}),
      },
    };
  } catch {
    // A live JSONL writer may not have finished its final line yet.
    return undefined;
  }
}

async function findRollout(home: string, threadId: string): Promise<string | undefined> {
  // IDs come from Codex, but never allow them to become paths or glob patterns.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) return undefined;
  const key = `${home}\0${threadId}`;
  const cached = rolloutPaths.get(key);
  if (cached) {
    try {
      await fs.access(cached);
      return cached;
    } catch {
      rolloutPaths.delete(key);
    }
  }
  const pending = [{ directory: path.join(home, 'sessions'), depth: 0 }];
  let visited = 0;
  while (pending.length && visited++ < 4096) {
    const { directory, depth } = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
        const file = path.join(directory, entry.name);
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

/**
 * The SDK exposes aggregate turn/thread usage, not current context. Read the
 * latest native token_count from FLUJO's own persistent Codex home instead.
 * Reads are bounded and optional: a missing/changed rollout yields unknown.
 */
export async function readCodexTokenSnapshot(home: string, threadId: string): Promise<CodexTokenSnapshot | undefined> {
  try {
    const file = await findRollout(home, threadId);
    if (!file) return undefined;
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
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
        for (let i = combined.length - 1; i >= 0; i--) {
          if (combined[i] !== 10) continue;
          const snapshot = parseCodexTokenSnapshot(combined.subarray(i + 1, end).toString('utf8'));
          if (snapshot) return snapshot;
          end = i;
        }
        suffix = combined.subarray(0, end);
      }
      return position === 0 ? parseCodexTokenSnapshot(suffix.toString('utf8')) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

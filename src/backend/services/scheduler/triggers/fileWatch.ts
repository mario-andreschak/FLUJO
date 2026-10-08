import path from 'path';
import { realpathSync } from 'fs';
import { watch } from 'chokidar';
import { FileWatchEvent, FileWatchTriggerConfig } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { ArmedTrigger } from './types';

const log = createLogger('backend/services/scheduler/triggers/fileWatch');

/** A burst of file events batched into one fire. */
export interface FileWatchFire {
  events: Array<{ event: FileWatchEvent; path: string }>;
  /** First observation time for this debounced batch. */
  observedAt: string;
}

const DEFAULT_DEBOUNCE_MS = 2000;
/** Cap the batched event list so a mass copy can't bloat the run prompt. */
const MAX_BATCHED_EVENTS = 50;

// Convert a simple glob (`*`, `**`, `?`) into a RegExp over the path relative
// to the watched root, using forward slashes. Chokidar v4+ dropped built-in
// glob support, so we filter ourselves; this deliberately supports only the
// common cases (e.g. `*.pdf`, or `reports/**/*.csv` for nested folders).
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches all.
        i++;
        if (normalized[i + 1] === '/') {
          i++;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Arm a chokidar watcher for a file-watch trigger. Events are filtered by the
 * configured kinds (+ optional glob) and batched: the trigger fires once per
 * quiet window (debounceMs), not once per file, so dropping 20 files into a
 * folder produces ONE run with all 20 events in its context.
 */
export function armFileWatch(
  config: FileWatchTriggerConfig,
  onFire: (payload: FileWatchFire) => void | Promise<void>,
  onError: (message: string) => void
): ArmedTrigger {
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const wanted = new Set<FileWatchEvent>(config.events);
  const glob = config.glob?.trim() ? globToRegExp(config.glob.trim()) : null;

  // Resolve to the real (long-form) path before watching. On Windows, handing
  // libuv an 8.3 short path (e.g. C:\Users\MARIOA~1\...) trips an assertion in
  // fs-event.c that CRASHES the whole process when events arrive — and this
  // also fails fast on paths that don't exist.
  let root: string;
  try {
    root = realpathSync.native(config.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Cannot watch "${config.path}": ${message}`);
    onError(`Cannot watch "${config.path}": ${message}`);
    return { dispose: () => undefined };
  }

  let pending: Array<{ event: FileWatchEvent; path: string }> = [];
  let observedAt: string | null = null;
  let overflowed = false;
  let nextPending: Array<{ event: FileWatchEvent; path: string }> = [];
  let nextObservedAt: string | null = null;
  let nextOverflowed = false;
  let flushing = false;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const scheduleFlush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, debounceMs);
    timer.unref?.();
  };

  const flush = async () => {
    timer = null;
    if (disposed || flushing || pending.length === 0) {
      return;
    }
    flushing = true;
    const events = [...pending];
    const batchObservedAt = observedAt ?? new Date().toISOString();
    if (overflowed) {
      log.info(`File-watch batch overflowed; reporting first ${MAX_BATCHED_EVENTS} events`);
    }
    try {
      // Persona callers persist a durable batch intent here. Do not release the
      // process-local batch until that write has completed successfully.
      await onFire({ events, observedAt: batchObservedAt });
      pending = nextPending;
      observedAt = nextObservedAt;
      overflowed = nextOverflowed;
      nextPending = [];
      nextObservedAt = null;
      nextOverflowed = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to persist file-watch batch for ${root}: ${message}`);
      onError(message);
    } finally {
      flushing = false;
      if (!disposed && pending.length > 0) scheduleFlush();
    }
  };

  const watcher = watch(root, {
    ignoreInitial: true,
    // Don't fire while a file is still being written into the folder.
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('all', (event, filePath) => {
    if (disposed) {
      return;
    }
    if (event !== 'add' && event !== 'change' && event !== 'unlink') {
      return; // directory events are not part of the trigger contract
    }
    if (!wanted.has(event)) {
      return;
    }
    if (glob) {
      const relative = path.relative(root, filePath).replace(/\\/g, '/');
      // For a single watched FILE the relative path is '', match the basename.
      const candidate = relative || path.basename(filePath);
      if (!glob.test(candidate)) {
        return;
      }
    }
    const target = flushing ? nextPending : pending;
    if (target.length >= MAX_BATCHED_EVENTS) {
      if (flushing) nextOverflowed = true;
      else overflowed = true;
    } else {
      const now = new Date().toISOString();
      if (flushing) nextObservedAt ??= now;
      else observedAt ??= now;
      target.push({ event, path: filePath });
    }
    scheduleFlush();
  });

  watcher.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Watcher error for ${root}: ${message}`);
    onError(message);
  });

  return {
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = [];
      observedAt = null;
      nextPending = [];
      nextObservedAt = null;
      void watcher.close().catch(error =>
        log.warn(`Failed to close watcher for ${root}:`, error)
      );
    },
  };
}

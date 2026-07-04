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
  onFire: (payload: FileWatchFire) => void,
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
  let overflowed = false;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    if (disposed || pending.length === 0) {
      return;
    }
    const events = pending;
    if (overflowed) {
      log.info(`File-watch batch overflowed; reporting first ${MAX_BATCHED_EVENTS} events`);
    }
    pending = [];
    overflowed = false;
    onFire({ events });
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
    if (pending.length >= MAX_BATCHED_EVENTS) {
      overflowed = true;
    } else {
      pending.push({ event, path: filePath });
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
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
      void watcher.close().catch(error =>
        log.warn(`Failed to close watcher for ${root}:`, error)
      );
    },
  };
}

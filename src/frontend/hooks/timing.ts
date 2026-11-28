"use client";

import { useEffect, useMemo, useState } from 'react';
import { useLatest } from './useLatest';

// The only place UI code may start raw timers (lint rule flujo/no-raw-timers).
// Each hook owns its timer and clears it on unmount, so timers cannot leak or pile up.

/** Runs `callback` once, `delayMs` after the delay is set. `null` disarms it. A new `delayMs` or `restartKey` restarts it. */
export function useTimeout(callback: () => void, delayMs: number | null, restartKey?: unknown): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (delayMs === null) return undefined;
    const id = setTimeout(() => latest.current(), delayMs);
    return () => clearTimeout(id);
  }, [delayMs, restartKey, latest]);
}

// Browsers run a timer at once when its delay does not fit in 32 bits.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Returns whether the clock has reached `at` (ms since epoch) and re-renders when it does.
 * `undefined` is never reached. The clock is read on mount and in timers, never while re-rendering.
 */
export function useReachedAt(at: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const reached = at !== undefined && at <= now;
  useEffect(() => {
    if (at === undefined || reached) return undefined;
    const waitMs = (current: number) => Math.min(Math.max(at - current, 0), MAX_TIMER_DELAY_MS);
    const check = () => {
      const current = Date.now();
      if (current >= at) setNow(current);
      else id = setTimeout(check, waitMs(current));
    };
    let id = setTimeout(check, waitMs(Date.now()));
    return () => clearTimeout(id);
  }, [at, reached]);
  return reached;
}

/** Runs `callback` every `delayMs`. `null` pauses it. */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (delayMs === null) return undefined;
    const id = setInterval(() => latest.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs, latest]);
}

/** Returns `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}

export interface DebouncedCallback<Args extends unknown[]> {
  (...args: Args): void;
  /** Drops the pending call. */
  cancel(): void;
  /** Runs the pending call now, if there is one. */
  flush(): void;
}

function createDebouncer<Args extends unknown[]>(
  call: (...args: Args) => void,
  delayMs: () => number,
): DebouncedCallback<Args> {
  let id: ReturnType<typeof setTimeout> | undefined;
  let pending: Args | undefined;
  const cancel = () => {
    clearTimeout(id);
    id = undefined;
    pending = undefined;
  };
  const flush = () => {
    const args = pending;
    cancel();
    if (args) call(...args);
  };
  return Object.assign((...args: Args) => {
    clearTimeout(id);
    pending = args;
    id = setTimeout(flush, delayMs());
  }, { cancel, flush });
}

/** Returns a stable function that calls `callback` with the latest arguments once calls stop for `delayMs`. */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
): DebouncedCallback<Args> {
  const latest = useLatest(callback);
  const delay = useLatest(delayMs);
  const debounced = useMemo(
    () => createDebouncer<Args>((...args) => latest.current(...args), () => delay.current),
    [latest, delay],
  );
  useEffect(() => debounced.cancel, [debounced]);
  return debounced;
}

/** When a later call runs: after this many milliseconds, or on the next animation frame. */
export type LaterDelay = number | 'frame';

export interface Later {
  /** Runs `callback` once after `delay`, replacing a call that is still pending. */
  (callback: () => void, delay: LaterDelay): void;
  /** Drops the pending call. */
  cancel(): void;
}

function startLater(run: () => void, delay: LaterDelay): () => void {
  if (delay === 'frame' && typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => run());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, delay === 'frame' ? 16 : delay);
  return () => clearTimeout(id);
}

function createLater(): Later {
  let stop: (() => void) | undefined;
  const cancel = () => {
    stop?.();
    stop = undefined;
  };
  return Object.assign((callback: () => void, delay: LaterDelay) => {
    cancel();
    stop = startLater(() => {
      stop = undefined;
      callback();
    }, delay);
  }, { cancel });
}

/**
 * Returns a stable function that runs one callback later, such as focusing a field on the next
 * frame or hiding a "Copied" note. A new call replaces the pending one and unmounting drops it,
 * so calls cannot pile up or outlive the component.
 */
export function useLater(): Later {
  const later = useMemo(() => createLater(), []);
  useEffect(() => later.cancel, [later]);
  return later;
}

export interface FrameLoop {
  /** Starts the loop, unless it already runs. */
  start(): void;
  stop(): void;
}

/**
 * A paint loop for canvas animation: `tick(now)` runs on every animation frame until it returns
 * false or `stop()` is called; `start()` resumes it. Its owner stops it when it unmounts.
 */
export function frameLoop(tick: (now: number) => boolean): FrameLoop {
  let id = 0;
  const frame = (now: number) => {
    id = 0;
    if (tick(now)) id = requestAnimationFrame(frame);
  };
  return {
    start() {
      if (!id) id = requestAnimationFrame(frame);
    },
    stop() {
      if (id) cancelAnimationFrame(id);
      id = 0;
    },
  };
}

"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

// The only place UI code may start raw timers (lint rule flujo/no-raw-timers).
// Each hook owns its timer and clears it on unmount, so timers cannot leak or pile up.

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

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

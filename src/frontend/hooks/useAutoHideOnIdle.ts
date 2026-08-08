"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAutoHideOnIdleOptions {
  /**
   * Whether auto-hiding applies at all. Typically
   * `useMediaQuery(theme.breakpoints.down('sm'))` so desktop behaviour is
   * unchanged and only mobile hides the controls.
   */
  enabled: boolean;
  /** Idle time before hiding. */
  idleMs?: number;
}

export interface UseAutoHideOnIdleResult {
  visible: boolean;
  /** Reveal the controls and (re)start the idle timer. */
  poke: () => void;
}

/**
 * Visibility timer for the scroll navigation cluster (#376).
 *
 * `enabled === false` ⇒ always visible and no timer is ever armed.
 * `enabled === true`  ⇒ visible until `idleMs` elapses without a `poke()`;
 * consumers call `poke()` from their scroll / pointerdown / focus handlers so
 * the controls reappear as soon as the user touches the surface again.
 */
export function useAutoHideOnIdle({ enabled, idleMs = 2500 }: UseAutoHideOnIdleOptions): UseAutoHideOnIdleResult {
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const arm = useCallback(() => {
    clear();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHidden(true);
    }, idleMs);
  }, [clear, idleMs]);

  const poke = useCallback(() => {
    setHidden(false);
    if (!enabled) {
      clear();
      return;
    }
    arm();
  }, [arm, clear, enabled]);

  useEffect(() => {
    if (!enabled) {
      clear();
      setHidden(false);
      return clear;
    }
    setHidden(false);
    arm();
    return clear;
  }, [enabled, idleMs, arm, clear]);

  return { visible: !enabled || !hidden, poke };
}

export default useAutoHideOnIdle;

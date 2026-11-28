"use client";

import { useCallback, useState } from 'react';
import { useResetOnChange } from './useResetOnChange';
import { useTimeout } from './timing';

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
  const [pokes, setPokes] = useState(0);

  // Turning auto-hide on or off, or a new idle time, shows the controls again.
  useResetOnChange(`${enabled}:${idleMs}`, () => setHidden(false));
  useTimeout(() => setHidden(true), enabled && !hidden ? idleMs : null, pokes);

  const poke = useCallback(() => {
    setHidden(false);
    setPokes((count) => count + 1);
  }, []);

  return { visible: !enabled || !hidden, poke };
}

export default useAutoHideOnIdle;

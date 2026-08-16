"use client";

import { useEffect, useRef } from 'react';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';

/**
 * Auto-focus a search `TextField` on mount (and whenever `enabled` flips
 * `false -> true`, which is how modal pickers re-trigger focus on each
 * open) — see issue #372 ("place cursor automatically on search fields").
 *
 * Not a plain `autoFocus` prop because:
 *  - MUI's `Dialog` focus trap competes with `autoFocus` and does not
 *    re-fire when the same mounted dialog re-opens.
 *  - We need a coarse-pointer guard so opening a page/dialog on a touch
 *    device doesn't pop the virtual keyboard.
 *  - We must never steal focus from an element the user already started
 *    typing into.
 */
export interface UseAutoFocusSearchOptions {
  /** Master enable switch. Re-focuses whenever this flips false -> true. Default true. */
  enabled?: boolean;
  /**
   * Delay before focusing. `0` (default) schedules via `requestAnimationFrame`;
   * pass e.g. `120` for dialogs so the MUI focus trap settles first.
   */
  delayMs?: number;
  /** Select any existing text once focused (mirrors NodePalette's `.focus()` + `.select()`). Default true. */
  selectOnFocus?: boolean;
  /** Skip focusing on coarse-pointer (touch) devices to avoid popping the virtual keyboard. Default true. */
  skipOnCoarsePointer?: boolean;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Returns a ref to be passed as `inputRef` on the target MUI `TextField`.
 */
export function useAutoFocusSearch(
  options?: UseAutoFocusSearchOptions,
): React.RefObject<HTMLInputElement | null> {
  const {
    enabled = true,
    delayMs = 0,
    selectOnFocus = true,
    skipOnCoarsePointer = true,
  } = options ?? {};

  // User-facing escape hatch (#372 §3.4): default on, persisted per-browser.
  const [preferenceEnabled] = useUiPreference<boolean>('flujo-ui:search:autoFocus', true);

  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!enabled || !preferenceEnabled) return;
    if (typeof window === 'undefined') return;

    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const runFocus = () => {
      if (cancelled) return;
      const input = ref.current;
      if (!input) return;

      if (skipOnCoarsePointer) {
        try {
          if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
            return;
          }
        } catch {
          // matchMedia not implemented (e.g. some test environments) — ignore the guard.
        }
      }

      // Never steal focus from an element the user is already typing into.
      const active = document.activeElement;
      if (active && active !== input && isEditableElement(active)) {
        return;
      }

      input.focus({ preventScroll: true });
      if (selectOnFocus) input.select();
    };

    if (delayMs > 0) {
      timeoutId = setTimeout(runFocus, delayMs);
    } else {
      rafId = window.requestAnimationFrame(runFocus);
    }

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
    // Re-run (and thus re-focus) whenever `enabled` flips, e.g. a dialog re-opening.
  }, [enabled, preferenceEnabled, delayMs, selectOnFocus, skipOnCoarsePointer]);

  return ref;
}

export default useAutoFocusSearch;

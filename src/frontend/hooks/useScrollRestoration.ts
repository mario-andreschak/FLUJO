"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList, RefObject } from 'react';
import { readUiPreference, writeUiPreference } from '@/frontend/hooks/useUiPreference';

// Scroll-position persistence + "back to top" state for the main list pages
// (#185: /models, /mcp, /flows, /waves). This wraps the already-battle-tested
// `useUiPreference` localStorage helpers so a lost/blocked write is harmless
// (private mode / quota errors are swallowed there).
//
// The scroll SOURCE is resolved at runtime: if a container ref is attached AND
// that element is itself scrollable, the element is used; otherwise the window
// is used. These list pages scroll the document (their `height: '100%'` does
// not resolve to a bounded height, so an inner `overflow: 'auto'` box never
// forms its own scroll region), so window is the common case — but handling
// both keeps the hook correct if a page's layout ever gains a real scroller.

export interface UseScrollRestorationOptions {
  /** Pixels scrolled before the back-to-top button appears. */
  threshold?: number;
  /**
   * Re-attempt restoration when any of these change. Async lists (models, MCP
   * servers, flows, waves) are short on first paint, so the saved position may
   * exceed the current scroll height; pass e.g. `[isLoading, items.length]` so
   * restoration retries once the content has grown to full height.
   */
  deps?: DependencyList;
}

export interface UseScrollRestorationResult<T extends HTMLElement> {
  /**
   * Optional: attach to the scroll container. When left unattached (or the
   * element is not itself scrollable) the window is used as the scroll source.
   */
  ref: RefObject<T | null>;
  /** True once scrolled past `threshold`. */
  showBackToTop: boolean;
  /** Smoothly scroll the active source back to the top. */
  scrollToTop: () => void;
}

export function useScrollRestoration<T extends HTMLElement = HTMLDivElement>(
  storageKey: string,
  options: UseScrollRestorationOptions = {},
): UseScrollRestorationResult<T> {
  const { threshold = 200, deps = [] } = options;
  const ref = useRef<T | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const restoredRef = useRef(false);

  // Resolve the element that actually scrolls: the attached container when it
  // is itself scrollable, otherwise `null` meaning "use the window/document".
  const resolveEl = useCallback((): HTMLElement | null => {
    const el = ref.current;
    if (el && el.scrollHeight > el.clientHeight + 1) return el;
    return null;
  }, []);

  const getScrollTop = useCallback((): number => {
    const el = resolveEl();
    if (el) return el.scrollTop;
    if (typeof window === 'undefined') return 0;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }, [resolveEl]);

  const applyScrollTop = useCallback(
    (top: number) => {
      const el = resolveEl();
      if (el) {
        el.scrollTop = top;
      } else if (typeof window !== 'undefined') {
        window.scrollTo(0, top);
      }
    },
    [resolveEl],
  );

  // Persist the position and drive button visibility. Writes are coalesced with
  // requestAnimationFrame (falling back to a microtask) so a fast scroll does
  // not hammer localStorage. Listens on both the element and the window so
  // whichever one is the real scroller is covered.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const el = ref.current;
    let frame = 0;
    const raf =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16) as unknown as number;
    const caf =
      typeof window.cancelAnimationFrame === 'function'
        ? window.cancelAnimationFrame.bind(window)
        : (id: number) => window.clearTimeout(id);

    const onScroll = () => {
      const top = getScrollTop();
      setShowBackToTop(top > threshold);
      if (frame) caf(frame);
      frame = raf(() => writeUiPreference(storageKey, top));
    };

    el?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) caf(frame);
      el?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    };
  }, [storageKey, threshold, getScrollTop]);

  // Restore the saved position once (re-tried when `deps` change so async lists
  // get their position back after they have grown to full height). If the saved
  // value exceeds the current scroll height the browser clamps it safely.
  useEffect(() => {
    if (typeof window === 'undefined' || restoredRef.current) return;
    const target = readUiPreference<number>(storageKey, 0);
    if (target <= 0) {
      restoredRef.current = true;
      return;
    }
    applyScrollTop(target);
    // Only consider restoration "done" once it actually took effect; otherwise
    // wait for the next deps tick (more content loaded).
    const now = getScrollTop();
    if (now > 0) {
      restoredRef.current = true;
      setShowBackToTop(now > threshold);
    }
  }, deps);

  const scrollToTop = useCallback(() => {
    const el = resolveEl();
    if (el) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setShowBackToTop(false);
  }, [resolveEl]);

  return { ref, showBackToTop, scrollToTop };
}

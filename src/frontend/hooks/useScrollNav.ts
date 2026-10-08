"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyList, RefObject } from 'react';
import {
  applyScrollTop,
  getAnchorOffset,
  getScrollMetrics,
  isScrollable,
  resolveScrollBehavior,
  resolveScrollElement,
} from '@/frontend/hooks/scrollTarget';

/** Tolerance (px) used when picking the previous/next anchor so repeated clicks advance. */
const ANCHOR_TOLERANCE = 8;
/** Fraction of a viewport used when a surface has no anchors to step through. */
const PAGE_STEP_RATIO = 0.9;

export interface UseScrollNavOptions<T extends HTMLElement = HTMLDivElement> {
  /** Reuse an existing container ref (e.g. the one from `useScrollRestoration`). */
  ref?: RefObject<T | null>;
  /** px tolerance for "at top". Default 24. */
  topThreshold?: number;
  /** px tolerance for "at bottom". Default 80 (matches chat's sticky rule). */
  bottomThreshold?: number;
  /** Selector for the anchors stepped through by previous/next (group headers, chat bubbles). */
  anchorSelector?: string;
  /** Extra offset subtracted when scrolling to an anchor (sticky headers). */
  anchorOffset?: number;
  /** Re-measure when these change (async lists, "load earlier messages", filters). */
  deps?: DependencyList;
}

export interface UseScrollNavResult<T extends HTMLElement> {
  /** Attach to the scroll container; when it does not scroll, the window is used. */
  ref: RefObject<T | null>;
  atTop: boolean;
  atBottom: boolean;
  /** True when the surface actually overflows — the cluster is hidden otherwise. */
  scrollable: boolean;
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Nearest anchor above the current position (falls back to a page step / top). */
  scrollToPreviousAnchor: () => void;
  /** Nearest anchor below the current position (falls back to a page step / bottom). */
  scrollToNextAnchor: () => void;
  /** Escape hatch, e.g. chat's "beginning of last message". */
  scrollToElement: (el: HTMLElement | null, behavior?: ScrollBehavior) => void;
  /** Attach to the container's `onScroll`; window scrolling is handled internally. */
  onScroll: () => void;
  /** Force a re-measure (after content changed outside of `deps`). */
  measure: () => void;
}

interface NavState {
  atTop: boolean;
  atBottom: boolean;
  scrollable: boolean;
}

/**
 * Position state + target resolution for the scroll navigation cluster (#376).
 *
 * Works for both container-scrolled and window-scrolled surfaces (see
 * `scrollTarget.ts`), reports whether the surface can scroll at all, and
 * honours `prefers-reduced-motion` by downgrading smooth scrolling.
 */
export function useScrollNav<T extends HTMLElement = HTMLDivElement>(
  options: UseScrollNavOptions<T> = {},
): UseScrollNavResult<T> {
  const {
    ref: externalRef,
    topThreshold = 24,
    bottomThreshold = 80,
    anchorSelector,
    anchorOffset = 0,
    deps = [],
  } = options;

  const internalRef = useRef<T | null>(null);
  const ref = externalRef ?? internalRef;

  const [state, setState] = useState<NavState>({ atTop: true, atBottom: true, scrollable: false });

  const resolveEl = useCallback(() => resolveScrollElement(ref), [ref]);

  const measure = useCallback(() => {
    const el = resolveEl();
    const metrics = getScrollMetrics(el);
    const scrollable = isScrollable(metrics);
    const next: NavState = {
      scrollable,
      atTop: metrics.scrollTop <= topThreshold,
      atBottom: metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= bottomThreshold,
    };
    setState(prev =>
      prev.atTop === next.atTop && prev.atBottom === next.atBottom && prev.scrollable === next.scrollable
        ? prev
        : next,
    );
  }, [resolveEl, topThreshold, bottomThreshold]);

  // rAF-throttled scroll handling; also used as the exported `onScroll`.
  const frameRef = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (typeof window === 'undefined') {
      measure();
      return;
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      measure();
      return;
    }
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  const onScroll = useCallback(() => {
    measure();
  }, [measure]);

  // Listen on both the element and the window so whichever one is the real
  // scroller is covered, and re-measure when the content or viewport resizes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const el = ref.current;
    const handler = () => scheduleMeasure();

    el?.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler, { passive: true });

    let observer: ResizeObserver | undefined;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => scheduleMeasure());
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }

    measure();

    return () => {
      if (frameRef.current && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      el?.removeEventListener('scroll', handler);
      window.removeEventListener('scroll', handler);
      window.removeEventListener('resize', handler);
      observer?.disconnect();
    };
     
  }, [scheduleMeasure, measure, ref]);

  // Re-measure when the caller's content changes (async load, load-more, filter).
  useEffect(() => {
    measure();
     
  }, deps);

  const scrollTo = useCallback(
    (top: number, behavior: ScrollBehavior = 'smooth') => {
      const el = resolveEl();
      applyScrollTop(el, top, resolveScrollBehavior(behavior));
      measure();
    },
    [resolveEl, measure],
  );

  const scrollToTop = useCallback((behavior: ScrollBehavior = 'smooth') => scrollTo(0, behavior), [scrollTo]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = resolveEl();
      const metrics = getScrollMetrics(el);
      scrollTo(Math.max(0, metrics.scrollHeight - metrics.clientHeight), behavior);
    },
    [resolveEl, scrollTo],
  );

  const scrollToElement = useCallback(
    (target: HTMLElement | null, behavior: ScrollBehavior = 'smooth') => {
      if (!target) return;
      const el = resolveEl();
      scrollTo(getAnchorOffset(target, el) - anchorOffset, behavior);
    },
    [resolveEl, scrollTo, anchorOffset],
  );

  const listAnchors = useCallback((): { el: HTMLElement; offset: number }[] => {
    if (!anchorSelector || typeof document === 'undefined') return [];
    const el = resolveEl();
    const scope: ParentNode = ref.current ?? el ?? document;
    const found = Array.from(scope.querySelectorAll<HTMLElement>(anchorSelector));
    return found
      .map(anchor => ({ el: anchor, offset: getAnchorOffset(anchor, el) - anchorOffset }))
      .sort((a, b) => a.offset - b.offset);
  }, [anchorSelector, resolveEl, ref, anchorOffset]);

  const stepAnchor = useCallback(
    (direction: 'previous' | 'next') => {
      const el = resolveEl();
      const metrics = getScrollMetrics(el);
      const current = metrics.scrollTop;
      const anchors = listAnchors();

      if (anchors.length === 0) {
        // No anchors (e.g. grouping disabled): page through the surface instead
        // so the up/down buttons still do something useful.
        const step = Math.max(1, Math.round(metrics.clientHeight * PAGE_STEP_RATIO));
        scrollTo(direction === 'previous' ? current - step : current + step);
        return;
      }

      const target =
        direction === 'previous'
          ? [...anchors].reverse().find(a => a.offset < current - ANCHOR_TOLERANCE)
          : anchors.find(a => a.offset > current + ANCHOR_TOLERANCE);

      if (target) {
        scrollTo(target.offset);
        return;
      }
      if (direction === 'previous') scrollToTop();
      else scrollToBottom();
    },
    [resolveEl, listAnchors, scrollTo, scrollToTop, scrollToBottom],
  );

  const scrollToPreviousAnchor = useCallback(() => stepAnchor('previous'), [stepAnchor]);
  const scrollToNextAnchor = useCallback(() => stepAnchor('next'), [stepAnchor]);

  return useMemo(
    () => ({
      ref,
      atTop: state.atTop,
      atBottom: state.atBottom,
      scrollable: state.scrollable,
      scrollToTop,
      scrollToBottom,
      scrollToPreviousAnchor,
      scrollToNextAnchor,
      scrollToElement,
      onScroll,
      measure,
    }),
    [
      ref,
      state.atTop,
      state.atBottom,
      state.scrollable,
      scrollToTop,
      scrollToBottom,
      scrollToPreviousAnchor,
      scrollToNextAnchor,
      scrollToElement,
      onScroll,
      measure,
    ],
  );
}

export default useScrollNav;

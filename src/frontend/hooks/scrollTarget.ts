"use client";

/**
 * Shared scroll-surface helpers (#376).
 *
 * Two scroll models coexist in the app: some surfaces scroll an inner
 * `overflow: auto` box (chat, MCP, flows) while others scroll the document
 * (models, automations, waves — their `height: 100%` never resolves to a
 * bounded height so the inner box never forms a scroll region).
 *
 * `useScrollRestoration` (position persistence) and `useScrollNav` (navigation
 * controls) MUST agree about which surface actually scrolls, otherwise the
 * buttons move one surface while the persistence reads another. Both therefore
 * import the resolution logic from here.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const EMPTY_METRICS: ScrollMetrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };

export interface ScrollRefLike<T extends HTMLElement = HTMLElement> {
  current: T | null;
}

/**
 * Resolve the element that actually scrolls: the attached container when it is
 * itself scrollable, otherwise `null` meaning "use the window/document".
 */
export function resolveScrollElement<T extends HTMLElement>(
  ref: ScrollRefLike<T> | null | undefined,
): HTMLElement | null {
  const el = ref?.current ?? null;
  if (el && el.scrollHeight > el.clientHeight + 1) return el;
  return null;
}

/** Read the scroll geometry of an element, or of the document when `el` is null. */
export function getScrollMetrics(el: HTMLElement | null): ScrollMetrics {
  if (el) {
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return EMPTY_METRICS;
  const doc = document.documentElement;
  return {
    scrollTop: window.scrollY || doc.scrollTop || 0,
    scrollHeight: doc.scrollHeight || 0,
    clientHeight: window.innerHeight || doc.clientHeight || 0,
  };
}

/** True when the resolved surface has more content than viewport. */
export function isScrollable(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight > metrics.clientHeight + 1;
}

/**
 * Move the resolved surface to `top`. Omit `behavior` for an instant jump
 * (used by restoration, where animating would fight the user).
 */
export function applyScrollTop(el: HTMLElement | null, top: number, behavior?: ScrollBehavior): void {
  const target = Math.max(0, top);
  if (el) {
    if (behavior && typeof el.scrollTo === 'function') el.scrollTo({ top: target, behavior });
    else el.scrollTop = target;
    return;
  }
  if (typeof window === 'undefined') return;
  if (behavior && typeof window.scrollTo === 'function') window.scrollTo({ top: target, behavior });
  else window.scrollTo(0, target);
}

/** `true` when the user asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Downgrade `smooth` to `auto` when the user prefers reduced motion — every
 * user-initiated scroll in the nav controls goes through this.
 */
export function resolveScrollBehavior(behavior: ScrollBehavior = 'smooth'): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : behavior;
}

/**
 * Offset of `anchor` expressed in the coordinate space of the scroll surface
 * (i.e. the `scrollTop` value that puts the anchor at the top of the viewport).
 */
export function getAnchorOffset(anchor: HTMLElement, container: HTMLElement | null): number {
  const rect = anchor.getBoundingClientRect();
  if (container) {
    return rect.top - container.getBoundingClientRect().top + container.scrollTop;
  }
  const scrollY = typeof window === 'undefined' ? 0 : window.scrollY || 0;
  return rect.top + scrollY;
}

"use client";

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const CONDENSED_CLASS = 'app-chrome-condensed';
const COLLAPSE_AFTER_PX = 72;
const EXPAND_BEFORE_PX = 24;

// These are the dense, scroll-heavy workspaces where persistent full-size
// navigation + page-introduction chrome costs the most usable canvas space.
const COMPACT_CHROME_ROUTES = [
  '/models',
  '/mcp',
  '/flows',
  '/executions',
  '/automation/triggers',
  '/automation/waves',
  '/waves',
];

const supportsCompactChrome = (pathname: string) =>
  COMPACT_CHROME_ROUTES.some(
    route => pathname === route || pathname.startsWith(`${route}/`),
  );

/**
 * Condense the shared app chrome when the active workspace's real scroll
 * source moves down. Scroll-heavy pages use a mix of document and nested
 * scrollers, so this listens in the capture phase instead of coupling the
 * shell to any one page layout.
 */
export default function useCompactAppChrome() {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(CONDENSED_CLASS);

    if (!supportsCompactChrome(pathname)) return;

    const main = document.getElementById('main-content');
    let condensed = false;

    const update = (top: number) => {
      // Hysteresis prevents the shell from flickering around one threshold as
      // its own height changes while condensing or expanding.
      const next = condensed
        ? top > EXPAND_BEFORE_PX
        : top > COLLAPSE_AFTER_PX;

      if (next === condensed) return;
      condensed = next;
      root.classList.toggle(CONDENSED_CLASS, condensed);
    };

    const handleScroll = (event: Event) => {
      const target = event.target;

      if (
        target === document ||
        target === document.documentElement ||
        target === document.body
      ) {
        update(window.scrollY || document.documentElement.scrollTop || 0);
        return;
      }

      // Ignore drawers, dialogs, menus, and any other portal outside the page
      // workspace. Only content scrolling should alter the shared chrome.
      if (!(target instanceof HTMLElement) || !main?.contains(target)) return;
      update(target.scrollTop);
    };

    update(window.scrollY || document.documentElement.scrollTop || 0);
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      root.classList.remove(CONDENSED_CLASS);
    };
  }, [pathname]);
}

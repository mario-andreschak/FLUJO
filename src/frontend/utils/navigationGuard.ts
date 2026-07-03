/**
 * App-wide client-navigation guard.
 *
 * Next.js App Router has no route-change events, so in-app navigation (the
 * top menu) would silently unmount pages with unsaved work — beforeunload
 * only covers tab close/refresh. A page with unsaved state registers a guard
 * here; navigation sources (the Navigation bar) offer their navigate action
 * to the guard, which either runs it immediately or defers it behind a
 * confirmation dialog.
 *
 * Only one guard is active at a time (there is one page on screen).
 */

export type NavigationGuard = (navigate: () => void) => void;

let activeGuard: NavigationGuard | null = null;

export function setNavigationGuard(guard: NavigationGuard): void {
  activeGuard = guard;
}

/** Clears the guard — only if it is still the one passed (so a stale cleanup
 * can't remove a newer page's guard). */
export function clearNavigationGuard(guard: NavigationGuard): void {
  if (activeGuard === guard) {
    activeGuard = null;
  }
}

/**
 * Offer a navigation to the active guard. Returns true when a guard took
 * ownership (the caller must preventDefault and let the guard run/defer the
 * navigate callback), false when no guard is registered and the caller
 * should navigate normally.
 */
export function interceptNavigation(navigate: () => void): boolean {
  if (!activeGuard) return false;
  activeGuard(navigate);
  return true;
}

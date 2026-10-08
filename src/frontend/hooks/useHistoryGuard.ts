"use client";

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createLogger } from '@/utils/logger';
import { interceptNavigation } from '@/frontend/utils/navigationGuard';

const log = createLogger('frontend/hooks/useHistoryGuard');

export interface UseHistoryGuardOptions {
  /** Only wire the popstate listener while this is true (e.g. the editor is open with a registered NavigationGuard). */
  active: boolean;
  /**
   * The URL that represents the "guarded" state — re-pushed onto history to
   * cancel a Back/Forward navigation until the active NavigationGuard (if
   * any) decides. Should match whatever `active` corresponds to.
   */
  currentUrl: string;
}

export interface UseHistoryGuardHandle {
  /**
   * Call this immediately before the page itself performs a `router.back()`
   * (e.g. a "Back to dashboard" button that already ran the guard's
   * Save/Discard dialog). Prevents the resulting popstate — and any popstate
   * produced by the guard's own approved `navigate()` — from being
   * re-intercepted, which would otherwise loop.
   */
  suppressNext: () => void;
}

/**
 * Makes browser Back/Forward respect the app's existing `NavigationGuard`
 * (unsaved-changes Save/Discard dialog), which previously only intercepted
 * top-nav clicks. While `active`, a `popstate` immediately re-pushes
 * `currentUrl` (cancelling the pop) and then offers `router.back()` to the
 * active guard; if no guard is registered, or the guard approves, it
 * performs the real `router.back()` — whose own resulting popstate is
 * pre-suppressed so approval never loops.
 */
export function useHistoryGuard({ active, currentUrl }: UseHistoryGuardOptions): UseHistoryGuardHandle {
  const router = useRouter();
  const suppressed = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      if (suppressed.current) {
        suppressed.current = false;
        return;
      }

      const navigateBack = () => {
        suppressed.current = true;
        router.back();
      };

      const intercepted = interceptNavigation(navigateBack);
      if (!intercepted) {
        // No guard registered — nothing unsaved, let the pop proceed as-is.
        return;
      }

      // A guard took ownership: cancel this pop by re-pushing the guarded
      // URL (pushState never fires its own popstate, so this is safe). If
      // the user confirms discard, the guard calls navigateBack() itself.
      log.debug('Cancelling popstate to let the navigation guard decide', { currentUrl });
      window.history.pushState(window.history.state, '', currentUrl);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [active, currentUrl, router]);

  const suppressNext = useCallback(() => {
    suppressed.current = true;
  }, []);

  return { suppressNext };
}

"use client";

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/hooks/useEntityDeepLink');

export interface UseEntityDeepLinkOptions {
  /** Query param name to read, e.g. 'flow', 'conversation', 'server'. */
  param: string;
  /** Whether the data needed to validate the id has loaded (list loaded, unlocked, ...). */
  ready: boolean;
  /** Returns true when `id` is a real, currently-valid entity. */
  exists: (id: string) => boolean;
  /** Called exactly once with the validated id. */
  onResolve: (id: string) => void;
  /**
   * When true, the param is a one-shot action and is stripped from the URL
   * with `router.replace()` once handled. When false (default) the param is
   * a durable piece of state and is left in the URL so Back/Forward and
   * refresh keep working.
   */
  consume?: boolean;
  /** Base path to replace onto when consuming, e.g. '/chat'. Defaults to the current pathname. */
  replacePath?: string;
}

/**
 * Encapsulates the `useRef(false)` once-guard + validation + optional
 * `router.replace` that used to be copy-pasted around every ad-hoc deep link
 * (`/flows?flow=`, `/chat?flow=`, `/models?edit=`). Runs the resolve callback
 * at most once per mount, only after `ready` becomes true, and only for ids
 * that `exists()` confirms — unknown ids are ignored with a `log.warn`,
 * never thrown.
 */
export function useEntityDeepLink({
  param,
  ready,
  exists,
  onResolve,
  consume = false,
  replacePath,
}: UseEntityDeepLinkOptions): void {
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !ready) return;
    if (typeof window === 'undefined') return;

    const wanted = new URLSearchParams(window.location.search).get(param);
    if (!wanted) {
      done.current = true;
      return;
    }

    done.current = true;

    if (!exists(wanted)) {
      log.warn('Deep link target does not exist, ignoring', { param, id: wanted });
      if (consume) {
        router.replace(replacePath ?? window.location.pathname);
      }
      return;
    }

    log.debug('Resolving deep link', { param, id: wanted });
    onResolve(wanted);

    if (consume) {
      router.replace(replacePath ?? window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

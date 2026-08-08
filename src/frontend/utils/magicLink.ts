/**
 * Canonical "magic link" URL scheme for FLUJO entities.
 *
 * FLUJO's app-shell state (which flow is open, which conversation is
 * selected, whether the FlowBuilder editor is open, ...) is largely *not*
 * reflected in the URL today, which is why Back/Forward and "copy a link to
 * this thing" don't work. This module is the single place that knows how to
 * build a URL for a given entity so every "copy link" affordance and every
 * deep-link consumer agrees on the same scheme.
 *
 * Pure, framework-free — safe to unit test without React/DOM.
 */

import { createLogger } from '@/utils/logger';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

const log = createLogger('frontend/utils/magicLink');

export type MagicLinkKind =
  | 'flow'
  | 'flow-editor'
  | 'conversation'
  | 'message'
  | 'model'
  | 'mcp-server';

export interface MagicLinkTarget {
  kind: MagicLinkKind;
  id: string;
  /** Additional query params merged in verbatim (e.g. a parent conversation id for a message link). */
  extra?: Record<string, string>;
}

function withExtra(params: URLSearchParams, extra?: Record<string, string>): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    params.set(key, value);
  }
}

/**
 * Builds a path (no origin) for the given target, e.g. `/flows?flow=abc&mode=edit`.
 * Ids are always `encodeURIComponent`-ed via `URLSearchParams`. Unknown kinds
 * fall back to `/` and a `log.warn` rather than throwing — magic links must
 * fail closed and silently (see issue #374).
 */
export function magicLinkPath(target: MagicLinkTarget): string {
  const { kind, id } = target;
  if (!id) {
    log.warn('magicLinkPath called without an id', { kind });
    return '/';
  }

  switch (kind) {
    case 'flow': {
      const params = new URLSearchParams({ flow: id });
      withExtra(params, target.extra);
      return `/flows?${params.toString()}`;
    }
    case 'flow-editor': {
      const params = new URLSearchParams({ flow: id, mode: 'edit' });
      withExtra(params, target.extra);
      return `/flows?${params.toString()}`;
    }
    case 'conversation': {
      const params = new URLSearchParams({ conversation: id });
      withExtra(params, target.extra);
      return `/chat?${params.toString()}`;
    }
    case 'message': {
      const params = new URLSearchParams();
      const conversationId = target.extra?.conversation;
      if (conversationId) params.set('conversation', conversationId);
      params.set('message', id);
      withExtra(
        params,
        target.extra ? Object.fromEntries(Object.entries(target.extra).filter(([k]) => k !== 'conversation')) : undefined
      );
      return `/chat?${params.toString()}`;
    }
    case 'model': {
      const params = new URLSearchParams({ edit: id });
      withExtra(params, target.extra);
      return `/models?${params.toString()}`;
    }
    case 'mcp-server': {
      const params = new URLSearchParams({ server: id });
      withExtra(params, target.extra);
      return `/mcp?${params.toString()}`;
    }
    default: {
      log.warn('magicLinkPath called with an unknown kind', { kind });
      return '/';
    }
  }
}

/**
 * Builds an absolute URL string suitable for the clipboard. Falls back to the
 * bare path when `window` is unavailable (SSR / node tests).
 */
export function magicLinkUrl(target: MagicLinkTarget): string {
  const path = withWorkspaceUrl(magicLinkPath(target));
  if (typeof window === 'undefined' || !window.location?.origin) {
    return path;
  }
  try {
    return new URL(path, window.location.origin).toString();
  } catch (error) {
    log.warn('Failed to build absolute magic link URL, falling back to path', { error });
    return path;
  }
}

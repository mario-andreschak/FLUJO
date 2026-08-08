"use client";

import { useCallback, useMemo } from 'react';
import type { DependencyList, RefObject } from 'react';
import { useScrollRestoration } from '@/frontend/hooks/useScrollRestoration';
import { useScrollNav } from '@/frontend/hooks/useScrollNav';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { ScrollNavAction, ScrollNavClusterProps } from '@/frontend/components/shared/ScrollNavCluster';

/** Group headers rendered by `CollapsibleCardSection` double as scroll anchors. */
export const GROUP_ANCHOR_SELECTOR = '[data-scroll-group-key]';

export interface UseListScrollNavOptions {
  /** Re-measure/restore when these change (async lists, filters). */
  deps?: DependencyList;
  /** True when the list is grouped, so up/down are labelled "previous/next folder". */
  groupsEnabled?: boolean;
  /** Override the anchor selector. */
  anchorSelector?: string;
}

export interface UseListScrollNavResult<T extends HTMLElement> {
  /** Attach to the list scroll container (window scrolling is handled if it does not scroll). */
  ref: RefObject<T | null>;
  /** Spread onto `<ScrollNavCluster />`. */
  clusterProps: Pick<ScrollNavClusterProps, 'show' | 'disabled' | 'labels' | 'onAction'>;
  atTop: boolean;
  atBottom: boolean;
  scrollable: boolean;
}

/**
 * List-page scroll navigation (#376): scroll-position persistence (#185) plus
 * the four-way navigation cluster (top / previous folder / next folder /
 * bottom), sharing a single container ref so persistence and navigation can
 * never disagree about which surface scrolls.
 *
 * The cluster is shown whenever the list can scroll — including at the very
 * top and at the very bottom — with the individual buttons disabled at the
 * respective ends, so the controls are always reachable.
 */
export function useListScrollNav<T extends HTMLElement = HTMLDivElement>(
  storageKey: string,
  options: UseListScrollNavOptions = {},
): UseListScrollNavResult<T> {
  const { deps = [], groupsEnabled = true, anchorSelector = GROUP_ANCHOR_SELECTOR } = options;
  const { t } = useI18n();

  const { ref } = useScrollRestoration<T>(storageKey, { deps });
  const nav = useScrollNav<T>({ ref, anchorSelector, deps });

  const onAction = useCallback(
    (action: ScrollNavAction) => {
      if (action === 'top') nav.scrollToTop();
      else if (action === 'up') nav.scrollToPreviousAnchor();
      else if (action === 'down') nav.scrollToNextAnchor();
      else nav.scrollToBottom();
    },
    [nav],
  );

  const clusterProps = useMemo(
    () => ({
      show: nav.scrollable,
      disabled: { top: nav.atTop, bottom: nav.atBottom },
      labels: groupsEnabled
        ? { up: t('scrollNav.previousGroup'), down: t('scrollNav.nextGroup') }
        : undefined,
      onAction,
    }),
    [nav.scrollable, nav.atTop, nav.atBottom, groupsEnabled, t, onAction],
  );

  return { ref, clusterProps, atTop: nav.atTop, atBottom: nav.atBottom, scrollable: nav.scrollable };
}

export default useListScrollNav;

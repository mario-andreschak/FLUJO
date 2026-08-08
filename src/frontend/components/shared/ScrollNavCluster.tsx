"use client";

import React from 'react';
import { Fab, Fade, Stack } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardDoubleArrowUpIcon from '@mui/icons-material/KeyboardDoubleArrowUp';
import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import { prefersReducedMotion } from '@/frontend/hooks/scrollTarget';

export type ScrollNavAction = 'top' | 'up' | 'down' | 'bottom';

export const DEFAULT_SCROLL_NAV_ACTIONS: ScrollNavAction[] = ['top', 'up', 'down', 'bottom'];

export interface ScrollNavClusterProps {
  /** Which buttons to render, in order. */
  actions?: ScrollNavAction[];
  /** Whether the cluster is visible. */
  show?: boolean;
  /** Fired with the action id of the clicked button. */
  onAction: (action: ScrollNavAction) => void;
  /** Per-action disabled state (e.g. `top` while already at the top). */
  disabled?: Partial<Record<ScrollNavAction, boolean>>;
  /** Per-action label overrides; defaults come from the shared i18n catalog. */
  labels?: Partial<Record<ScrollNavAction, string>>;
  /** `fixed` for window-scrolled pages, `absolute` inside a `position: relative` parent. */
  positionMode?: 'fixed' | 'absolute';
  /** Suppress the native tooltips (touch surfaces show them as sticky artefacts). */
  compact?: boolean;
  sx?: SxProps<Theme>;
}

const ICONS: Record<ScrollNavAction, React.ReactNode> = {
  top: <KeyboardDoubleArrowUpIcon />,
  up: <KeyboardArrowUpIcon />,
  down: <KeyboardArrowDownIcon />,
  bottom: <KeyboardDoubleArrowDownIcon />,
};

const DEFAULT_LABEL_KEYS: Record<ScrollNavAction, TranslationKey> = {
  top: 'scrollNav.top',
  up: 'scrollNav.pageUp',
  down: 'scrollNav.pageDown',
  bottom: 'scrollNav.bottom',
};

/**
 * Presentational cluster of scroll navigation FABs (#376).
 *
 * Purely prop-driven — the scroll wiring lives in `useScrollNav` — so it is
 * trivially testable. Replaces the old `BackToTopButton`: its `top` action is
 * the same affordance, and the cluster stays reachable from the default
 * (bottom / unscrolled) position so "scroll up" is never out of reach.
 */
export default function ScrollNavCluster({
  actions = DEFAULT_SCROLL_NAV_ACTIONS,
  show = true,
  onAction,
  disabled,
  labels,
  positionMode = 'fixed',
  compact = false,
  sx,
}: ScrollNavClusterProps) {
  const { t } = useI18n();
  const reducedMotion = prefersReducedMotion();

  const labelFor = (action: ScrollNavAction): string => labels?.[action] ?? t(DEFAULT_LABEL_KEYS[action]);

  return (
    <Fade in={show} timeout={reducedMotion ? 0 : undefined} unmountOnExit>
      <Stack
        spacing={1}
        role="group"
        aria-label={t('scrollNav.group')}
        data-scroll-nav-cluster
        style={{ position: positionMode }}
        sx={{ right: 24, bottom: 24, zIndex: 1200, ...sx }}
      >
        {actions.map(action => {
          const label = labelFor(action);
          const isDisabled = disabled?.[action] === true;
          return (
            <Fab
              key={action}
              size="small"
              color={action === 'bottom' || action === 'top' ? 'primary' : 'default'}
              aria-label={label}
              title={compact ? undefined : label}
              disabled={isDisabled}
              data-scroll-nav-action={action}
              onClick={() => onAction(action)}
            >
              {ICONS[action]}
            </Fab>
          );
        })}
      </Stack>
    </Fade>
  );
}

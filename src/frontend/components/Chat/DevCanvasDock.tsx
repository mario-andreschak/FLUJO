"use client";

/**
 * Issue #216 — Docked, tabbed MCP Apps canvas surface (`pip` display mode).
 *
 * A persistent, docked surface pinned ABOVE the chat input. It hosts developer-
 * style MCP Apps (diff viewer, editor, browser) that stay open across turns and
 * update in place, instead of spawning a fresh iframe per tool result inline in
 * the transcript.
 *
 * THE LOAD-BEARING INVARIANT: never reparent a live `<iframe>`. Every docked app
 * is mounted ONCE (as a `McpAppFrame docked` host) and kept mounted for the life
 * of its tab. Tab switching, N-up split and collapse are **pure CSS** (show/hide
 * via `visible` / `display`), never a DOM move — a reparent reloads the iframe,
 * losing app state and dropping the postMessage bridge. Do not "optimize" this by
 * conditionally unmounting inactive hosts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography, Tooltip, IconButton, Badge, useMediaQuery, useTheme } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import WidgetsIcon from '@mui/icons-material/Widgets';
import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type {
  McpUiDisplayMode,
  McpUiUpdateModelContextRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { useWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';
import McpAppFrame from './McpAppFrame';
import type { CanvasAppEntry } from './canvasState';
import {
  clampFloatingPosition,
  constrainFloatingRect,
  FloatingResizeHandles,
  PointerDragShield,
  resizeFloatingRect,
  useFixedOriginOffset,
  usePointerDrag,
  type FloatingRect,
  type ResizeDirection,
} from './floatingPanel';

interface DevCanvasDockProps {
  /** Optional conversation attached to every frame in this dock. */
  conversationId?: string;
  /**
   * Stable owner for persisted dock UI and teardown registration. Standalone
   * shell hosts should provide this instead of inventing a conversation id.
   */
  persistenceId?: string;
  /** Stable app owner prefix shared by inline and docked shell presentations. */
  appOwnerScopePrefix?: string;
  /**
   * Anchor this same mounted host to the viewport below the app navigation.
   * Presentation changes remain CSS-only, so no live iframe is reparented.
   */
  viewportDocked?: boolean;
  /** Docked apps in stable tab order. Empty → the dock renders nothing. */
  entries: CanvasAppEntry[];
  /** Currently-focused tab key, or null. */
  activeKey: string | null;
  /** Focus a tab (clears its unread badge upstream). */
  onSelectTab: (key: string) => void;
  /** Close a tab (tears down its bridge upstream). */
  onCloseTab: (key: string) => void;
  /** Human-in-the-loop return channel for app messages. */
  onAppMessage?: (text: string) => boolean | Promise<boolean>;
  /** Future-turn-only storage channel for app model-context updates. */
  onUpdateModelContext?: (
    appKey: string,
    context: McpUiUpdateModelContextRequest['params'],
  ) => boolean | Promise<boolean>;
  /** Register a frame's bounded graceful-teardown callback with the owner. */
  onRegisterTeardown?: (
    ownerId: string,
    appKey: string,
    teardown: (() => Promise<void>) | null,
  ) => void;
  /** Reports horizontal or vertical space the dock consumer must reserve. */
  onLayoutChange?: (layout: CanvasDockLayout) => void;
  /**
   * #375: fired whenever collapse changes, so the Chat parent (single owner
   * of dismissal policy) can make collapse a sticky "stop auto-opening"
   * intent instead of a pure UI toggle. `true` on collapse (dismiss every
   * currently-docked app + suppress future automatic opens), `false` on
   * expand (lift the suppression only).
   */
  onCollapseChange?: (collapsed: boolean) => void;
  /**
   * #375: close every docked sandbox at once (real unmount + `teardown()`,
   * never a bare CSS hide). Rendered as the top-right X; collapse now lives
   * on the active-edge placement arrow (see `dockLeft`/`dockTop`/`dockBottom`/`dockRight`).
   */
  onCloseAll?: () => void;
}

export type DockPlacement = 'top' | 'bottom' | 'left' | 'right';
export interface CanvasDockLayout {
  placement: DockPlacement;
  reservedWidth: number;
  reservedHeight: number;
}

const clamp = (value: number, min: number, max: number): number => (
  Math.min(Math.max(value, min), Math.max(min, max))
);

/** Short, human label for a `ui://server/name` resource. */
function shortResource(uri: string): string {
  const tail = uri.replace(/\/+$/, '').split('/').pop();
  return tail || uri;
}

/** All visible apps must support both sides of the pip/fullscreen transition. */
export function canFullscreenCanvas(
  visibleKeys: string[],
  modesByKey: Record<string, McpUiDisplayMode[]>,
): boolean {
  return visibleKeys.length === 1 && visibleKeys.every((key) => {
    const modes = modesByKey[key] ?? [];
    return modes.includes('pip') && modes.includes('fullscreen');
  });
}

const DevCanvasDock: React.FC<DevCanvasDockProps> = ({
  conversationId,
  persistenceId,
  appOwnerScopePrefix,
  viewportDocked = false,
  entries,
  activeKey,
  onSelectTab,
  onCloseTab,
  onAppMessage,
  onUpdateModelContext,
  onRegisterTeardown,
  onLayoutChange,
  onCollapseChange,
  onCloseAll,
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  const compactDock = useMediaQuery(theme.breakpoints.down('md'));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ownerId = persistenceId ?? conversationId ?? 'standalone';
  // Chat retains the legacy global keys. A shell-level persistent host gets an
  // independent namespace so moving it cannot overwrite the chat presentation.
  const placementPreferenceKey = persistenceId
    ? `flujo-mcp-canvas-placement:${persistenceId}`
    : 'flujo-mcp-canvas-placement';
  const heightPreferenceKey = persistenceId
    ? `flujo-mcp-canvas-height:${persistenceId}`
    : 'flujo-mcp-canvas-height';
  const widthPreferenceKey = persistenceId
    ? `flujo-mcp-canvas-width:${persistenceId}`
    : 'flujo-mcp-canvas-width';
  const [collapsed, setCollapsedPref] = useWorkspaceUiPreference<boolean>(
    `flujo-ui:mcp-canvas:collapsed:${ownerId}`,
    false,
  );
  // #375: every collapse/expand goes through this so the parent's sticky
  // dismissal/suppression policy always stays in sync with the visible state.
  // Kept behind a ref so the wrapper's own identity is stable (other callbacks
  // like `enterFullscreen` close over it with an intentionally empty dep list).
  const onCollapseChangeRef = useRef(onCollapseChange);
  useEffect(() => { onCollapseChangeRef.current = onCollapseChange; }, [onCollapseChange]);
  const setCollapsed = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    setCollapsedPref((value) => {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (resolved !== value) onCollapseChangeRef.current?.(resolved);
      return resolved;
    });
  }, [setCollapsedPref]);
  const [fullscreen, setFullscreen] = useState(false);
  const [placement, setPlacement] = useState<DockPlacement>(() => {
    if (typeof window === 'undefined') return 'bottom';
    const stored = window.localStorage.getItem(placementPreferenceKey);
    return stored === 'top' || stored === 'left' || stored === 'right' ? stored : 'bottom';
  });
  const [dockHeight, setDockHeight] = useState(() => {
    if (typeof window === 'undefined') return 440;
    const stored = Number(window.localStorage.getItem(heightPreferenceKey));
    return Number.isFinite(stored) && stored >= 240 ? stored : 440;
  });
  const [dockWidth, setDockWidth] = useState(() => {
    if (typeof window === 'undefined') return 560;
    const stored = Number(window.localStorage.getItem(widthPreferenceKey));
    return Number.isFinite(stored) && stored >= 320 ? stored : 560;
  });
  const [floatingRect, setFloatingRect] = useState<FloatingRect | null>(null);
  const [appModesByKey, setAppModesByKey] = useState<Record<string, McpUiDisplayMode[]>>({});
  const { activeCursor, startPointerDrag } = usePointerDrag();
  // #216 owner decision #3: general N-up split grid. Keys currently pinned into
  // the split. Empty → only the active tab is shown.
  const [splitKeys, setSplitKeys] = useState<string[]>([]);

  // Keep split membership consistent with the live tab set.
  const liveKeys = useMemo(() => new Set(entries.map((e) => e.key)), [entries]);
  const activeSplit = useMemo(() => splitKeys.filter((k) => liveKeys.has(k)), [splitKeys, liveKeys]);

  const visibleKeys = useMemo<string[]>(() => {
    if (activeSplit.length > 0) return activeSplit;
    return activeKey ? [activeKey] : [];
  }, [activeSplit, activeKey]);
  const visibleSet = useMemo(() => new Set(visibleKeys), [visibleKeys]);
  const fullscreenAvailable = useMemo(
    () => canFullscreenCanvas(visibleKeys, appModesByKey),
    [appModesByKey, visibleKeys],
  );

  const columns = Math.max(1, Math.ceil(Math.sqrt(visibleKeys.length)));

  // A closed tab must not leave stale capabilities behind. If a split/tab
  // change makes the current fullscreen presentation invalid, exit promptly.
  useEffect(() => {
    setAppModesByKey((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([key]) => liveKeys.has(key)),
      );
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
  }, [liveKeys]);
  useEffect(() => {
    if (fullscreen && !fullscreenAvailable) setFullscreen(false);
  }, [fullscreen, fullscreenAvailable]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(placementPreferenceKey, placement);
  }, [placement, placementPreferenceKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(heightPreferenceKey, String(Math.round(dockHeight)));
  }, [dockHeight, heightPreferenceKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(widthPreferenceKey, String(Math.round(dockWidth)));
  }, [dockWidth, widthPreferenceKey]);
  useEffect(() => {
    const layoutPlacement = viewportDocked && compactDock ? 'bottom' : placement;
    const visibleDock = entries.length > 0
      && !fullscreen
      && !collapsed
      && (!compactDock || viewportDocked);
    const reservesWidth = layoutPlacement === 'left' || layoutPlacement === 'right';
    const reservesHeight = layoutPlacement === 'top'
      || (viewportDocked && layoutPlacement === 'bottom');
    onLayoutChange?.({
      placement: layoutPlacement,
      reservedWidth: visibleDock && reservesWidth ? dockWidth : 0,
      reservedHeight: visibleDock && reservesHeight ? dockHeight : 0,
    });
  }, [
    collapsed,
    compactDock,
    dockHeight,
    dockWidth,
    entries.length,
    fullscreen,
    onLayoutChange,
    placement,
    viewportDocked,
  ]);

  useEffect(() => {
    if (!fullscreen || typeof window === 'undefined') return undefined;
    const constrainToViewport = () => {
      const minimum = {
        width: Math.min(480, window.innerWidth),
        height: Math.min(320, window.innerHeight),
      };
      setFloatingRect((current) => current ? constrainFloatingRect(
        current,
        { width: window.innerWidth, height: window.innerHeight },
        minimum,
      ) : current);
    };
    constrainToViewport();
    window.addEventListener('resize', constrainToViewport);
    return () => window.removeEventListener('resize', constrainToViewport);
  }, [fullscreen]);

  const enterFullscreen = useCallback(() => {
    if (typeof window !== 'undefined') {
      const width = clamp(Math.round(window.innerWidth * 0.86), 480, window.innerWidth - 24);
      const height = clamp(Math.round(window.innerHeight * 0.84), 320, window.innerHeight - 24);
      setFloatingRect({
        x: Math.round((window.innerWidth - width) / 2),
        y: Math.round((window.innerHeight - height) / 2),
        width,
        height,
      });
    }
    setFullscreen(true);
    setCollapsed(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) setFullscreen(false);
    else enterFullscreen();
  }, [enterFullscreen, fullscreen]);

  const startDockResize = useCallback((event: React.PointerEvent) => {
    if (fullscreen || !rootRef.current) return;
    const resizePlacement: DockPlacement = compactDock ? 'bottom' : placement;
    const startX = event.clientX;
    const startY = event.clientY;
    const startRect = rootRef.current.getBoundingClientRect();
    const parentRect = rootRef.current.parentElement?.getBoundingClientRect();
    const maxHeight = Math.max(240, (parentRect?.height ?? window.innerHeight) * 0.82);
    const maxWidth = Math.max(320, (parentRect?.width ?? window.innerWidth) - 320);
    const horizontalDock = resizePlacement === 'top' || resizePlacement === 'bottom';
    startPointerDrag(event, horizontalDock ? 'ns-resize' : 'ew-resize', (move) => {
      if (resizePlacement === 'bottom') {
        setDockHeight(clamp(startRect.height + startY - move.clientY, 240, maxHeight));
      } else if (resizePlacement === 'top') {
        setDockHeight(clamp(startRect.height + move.clientY - startY, 240, maxHeight));
      } else if (resizePlacement === 'left') {
        setDockWidth(clamp(startRect.width + move.clientX - startX, 320, maxWidth));
      } else {
        setDockWidth(clamp(startRect.width + startX - move.clientX, 320, maxWidth));
      }
    });
  }, [compactDock, fullscreen, placement, startPointerDrag]);

  const startFullscreenDrag = useCallback((event: React.PointerEvent) => {
    if (!fullscreen || !rootRef.current) return;
    if ((event.target as HTMLElement).closest('button,[role="button"]')) return;
    event.preventDefault();
    const rect = rootRef.current.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    startPointerDrag(event, 'move', (move) => {
      // #371: keep the whole panel on screen so every resize handle stays
      // reachable after a drag.
      const position = clampFloatingPosition(
        { x: rect.left + move.clientX - startX, y: rect.top + move.clientY - startY },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setFloatingRect({ ...position, width: rect.width, height: rect.height });
    });
  }, [fullscreen, startPointerDrag]);

  const startFullscreenResize = useCallback((
    event: React.PointerEvent<HTMLElement>,
    direction: ResizeDirection,
    cursor: React.CSSProperties['cursor'],
  ) => {
    if (!fullscreen || !rootRef.current) return;
    const bounds = rootRef.current.getBoundingClientRect();
    const start = {
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    const startX = event.clientX;
    const startY = event.clientY;
    startPointerDrag(event, cursor, (move) => {
      setFloatingRect(resizeFloatingRect(
        start,
        direction,
        move.clientX - startX,
        move.clientY - startY,
        { width: window.innerWidth, height: window.innerHeight },
        {
          width: Math.min(480, window.innerWidth),
          height: Math.min(320, window.innerHeight),
        },
      ));
    });
  }, [fullscreen, startPointerDrag]);

  // #371: translate floating viewport geometry into the containing block
  // established by any `backdrop-filter`/`transform` ancestor.
  const fixedOffset = useFixedOriginOffset(rootRef, fullscreen);

  if (entries.length === 0) return null;

  const toggleSplit = (key: string) => {
    if (fullscreen) setFullscreen(false);
    setSplitKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const selectTab = (key: string) => {
    if (
      fullscreen
      && !canFullscreenCanvas([key], appModesByKey)
    ) {
      setFullscreen(false);
    }
    onSelectTab(key);
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    key: string,
  ) => {
    const currentIndex = entries.findIndex((entry) => entry.key === key);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + entries.length) % entries.length;
    else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % entries.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = entries.length - 1;
    if (nextIndex === null || nextIndex === currentIndex) return;
    event.preventDefault();
    event.stopPropagation();
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
    selectTab(entries[nextIndex].key);
  };

  const requestDisplayMode = (
    key: string,
    mode: McpUiDisplayMode,
    appModes: McpUiDisplayMode[],
  ): McpUiDisplayMode => {
    const current = fullscreen && visibleSet.has(key) ? 'fullscreen' : 'pip';
    if (mode === current) return current;
    if (
      mode === 'fullscreen'
      && visibleKeys.length === 1
      && visibleKeys[0] === key
      && appModes.includes('pip')
      && appModes.includes('fullscreen')
    ) {
      enterFullscreen();
      return 'fullscreen';
    }
    if (mode === 'pip' && current === 'fullscreen' && appModes.includes('pip')) {
      setFullscreen(false);
      return 'pip';
    }
    return current;
  };

  // #375: collapse no longer forces the bottom edge — each side keeps its own
  // narrow rail so "collapse left"/"collapse right" is visually distinct from
  // a collapsed horizontal top/bottom dock. Mobile still renders as a bottom sheet.
  const effectivePlacement = compactDock ? 'bottom' : placement;
  const isRail = collapsed
    && !fullscreen
    && !compactDock
    && (effectivePlacement === 'left' || effectivePlacement === 'right');

  /**
   * #375: dock-to-that-side / collapse-to-that-edge. Clicking an inactive edge
   * docks there (expanding if currently collapsed); clicking the ALREADY
   * active edge collapses the dock to that edge instead.
   */
  const handleDockButtonClick = (side: DockPlacement) => {
    if (placement !== side) {
      setPlacement(side);
      if (collapsed) setCollapsed(false);
    } else {
      setCollapsed((value) => !value);
    }
  };

  const handleCloseAll = () => {
    if (fullscreen) setFullscreen(false);
    onCloseAll?.();
  };

  const navigationOffset = 'calc(var(--app-bar-height) + var(--active-subnav-height))';
  const viewportAvailableHeight = 'calc(100dvh - var(--app-bar-height) - var(--active-subnav-height))';
  const viewportDockHeight = `min(${dockHeight}px, ${viewportAvailableHeight})`;

  return (
    <>
    <Box
      ref={rootRef}
      data-testid="dev-canvas-dock"
      sx={{
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        ...(fullscreen
          ? {
              position: 'fixed',
              left: (floatingRect?.x ?? 16) - fixedOffset.x,
              top: (floatingRect?.y ?? 16) - fixedOffset.y,
              width: floatingRect?.width ?? 'calc(100vw - 32px)',
              height: floatingRect?.height ?? 'calc(100vh - 32px)',
              minWidth: 'min(480px, 100vw)',
              minHeight: 'min(320px, 100vh)',
              maxWidth: '100vw',
              maxHeight: '100vh',
              zIndex: 1300,
              borderRadius: 1,
              boxShadow: 6,
            }
          : viewportDocked
            ? effectivePlacement === 'left' || effectivePlacement === 'right'
              ? {
                  position: 'fixed',
                  top: navigationOffset,
                  bottom: 0,
                  [effectivePlacement]: 0,
                  width: isRail ? 40 : `min(${dockWidth}px, calc(100vw - 320px))`,
                  height: 'auto',
                  zIndex: theme.zIndex.appBar - 1,
                  borderRadius: 0,
                  boxShadow: 'none',
                  ...(effectivePlacement === 'left' ? { borderLeft: 0 } : { borderRight: 0 }),
                }
              : {
                  position: 'fixed',
                  left: 0,
                  right: 0,
                  [effectivePlacement]: effectivePlacement === 'top' ? navigationOffset : 0,
                  width: '100%',
                  height: collapsed ? 'auto' : viewportDockHeight,
                  maxHeight: viewportAvailableHeight,
                  zIndex: theme.zIndex.appBar - 1,
                  borderRadius: 0,
                  boxShadow: 'none',
                  borderLeft: 0,
                  borderRight: 0,
                }
          : effectivePlacement === 'bottom'
            ? {
                position: 'relative',
                width: '100%',
                height: collapsed ? 'auto' : dockHeight,
                maxHeight: '82vh',
                flexShrink: 0,
                borderLeft: 0,
                borderRight: 0,
              }
            : effectivePlacement === 'top'
              ? {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  width: '100%',
                  height: collapsed ? 'auto' : dockHeight,
                  maxHeight: '82vh',
                  zIndex: 5,
                  borderRadius: 0,
                  boxShadow: 'none',
                  borderLeft: 0,
                  borderRight: 0,
                }
              : {
                position: 'absolute',
                top: 0,
                bottom: 0,
                [effectivePlacement]: 0,
                // #375: collapsed left/right renders as a narrow edge rail
                // instead of the full dockWidth — the body stays `display:
                // none` (iframes remain mounted, invariant preserved).
                width: isRail ? 40 : `min(${dockWidth}px, calc(100% - 320px))`,
                height: 'auto',
                zIndex: 5,
                borderRadius: 0,
                boxShadow: 'none',
                ...(effectivePlacement === 'left' ? { borderLeft: 0 } : { borderRight: 0 }),
              }),
      }}
    >
      {!fullscreen && !collapsed && (
        <Box
          role="separator"
          tabIndex={0}
          aria-orientation={effectivePlacement === 'top' || effectivePlacement === 'bottom' ? 'horizontal' : 'vertical'}
          aria-label={t('chat.canvas.resize')}
          onPointerDown={startDockResize}
          sx={{
            position: 'absolute',
            zIndex: 4,
            ...(effectivePlacement === 'bottom'
              ? { top: 0, left: 0, right: 0, height: 7, cursor: 'row-resize' }
              : effectivePlacement === 'top'
                ? { bottom: 0, left: 0, right: 0, height: 7, cursor: 'row-resize' }
              : effectivePlacement === 'left'
                ? { right: 0, top: 0, bottom: 0, width: 7, cursor: 'col-resize' }
                : { left: 0, top: 0, bottom: 0, width: 7, cursor: 'col-resize' }),
            '&:hover, &:focus-visible': { bgcolor: 'primary.main' },
            touchAction: 'none',
          }}
        />
      )}
      {fullscreen && (
        <FloatingResizeHandles
          label={t('chat.canvas.resize')}
          onResizeStart={startFullscreenResize}
        />
      )}
      {/* Tab strip + dock controls. Collapsed left/right renders as a narrow
          vertical rail (#375): the tab strip/placement arrows disappear and
          only the badge + expand affordance + close-all X remain. */}
      <Box
        onPointerDown={startFullscreenDrag}
        sx={{
          display: 'flex',
          flexDirection: isRail ? 'column' : 'row',
          alignItems: 'center',
          gap: 0.5,
          px: isRail ? 0.5 : 1,
          py: 0.5,
          bgcolor: 'action.hover',
          cursor: fullscreen ? 'move' : 'default',
          userSelect: 'none',
        }}
      >
        <Tooltip title={isRail ? t('chat.canvas.expand') : ''}>
          <span>
            <IconButton
              size="small"
              sx={{ p: isRail ? 0.25 : 0 }}
              disabled={!isRail}
              onClick={isRail ? () => setCollapsed(false) : undefined}
              aria-label={isRail ? t('chat.canvas.expand') : undefined}
            >
              <Badge color="primary" badgeContent={entries.length} max={9} invisible={!isRail || entries.length === 0}>
                <WidgetsIcon fontSize="small" color="primary" />
              </Badge>
            </IconButton>
          </span>
        </Tooltip>
        {!isRail && (
        <Typography variant="caption" sx={{ fontWeight: 600, mr: 1 }}>{t('chat.canvas.title')}</Typography>
        )}

        {!isRail && (
        <Box
          role="tablist"
          aria-label={t('chat.canvas.title')}
          sx={{ display: 'flex', gap: 0.5, overflowX: 'auto', flex: 1, minWidth: 0 }}
        >
          {entries.map((e) => {
            const isActive = e.key === activeKey;
            const inSplit = activeSplit.includes(e.key);
            return (
              <Box
                key={e.key}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  py: 0.25,
                  borderRadius: 1,
                  whiteSpace: 'nowrap',
                  border: 1,
                  borderColor: isActive ? 'primary.main' : 'divider',
                  bgcolor: isActive ? 'action.selected' : 'transparent',
                }}
                title={`${e.serverName} — ${e.uri}`}
              >
                <Box
                  component="button"
                  type="button"
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  onClick={() => selectTab(e.key)}
                  onKeyDown={(event) => handleTabKeyDown(event, e.key)}
                  sx={{
                    appearance: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    minWidth: 0,
                    p: 0,
                    border: 0,
                    color: 'inherit',
                    bgcolor: 'transparent',
                    font: 'inherit',
                    cursor: 'pointer',
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                      outlineOffset: 1,
                      borderRadius: 0.5,
                    },
                  }}
                >
                  <Badge color="primary" variant="dot" invisible={!e.unread}>
                    <Typography variant="caption" sx={{ fontWeight: isActive ? 600 : 400 }}>
                      {shortResource(e.uri)}
                    </Typography>
                  </Badge>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                    {e.serverName}
                  </Typography>
                </Box>
                <Tooltip title={inSplit ? t('chat.canvas.removeSplit') : t('chat.canvas.addSplit')}>
                  <IconButton
                    size="small"
                    sx={{ p: 0.25 }}
                    color={inSplit ? 'primary' : 'default'}
                    onClick={(ev) => { ev.stopPropagation(); toggleSplit(e.key); }}
                    aria-label={t('chat.canvas.toggleSplit')}
                  >
                    <ViewColumnIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('common.close')}>
                  <IconButton
                    size="small"
                    sx={{ p: 0.25 }}
                    onClick={(ev) => { ev.stopPropagation(); onCloseTab(e.key); }}
                    aria-label={t('chat.canvas.closeTab')}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Box>
        )}

        {!fullscreen && !isRail && !compactDock && (
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {/* #375: an arrow docks to that edge (expanding if collapsed); the
                ALREADY-active edge's arrow instead collapses the dock to that
                edge. Collapse is no longer a single bottom-only chevron. */}
            <Tooltip title={placement === 'left' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockLeft')}>
              <IconButton
                size="small"
                color={placement === 'left' ? 'primary' : 'default'}
                onClick={() => handleDockButtonClick('left')}
                aria-label={placement === 'left' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockLeft')}
              >
                <KeyboardArrowLeftIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={placement === 'top' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockTop')}>
              <IconButton
                size="small"
                color={placement === 'top' ? 'primary' : 'default'}
                onClick={() => handleDockButtonClick('top')}
                aria-label={placement === 'top' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockTop')}
              >
                <KeyboardArrowUpIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={placement === 'bottom' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockBottom')}>
              <IconButton
                size="small"
                color={placement === 'bottom' ? 'primary' : 'default'}
                onClick={() => handleDockButtonClick('bottom')}
                aria-label={placement === 'bottom' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockBottom')}
              >
                <KeyboardArrowDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={placement === 'right' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockRight')}>
              <IconButton
                size="small"
                color={placement === 'right' ? 'primary' : 'default'}
                onClick={() => handleDockButtonClick('right')}
                aria-label={placement === 'right' ? t('chat.canvas.collapseToEdge') : t('chat.canvas.dockRight')}
              >
                <KeyboardArrowRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {!isRail && (
        <Tooltip
          title={fullscreen
            ? t('chat.canvas.exitFullscreen')
            : fullscreenAvailable
              ? t('chat.canvas.fullscreen')
              : t('chat.canvas.fullscreenUnavailable')}
        >
          <span>
            <IconButton
              size="small"
              disabled={!fullscreen && !fullscreenAvailable}
              onClick={toggleFullscreen}
              aria-label={t('chat.canvas.toggleFullscreen')}
            >
              {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        )}
        {/* #375: the top-right chevron is now a single X that closes every
            sandbox (real unmount + teardown). Collapse lives on the
            active-edge placement arrow above; the per-tab X is untouched. */}
        {onCloseAll && (
          <Tooltip title={t('chat.canvas.closeAll')}>
            <IconButton
              size="small"
              onClick={handleCloseAll}
              aria-label={t('chat.canvas.closeAll')}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Body: persistent hosts. Collapse hides the body via CSS but keeps every
          bridge/iframe alive (owner decision #2). Split renders an N-up grid. */}
      <Box
        sx={{
          display: collapsed ? 'none' : 'grid',
          position: 'relative',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 1,
          p: 1,
          flex: 1,
          height: 'auto',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {entries.map((e) => {
          const isVisible = !collapsed && visibleSet.has(e.key);
          return (
            <Box
              key={e.key}
              sx={{
                // A visible pane participates in the grid; a hidden one is removed
                // from layout via absolute positioning only — its host stays
                // mounted and measurable for the sizing contract.
                display: 'flex',
                ...(isVisible
                  ? { position: 'relative' }
                  : {
                      position: 'absolute',
                      inset: 0,
                      visibility: 'hidden',
                      pointerEvents: 'none',
                    }),
                flexDirection: 'column',
                minHeight: 0,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: theme.palette.mode === 'dark' ? '#111' : '#fff',
              }}
            >
              <McpAppFrame
                docked
                visible={isVisible}
                conversationId={conversationId}
                ownerScopeId={appOwnerScopePrefix ? `${appOwnerScopePrefix}:${e.key}` : undefined}
                serverName={e.serverName}
                uri={e.uri}
                toolName={e.toolName}
                toolArgs={e.latestToolArgs}
                toolResultContent={e.latestResultContent}
                toolCancelledReason={e.latestToolCancelledReason}
                toolIsError={e.latestToolIsError}
                toolUpdateId={e.latestToolUpdateId ?? e.updatedAt}
                onAppMessage={onAppMessage}
                onUpdateModelContext={onUpdateModelContext}
                hostDisplayMode={fullscreen && isVisible ? 'fullscreen' : 'pip'}
                onAvailableDisplayModes={(modes) => {
                  setAppModesByKey((previous) => {
                    const prior = previous[e.key] ?? [];
                    if (
                      prior.length === modes.length
                      && prior.every((mode, index) => mode === modes[index])
                    ) return previous;
                    return { ...previous, [e.key]: modes };
                  });
                }}
                onRequestDisplayMode={(mode, modes) => requestDisplayMode(e.key, mode, modes)}
                onRequestClose={() => onCloseTab(e.key)}
                onRegisterTeardown={(appKey, callback) => {
                  onRegisterTeardown?.(ownerId, appKey, callback);
                }}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
    <PointerDragShield cursor={activeCursor} />
    </>
  );
};

export default DevCanvasDock;

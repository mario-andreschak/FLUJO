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
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type {
  McpUiDisplayMode,
  McpUiUpdateModelContextRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
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
  /** Conversation that owns every frame in this dock. */
  conversationId: string;
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
    conversationId: string,
    appKey: string,
    teardown: (() => Promise<void>) | null,
  ) => void;
  /** Reports space that a side-docked canvas must reserve in the chat layout. */
  onLayoutChange?: (layout: CanvasDockLayout) => void;
}

export type DockPlacement = 'bottom' | 'left' | 'right';
export interface CanvasDockLayout {
  placement: DockPlacement;
  reservedWidth: number;
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
  entries,
  activeKey,
  onSelectTab,
  onCloseTab,
  onAppMessage,
  onUpdateModelContext,
  onRegisterTeardown,
  onLayoutChange,
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  const compactDock = useMediaQuery(theme.breakpoints.down('md'));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useUiPreference<boolean>(
    `flujo-ui:mcp-canvas:collapsed:${conversationId}`,
    false,
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [placement, setPlacement] = useState<DockPlacement>(() => {
    if (typeof window === 'undefined') return 'bottom';
    const stored = window.localStorage.getItem('flujo-mcp-canvas-placement');
    return stored === 'left' || stored === 'right' ? stored : 'bottom';
  });
  const [dockHeight, setDockHeight] = useState(() => {
    if (typeof window === 'undefined') return 440;
    const stored = Number(window.localStorage.getItem('flujo-mcp-canvas-height'));
    return Number.isFinite(stored) && stored >= 240 ? stored : 440;
  });
  const [dockWidth, setDockWidth] = useState(() => {
    if (typeof window === 'undefined') return 560;
    const stored = Number(window.localStorage.getItem('flujo-mcp-canvas-width'));
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
    window.localStorage.setItem('flujo-mcp-canvas-placement', placement);
  }, [placement]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('flujo-mcp-canvas-height', String(Math.round(dockHeight)));
  }, [dockHeight]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('flujo-mcp-canvas-width', String(Math.round(dockWidth)));
  }, [dockWidth]);
  useEffect(() => {
    onLayoutChange?.({
      placement,
      reservedWidth: entries.length > 0 && !fullscreen && !collapsed && !compactDock && placement !== 'bottom'
        ? dockWidth
        : 0,
    });
  }, [collapsed, compactDock, dockWidth, entries.length, fullscreen, onLayoutChange, placement]);

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
    const startX = event.clientX;
    const startY = event.clientY;
    const startRect = rootRef.current.getBoundingClientRect();
    const parentRect = rootRef.current.parentElement?.getBoundingClientRect();
    const maxHeight = Math.max(240, (parentRect?.height ?? window.innerHeight) * 0.82);
    const maxWidth = Math.max(320, (parentRect?.width ?? window.innerWidth) - 320);
    startPointerDrag(event, placement === 'bottom' ? 'ns-resize' : 'ew-resize', (move) => {
      if (placement === 'bottom') {
        setDockHeight(clamp(startRect.height + startY - move.clientY, 240, maxHeight));
      } else if (placement === 'left') {
        setDockWidth(clamp(startRect.width + move.clientX - startX, 320, maxWidth));
      } else {
        setDockWidth(clamp(startRect.width + startX - move.clientX, 320, maxWidth));
      }
    });
  }, [fullscreen, placement, startPointerDrag]);

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

  // #371: translate viewport geometry into the containing block established by
  // any `backdrop-filter`/`transform` ancestor.
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

  const effectivePlacement = collapsed || compactDock ? 'bottom' : placement;

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
            : {
                position: 'absolute',
                top: 0,
                bottom: 0,
                [effectivePlacement]: 0,
                width: `min(${dockWidth}px, calc(100% - 320px))`,
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
          aria-orientation={effectivePlacement === 'bottom' ? 'horizontal' : 'vertical'}
          aria-label={t('chat.canvas.resize')}
          onPointerDown={startDockResize}
          sx={{
            position: 'absolute',
            zIndex: 4,
            ...(effectivePlacement === 'bottom'
              ? { top: 0, left: 0, right: 0, height: 7, cursor: 'row-resize' }
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
      {/* Tab strip + dock controls */}
      <Box
        onPointerDown={startFullscreenDrag}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          bgcolor: 'action.hover',
          cursor: fullscreen ? 'move' : 'default',
          userSelect: 'none',
        }}
      >
        <WidgetsIcon fontSize="small" color="primary" />
        <Typography variant="caption" sx={{ fontWeight: 600, mr: 1 }}>{t('chat.canvas.title')}</Typography>

        <Box sx={{ display: 'flex', gap: 0.5, overflowX: 'auto', flex: 1, minWidth: 0 }}>
          {entries.map((e) => {
            const isActive = e.key === activeKey;
            const inSplit = activeSplit.includes(e.key);
            return (
              <Box
                key={e.key}
                onClick={() => selectTab(e.key)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  py: 0.25,
                  borderRadius: 1,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  border: 1,
                  borderColor: isActive ? 'primary.main' : 'divider',
                  bgcolor: isActive ? 'action.selected' : 'transparent',
                }}
                title={`${e.serverName} — ${e.uri}`}
              >
                <Badge color="primary" variant="dot" invisible={!e.unread}>
                  <Typography variant="caption" sx={{ fontWeight: isActive ? 600 : 400 }}>
                    {shortResource(e.uri)}
                  </Typography>
                </Badge>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                  {e.serverName}
                </Typography>
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

        {!fullscreen && !collapsed && !compactDock && (
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Tooltip title={t('chat.canvas.dockLeft')}>
              <IconButton
                size="small"
                color={placement === 'left' ? 'primary' : 'default'}
                onClick={() => setPlacement('left')}
                aria-label={t('chat.canvas.dockLeft')}
              >
                <KeyboardArrowLeftIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('chat.canvas.dockBottom')}>
              <IconButton
                size="small"
                color={placement === 'bottom' ? 'primary' : 'default'}
                onClick={() => setPlacement('bottom')}
                aria-label={t('chat.canvas.dockBottom')}
              >
                <KeyboardArrowDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('chat.canvas.dockRight')}>
              <IconButton
                size="small"
                color={placement === 'right' ? 'primary' : 'default'}
                onClick={() => setPlacement('right')}
                aria-label={t('chat.canvas.dockRight')}
              >
                <KeyboardArrowRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}

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
        {!fullscreen && (
          <Tooltip title={collapsed ? t('chat.canvas.expand') : t('chat.canvas.collapse')}>
            <IconButton
              size="small"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={t('chat.canvas.toggleCollapse')}
            >
              {collapsed ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
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
                  onRegisterTeardown?.(conversationId, appKey, callback);
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

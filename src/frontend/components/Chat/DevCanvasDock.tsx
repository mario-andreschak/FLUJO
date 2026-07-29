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

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Tooltip, IconButton, Badge, useTheme } from '@mui/material';
import WidgetsIcon from '@mui/icons-material/Widgets';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import type {
  McpUiDisplayMode,
  McpUiUpdateModelContextRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import McpAppFrame from './McpAppFrame';
import type { CanvasAppEntry } from './canvasState';

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
}

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
}) => {
  const theme = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [appModesByKey, setAppModesByKey] = useState<Record<string, McpUiDisplayMode[]>>({});
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
      setFullscreen(true);
      return 'fullscreen';
    }
    if (mode === 'pip' && current === 'fullscreen' && appModes.includes('pip')) {
      setFullscreen(false);
      return 'pip';
    }
    return current;
  };

  return (
    <Box
      data-testid="dev-canvas-dock"
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(fullscreen
          ? { position: 'fixed', inset: 16, zIndex: 1300, borderRadius: 1, boxShadow: 6, border: 1 }
          : { maxHeight: '45vh' }),
      }}
    >
      {/* Tab strip + dock controls */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, bgcolor: 'action.hover' }}>
        <WidgetsIcon fontSize="small" color="primary" />
        <Typography variant="caption" sx={{ fontWeight: 600, mr: 1 }}>Canvas</Typography>

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
                <Tooltip title={inSplit ? 'Remove from split' : 'Add to split view'}>
                  <IconButton
                    size="small"
                    sx={{ p: 0.25 }}
                    color={inSplit ? 'primary' : 'default'}
                    onClick={(ev) => { ev.stopPropagation(); toggleSplit(e.key); }}
                    aria-label="Toggle split view"
                  >
                    <ViewColumnIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Close">
                  <IconButton
                    size="small"
                    sx={{ p: 0.25 }}
                    onClick={(ev) => { ev.stopPropagation(); onCloseTab(e.key); }}
                    aria-label="Close canvas tab"
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Box>

        <Tooltip
          title={fullscreen
            ? 'Exit fullscreen'
            : fullscreenAvailable
              ? 'Fullscreen'
              : 'Every visible app must declare pip and fullscreen support'}
        >
          <span>
            <IconButton
              size="small"
              disabled={!fullscreen && !fullscreenAvailable}
              onClick={() => setFullscreen((value) => !value)}
              aria-label="Toggle canvas fullscreen"
            >
              {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={collapsed ? 'Expand canvas' : 'Collapse canvas'}>
          <IconButton
            size="small"
            onClick={() => {
              if (!collapsed && fullscreen) setFullscreen(false);
              setCollapsed((value) => !value);
            }}
            aria-label="Toggle canvas collapse"
          >
            {collapsed ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
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
          height: fullscreen ? 'auto' : 320,
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
  );
};

export default DevCanvasDock;

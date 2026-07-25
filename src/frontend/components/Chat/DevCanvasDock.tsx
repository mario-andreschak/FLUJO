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

import React, { useMemo, useState } from 'react';
import { Box, Typography, Tooltip, IconButton, Badge, useTheme } from '@mui/material';
import WidgetsIcon from '@mui/icons-material/Widgets';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import McpAppFrame from './McpAppFrame';
import type { CanvasAppEntry } from './canvasState';

interface DevCanvasDockProps {
  /** Docked apps in stable tab order. Empty → the dock renders nothing. */
  entries: CanvasAppEntry[];
  /** Currently-focused tab key, or null. */
  activeKey: string | null;
  /** Focus a tab (clears its unread badge upstream). */
  onSelectTab: (key: string) => void;
  /** Close a tab (tears down its bridge upstream). */
  onCloseTab: (key: string) => void;
  /** Human-in-the-loop return channel for app messages. */
  onAppMessage?: (text: string) => void;
}

/** Short, human label for a `ui://server/name` resource. */
function shortResource(uri: string): string {
  const tail = uri.replace(/\/+$/, '').split('/').pop();
  return tail || uri;
}

const DevCanvasDock: React.FC<DevCanvasDockProps> = ({
  entries,
  activeKey,
  onSelectTab,
  onCloseTab,
  onAppMessage,
}) => {
  const theme = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
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

  const columns = Math.max(1, Math.ceil(Math.sqrt(visibleKeys.length)));

  if (entries.length === 0) return null;

  const toggleSplit = (key: string) => {
    setSplitKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
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
                onClick={() => onSelectTab(e.key)}
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

        <Tooltip title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          <IconButton size="small" onClick={() => setFullscreen((v) => !v)} aria-label="Toggle canvas fullscreen">
            {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={collapsed ? 'Expand canvas' : 'Collapse canvas'}>
          <IconButton size="small" onClick={() => setCollapsed((v) => !v)} aria-label="Toggle canvas collapse">
            {collapsed ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* Body: persistent hosts. Collapse hides the body via CSS but keeps every
          bridge/iframe alive (owner decision #2). Split renders an N-up grid. */}
      <Box
        sx={{
          display: collapsed ? 'none' : 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 1,
          p: 1,
          flex: 1,
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
                // from layout via CSS only — its host stays mounted.
                display: isVisible ? 'flex' : 'none',
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
                onAppMessage={onAppMessage}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export default DevCanvasDock;

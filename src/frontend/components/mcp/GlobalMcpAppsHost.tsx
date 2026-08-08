'use client';

/**
 * Persistent, route-independent owner for MCP Apps started from Quick Actions.
 *
 * Apps mount inline first so an inline-only View still works. A View that
 * advertises `pip` is gracefully handed to the reused canvas dock; from then on
 * docking/fullscreen changes are CSS/protocol transitions on one stable host.
 * The component lives above route content in AppWrapper, so navigation never
 * reparents or destroys a running iframe.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';

import DevCanvasDock, {
  type CanvasDockLayout,
} from '@/frontend/components/Chat/DevCanvasDock';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame';
import {
  DEFAULT_CANVAS_TAB_CAP,
  canvasEntries,
  canvasKey,
  closeCanvasApp,
  emptyCanvasState,
  enforceCap,
  openCanvasApp,
  setActiveCanvasTab,
  type CanvasState,
} from '@/frontend/components/Chat/canvasState';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  subscribeLaunchGlobalMcpApp,
  type GlobalMcpAppLaunchRequest,
} from '@/frontend/utils/quickActions';
import { createLogger } from '@/utils/logger';

const GLOBAL_SURFACE_ID = 'app-shell';
const log = createLogger('frontend/components/mcp/GlobalMcpAppsHost');
const EMPTY_LAYOUT: CanvasDockLayout = {
  placement: 'bottom',
  reservedWidth: 0,
  reservedHeight: 0,
};

interface InlineLaunch extends GlobalMcpAppLaunchRequest {
  key: string;
  openedAt: number;
}

const withoutKey = <T extends Record<string, unknown>>(value: T, key: string): T => {
  if (!(key in value)) return value;
  const next = { ...value };
  delete next[key];
  return next;
};

export default function GlobalMcpAppsHost() {
  const { t } = useI18n();
  const [canvasState, setCanvasState] = useState<CanvasState>(emptyCanvasState);
  const canvasStateRef = useRef(canvasState);
  const [inlineLaunches, setInlineLaunches] = useState<Record<string, InlineLaunch>>({});
  const inlineLaunchesRef = useRef(inlineLaunches);
  const [layout, setLayout] = useState<CanvasDockLayout>(EMPTY_LAYOUT);
  const teardownsRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const closingDockKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => { canvasStateRef.current = canvasState; }, [canvasState]);
  useEffect(() => { inlineLaunchesRef.current = inlineLaunches; }, [inlineLaunches]);

  const updateCanvas = useCallback((update: (state: CanvasState) => CanvasState) => {
    setCanvasState((current) => {
      const next = update(current);
      canvasStateRef.current = next;
      return next;
    });
  }, []);

  const launchInCanvas = useCallback((request: GlobalMcpAppLaunchRequest) => {
    updateCanvas((current) => {
      const key = canvasKey(request.serverName, request.uri);
      const existing = current.entries[key];
      // Re-selecting an already-running app is a focus operation. Preserve its
      // live iframe unless the user explicitly selected a different linked tool.
      if (existing && (
        request.toolName === undefined
        || request.toolName === existing.toolName
      )) return setActiveCanvasTab(current, key);
      // Match Chat's graceful LRU behavior: temporarily allow the 17th host;
      // the cap effect below tears down the victim before removing its entry.
      return openCanvasApp(current, {
        serverName: request.serverName,
        uri: request.uri,
        toolName: request.toolName,
      }, Date.now(), Number.MAX_SAFE_INTEGER).state;
    });
  }, [updateCanvas]);

  const handleLaunch = useCallback((request: GlobalMcpAppLaunchRequest) => {
    const key = canvasKey(request.serverName, request.uri);
    if (canvasStateRef.current.entries[key]) {
      launchInCanvas(request);
      return;
    }
    setInlineLaunches((current) => {
      const next = {
        ...current,
        [key]: { ...request, key, openedAt: Date.now() },
      };
      inlineLaunchesRef.current = next;
      return next;
    });
  }, [launchInCanvas]);

  useEffect(() => subscribeLaunchGlobalMcpApp(handleLaunch), [handleLaunch]);

  const removeInline = useCallback((key: string) => {
    setInlineLaunches((current) => {
      const next = withoutKey(current, key);
      inlineLaunchesRef.current = next;
      return next;
    });
  }, []);

  const closeInline = useCallback((key: string) => {
    const registered = teardownsRef.current.get(`inline:${key}`);
    if (registered) void registered().finally(() => removeInline(key));
    else removeInline(key);
  }, [removeInline]);

  const dockInline = useCallback((request: InlineLaunch) => {
    // McpAppFrame completes the old inline View's graceful teardown before it
    // calls this handoff. The fresh pip View is then mounted exactly once here.
    launchInCanvas(request);
    removeInline(request.key);
  }, [launchInCanvas, removeInline]);

  const closeDockTab = useCallback((key: string) => {
    if (closingDockKeysRef.current.has(key)) return;
    closingDockKeysRef.current.add(key);
    const registered = teardownsRef.current.get(`dock:${key}`);
    const finish = () => {
      closingDockKeysRef.current.delete(key);
      updateCanvas((current) => closeCanvasApp(current, key));
    };
    if (registered) void registered().finally(finish);
    else finish();
  }, [updateCanvas]);

  const closeAllDockApps = useCallback(() => {
    const keys = canvasStateRef.current.order.filter(
      (key) => !closingDockKeysRef.current.has(key),
    );
    if (keys.length === 0) return;
    keys.forEach((key) => closingDockKeysRef.current.add(key));
    const pending = keys.map((key) => teardownsRef.current.get(`dock:${key}`)?.() ?? Promise.resolve());
    void Promise.allSettled(pending).finally(() => {
      keys.forEach((key) => closingDockKeysRef.current.delete(key));
      updateCanvas((current) => keys.reduce(closeCanvasApp, current));
    });
  }, [updateCanvas]);

  // Keep the global surface bounded without dropping a live iframe before its
  // ui/resource-teardown acknowledgement (or McpAppFrame's deadline).
  useEffect(() => {
    if (canvasState.order.length <= DEFAULT_CANVAS_TAB_CAP) return;
    const { evicted } = enforceCap(
      canvasState,
      DEFAULT_CANVAS_TAB_CAP,
      canvasState.activeKey ?? undefined,
    );
    for (const key of evicted) {
      if (closingDockKeysRef.current.has(key)) continue;
      closingDockKeysRef.current.add(key);
      log.info(`Global MCP App cap reached — gracefully evicting (LRU): ${key}`);
      const registered = teardownsRef.current.get(`dock:${key}`);
      const pending = registered ? registered() : Promise.resolve();
      void pending.finally(() => {
        closingDockKeysRef.current.delete(key);
        updateCanvas((current) => closeCanvasApp(current, key));
      });
    }
  }, [canvasState, updateCanvas]);

  const handleLayoutChange = useCallback((next: CanvasDockLayout) => {
    setLayout((current) => (
      current.placement === next.placement
      && current.reservedWidth === next.reservedWidth
      && current.reservedHeight === next.reservedHeight
        ? current
        : next
    ));
  }, []);

  // Reserve route content around the viewport-level dock without coupling any
  // individual page to MCP state. A collapsed rail deliberately reserves zero.
  useEffect(() => {
    const root = document.documentElement;
    const left = layout.placement === 'left' ? layout.reservedWidth : 0;
    const right = layout.placement === 'right' ? layout.reservedWidth : 0;
    const top = layout.placement === 'top' ? layout.reservedHeight : 0;
    const bottom = layout.placement === 'bottom' ? layout.reservedHeight : 0;
    root.style.setProperty('--global-mcp-dock-left', `${left}px`);
    root.style.setProperty('--global-mcp-dock-right', `${right}px`);
    root.style.setProperty('--global-mcp-dock-top', `${top}px`);
    root.style.setProperty('--global-mcp-dock-bottom', `${bottom}px`);
    return () => {
      root.style.removeProperty('--global-mcp-dock-left');
      root.style.removeProperty('--global-mcp-dock-right');
      root.style.removeProperty('--global-mcp-dock-top');
      root.style.removeProperty('--global-mcp-dock-bottom');
    };
  }, [layout]);

  useEffect(() => () => {
    for (const teardown of teardownsRef.current.values()) void teardown();
  }, []);

  const inlineEntries = Object.values(inlineLaunches)
    .sort((a, b) => a.openedAt - b.openedAt);

  return (
    <Box data-testid="global-mcp-app-host">
      {inlineEntries.length > 0 && (
        <Box
          data-testid="global-mcp-inline-launchers"
          sx={{
            position: 'fixed',
            right: { xs: 8, sm: 24 },
            bottom: { xs: 8, sm: 24 },
            zIndex: (theme) => theme.zIndex.drawer - 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            width: { xs: 'calc(100vw - 16px)', sm: 'min(640px, calc(100vw - 48px))' },
            maxHeight: 'calc(100dvh - var(--app-bar-height) - var(--active-subnav-height) - 32px)',
            overflowY: 'auto',
          }}
        >
          {inlineEntries.map((entry) => (
            <Box
              key={entry.key}
              sx={{
                position: 'relative',
                minWidth: 0,
                bgcolor: 'background.paper',
                borderRadius: 1,
                boxShadow: 8,
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1,
                  py: 0.25,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {entry.serverName} — {entry.uri}
                </Typography>
                <Tooltip title={t('common.close')}>
                  <IconButton
                    size="small"
                    aria-label={t('common.close')}
                    onClick={() => closeInline(entry.key)}
                  >
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
              <McpAppFrame
                serverName={entry.serverName}
                uri={entry.uri}
                toolName={entry.toolName}
                ownerScopeId={`${GLOBAL_SURFACE_ID}:${entry.key}`}
                defaultExpanded
                autoDock
                onRequestDock={() => dockInline(entry)}
                onRequestClose={() => removeInline(entry.key)}
                teardownRegistrationKey={`global-inline:${entry.key}`}
                onRegisterTeardown={(_registrationKey, callback) => {
                  const key = `inline:${entry.key}`;
                  if (callback) teardownsRef.current.set(key, callback);
                  else teardownsRef.current.delete(key);
                }}
              />
            </Box>
          ))}
        </Box>
      )}

      <DevCanvasDock
        persistenceId={GLOBAL_SURFACE_ID}
        appOwnerScopePrefix={GLOBAL_SURFACE_ID}
        viewportDocked
        entries={canvasEntries(canvasState)}
        activeKey={canvasState.activeKey}
        onSelectTab={(key) => updateCanvas((current) => setActiveCanvasTab(current, key))}
        onCloseTab={closeDockTab}
        onRegisterTeardown={(_ownerId, appKey, callback) => {
          const key = `dock:${appKey}`;
          if (callback) teardownsRef.current.set(key, callback);
          else teardownsRef.current.delete(key);
        }}
        onLayoutChange={handleLayoutChange}
        onCloseAll={closeAllDockApps}
      />
    </Box>
  );
}

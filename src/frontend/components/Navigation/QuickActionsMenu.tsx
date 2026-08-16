"use client";

import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import {
  AddCommentRounded,
  AppsRounded,
  ArrowBackRounded,
  BoltRounded,
  BuildRounded,
  ChevronRightRounded,
  RefreshRounded,
} from '@mui/icons-material';
import { alpha, useTheme } from '@mui/material/styles';

import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  useMcpAppsDiscovery,
  type McpDiscoveredApp,
} from '@/frontend/components/mcp/useMcpAppsDiscovery';
import {
  createQuickActionToken,
  emitLaunchGlobalMcpApp,
  emitNewChatRequest,
  newChatPath,
  type GlobalMcpAppLaunchRequest,
} from '@/frontend/utils/quickActions';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Navigation/QuickActionsMenu');

export interface QuickActionsMenuProps {
  /** Current route, used to decide between a route intent and an in-page event. */
  pathname: string;
  /** Navigation-owned, interception-aware push. */
  onNavigate: (href: string) => void;
  /**
   * `floating` is the bottom-left control of the desktop layout; `drawer` is
   * the same action pinned to the bottom of the compact navigation Drawer, so
   * the spatial intent of issue #396 survives below 1280px.
   */
  variant?: 'floating' | 'drawer';
  /** Called after an action so the compact Drawer can close itself. */
  onAction?: () => void;
}

type QuickActionsView = 'root' | 'mcp';

/**
 * Bottom-left quick actions (#396): `New Chat` and an `MCP App` hierarchy of
 * favorited servers → published apps, with linked tools in a child menu.
 *
 * This component owns placement and interaction only. Everything it triggers is
 * delegated to the flows that already exist: chat creation happens in `Chat`
 * through `createNewConversation`; apps are handed to the persistent app-shell
 * host. Selecting a linked tool starts/focuses its app — it never invokes the
 * tool and never enters Tool Tester.
 */
export default function QuickActionsMenu({
  pathname,
  onNavigate,
  variant = 'floating',
  onAction,
}: QuickActionsMenuProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<QuickActionsView>('root');
  const [toolsMenu, setToolsMenu] = useState<{
    anchorEl: HTMLElement;
    focusEl: HTMLElement;
    app: McpDiscoveredApp;
  } | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const open = Boolean(anchorEl);

  const triggerId = `quick-actions-trigger-${variant}`;
  const menuId = `quick-actions-menu-${variant}`;
  const toolsMenuId = `quick-actions-tools-menu-${variant}`;

  // MCP discovery is scoped to the MCP branch, so opening the menu — and
  // `New Chat` in particular — never waits for an MCP round trip.
  const {
    servers,
    loading,
    refreshing,
    error,
    discoveryId,
    refresh,
  } = useMcpAppsDiscovery({
    active: open && view === 'mcp',
    favoritesOnly: true,
    requireApps: true,
  });

  // A route change means the menu's context is gone; close it.
  useEffect(() => {
    setAnchorEl(null);
    setToolsMenu(null);
  }, [pathname]);

  // Always reopen at the top of the hierarchy.
  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  // A refresh can remove a server, app, or tool. Never leave a child menu
  // anchored to the stale discovery snapshot while the new result arrives.
  useEffect(() => {
    setToolsMenu(null);
  }, [discoveryId]);

  // Keep the keyboard inside the menu when the user drills in or back out:
  // the previously focused item unmounts with the view it belonged to.
  useEffect(() => {
    if (!open) return;
    const first = paperRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    first?.focus();
  }, [open, view]);

  const closeToolsMenu = () => setToolsMenu(null);
  const closeMenu = () => {
    closeToolsMenu();
    setAnchorEl(null);
  };

  const runAction = (action: () => void) => {
    action();
    closeMenu();
    onAction?.();
  };

  const handleNewChat = () => runAction(() => {
    // One token per click; whichever transport arrives first wins, the other
    // becomes a no-op, so a click can never create two conversations.
    const token = createQuickActionToken();
    log.debug('Quick action: new chat requested', { token, pathname });
    if (pathname === '/chat') {
      emitNewChatRequest(token);
      return;
    }
    onNavigate(newChatPath(token));
  });

  const handleMcpTarget = (request: GlobalMcpAppLaunchRequest) => runAction(() => {
    log.debug('Quick action: starting MCP App in global surface', request);
    emitLaunchGlobalMcpApp(request);
  });

  const openToolsMenu = (
    anchor: HTMLElement,
    app: McpDiscoveredApp,
    focusEl: HTMLElement = anchor,
  ) => {
    if (app.toolNames.length === 0) return;
    setToolsMenu({ anchorEl: anchor, focusEl, app });
  };

  /**
   * Handled on the MenuList (not on the Menu/Modal root) so that stopping
   * propagation actually keeps MUI's own Escape-closes-the-modal handler from
   * running: inside the MCP branch, Escape/Left step BACK to the root list,
   * and only Escape on the root list dismisses the menu. Tab keeps MUI's
   * default meaning (close and move on), which this handler replaces because
   * it takes over `MenuListProps.onKeyDown`.
   */
  const handleMenuListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (view !== 'mcp') return;
    if (event.key !== 'Escape' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    event.stopPropagation();
    setView('root');
  };

  const staticItemSx = {
    display: 'block',
    px: 2,
    py: 1,
    color: 'text.secondary',
    whiteSpace: 'normal',
  } as const;

  const rootItems = [
    <MenuItem key="new-chat" onClick={handleNewChat} data-testid="quick-action-new-chat">
      <ListItemIcon><AddCommentRounded fontSize="small" /></ListItemIcon>
      <ListItemText primary={t('nav.quickActions.newChat')} />
    </MenuItem>,
    <MenuItem
      key="mcp-app"
      onClick={() => setView('mcp')}
      aria-haspopup="menu"
      aria-expanded={false}
      data-testid="quick-action-mcp-app"
    >
      <ListItemIcon><AppsRounded fontSize="small" /></ListItemIcon>
      <ListItemText
        primary={t('nav.quickActions.mcpApp')}
        secondary={t('nav.quickActions.mcpAppSummary')}
      />
      <ChevronRightRounded fontSize="small" sx={{ ml: 1, color: 'text.secondary' }} />
    </MenuItem>,
  ];

  const mcpItems: React.ReactNode[] = [
    <MenuItem key="back" onClick={() => setView('root')} aria-label={t('nav.quickActions.backAria')}>
      <ListItemIcon><ArrowBackRounded fontSize="small" /></ListItemIcon>
      <ListItemText
        primary={t('nav.quickActions.mcpApp')}
        secondary={t('nav.quickActions.mcpAppSummary')}
      />
    </MenuItem>,
    <Divider key="back-divider" component="li" />,
  ];

  if (loading) {
    mcpItems.push(
      <Box key="loading" component="li" sx={{ ...staticItemSx, display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          {t('nav.quickActions.loading')}
        </Typography>
      </Box>,
    );
  } else if (error) {
    mcpItems.push(
      <Box key="error" component="li" sx={staticItemSx}>
        <Typography variant="body2" color="error">{error}</Typography>
      </Box>,
    );
  } else if (servers.length === 0) {
    mcpItems.push(
      <Box key="empty" component="li" sx={staticItemSx}>
        <Typography variant="body2" fontWeight={600} color="text.primary">
          {t('nav.quickActions.empty')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('nav.quickActions.emptyHelp')}
        </Typography>
      </Box>,
    );
  } else {
    for (const server of servers) {
      mcpItems.push(
        <ListSubheader key={`server-${server.name}`} disableSticky sx={{ bgcolor: 'transparent', lineHeight: 2.4 }}>
          {server.name}
        </ListSubheader>,
      );

      if (server.error) {
        // Scoped to this server: the other servers, and New Chat, stay usable.
        mcpItems.push(
          <Box key={`server-error-${server.name}`} component="li" sx={staticItemSx}>
            <Typography variant="body2" color="warning.main">
              {t('nav.quickActions.serverUnavailable', { server: server.name })}
            </Typography>
            <Typography variant="caption" color="text.secondary">{server.error}</Typography>
          </Box>,
        );
        continue;
      }

      for (const app of server.apps) {
        const toolsMenuOpen = toolsMenu?.app.serverName === app.serverName
          && toolsMenu.app.uri === app.uri;
        mcpItems.push(
          <MenuItem
            key={`app-${server.name}-${app.uri}`}
            onClick={() => handleMcpTarget({ serverName: app.serverName, uri: app.uri })}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' || app.toolNames.length === 0) return;
              event.preventDefault();
              event.stopPropagation();
              openToolsMenu(event.currentTarget, app);
            }}
            aria-label={t('nav.quickActions.openApp', { app: app.name })}
            aria-haspopup={app.toolNames.length > 0 ? 'menu' : undefined}
            aria-expanded={app.toolNames.length > 0 ? toolsMenuOpen : undefined}
            aria-controls={toolsMenuOpen ? toolsMenuId : undefined}
            aria-keyshortcuts={app.toolNames.length > 0 ? 'ArrowRight' : undefined}
            sx={{ minWidth: 0 }}
          >
            <ListItemIcon><AppsRounded fontSize="small" /></ListItemIcon>
            <ListItemText
              primary={app.name}
              secondary={app.uri}
              secondaryTypographyProps={{ sx: { overflowWrap: 'anywhere' } }}
            />
            {app.toolNames.length > 0 && (
              <Box
                component="span"
                data-linked-tools-trigger
                title={t('nav.quickActions.linkedTools', { app: app.name })}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openToolsMenu(event.currentTarget, app, event.currentTarget.parentElement ?? event.currentTarget);
                }}
                sx={{
                  alignSelf: 'stretch',
                  display: 'grid',
                  minWidth: 42,
                  ml: 0.5,
                  placeItems: 'center',
                  borderLeft: 1,
                  borderColor: 'divider',
                  cursor: 'pointer',
                }}
              >
                <ChevronRightRounded fontSize="small" />
              </Box>
            )}
          </MenuItem>,
        );
      }
    }
  }

  if (!loading) {
    mcpItems.push(
      <Divider key="refresh-divider" component="li" />,
      <MenuItem key="refresh" onClick={refresh} disabled={refreshing}>
        <ListItemIcon>
          {refreshing ? <CircularProgress size={16} /> : <RefreshRounded fontSize="small" />}
        </ListItemIcon>
        <ListItemText primary={t('nav.quickActions.refresh')} />
      </MenuItem>,
    );
  }

  const trigger = variant === 'drawer' ? (
    <Button
      id={triggerId}
      fullWidth
      variant="outlined"
      startIcon={<BoltRounded />}
      onClick={(event) => setAnchorEl(event.currentTarget)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-app-quick-actions
      sx={{ justifyContent: 'flex-start', px: 1.5, py: 1, borderRadius: 2.5, fontWeight: 700 }}
    >
      {t('nav.quickActions')}
    </Button>
  ) : (
    <Button
      id={triggerId}
      variant="contained"
      color="primary"
      startIcon={<BoltRounded />}
      onClick={(event) => setAnchorEl(event.currentTarget)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-app-quick-actions
      sx={{
        px: 2,
        py: 1.1,
        borderRadius: 999,
        fontWeight: 750,
        textTransform: 'none',
        boxShadow: `0 12px 30px ${alpha(theme.palette.primary.main, 0.34)}`,
      }}
    >
      {t('nav.quickActions')}
    </Button>
  );

  return (
    <>
      {trigger}
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        MenuListProps={{
          'aria-labelledby': triggerId,
          dense: false,
          onKeyDown: handleMenuListKeyDown,
        }}
        slotProps={{
          paper: {
            ref: paperRef,
            sx: { minWidth: 288, maxWidth: 380, maxHeight: '70vh', borderRadius: 3 },
          },
        }}
      >
        {view === 'root' ? rootItems : mcpItems}
      </Menu>
      <Menu
        id={toolsMenuId}
        anchorEl={toolsMenu?.anchorEl ?? null}
        open={Boolean(toolsMenu)}
        onClose={closeToolsMenu}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        MenuListProps={{
          'aria-label': toolsMenu
            ? t('nav.quickActions.linkedTools', { app: toolsMenu.app.name })
            : undefined,
          onKeyDown: (event) => {
            if (event.key !== 'Escape' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            event.stopPropagation();
            const returnTarget = toolsMenu?.focusEl;
            closeToolsMenu();
            returnTarget?.focus();
          },
        }}
        slotProps={{ paper: { sx: { minWidth: 240, maxWidth: 360, borderRadius: 2.5 } } }}
      >
        {toolsMenu?.app.toolNames.map((toolName) => (
          <MenuItem
            key={toolName}
            onClick={() => handleMcpTarget({
              serverName: toolsMenu.app.serverName,
              uri: toolsMenu.app.uri,
              toolName,
            })}
            aria-label={t('nav.quickActions.openTool', { tool: toolName })}
          >
            <ListItemIcon><BuildRounded fontSize="small" /></ListItemIcon>
            <ListItemText primary={toolName} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

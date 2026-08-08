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
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import {
  createQuickActionToken,
  emitNewChatRequest,
  emitOpenMcpApp,
  mcpAppPath,
  newChatPath,
  type McpAppQuickAction,
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
 * favorited servers → published apps → linked tools.
 *
 * This component owns placement and interaction only. Everything it triggers is
 * delegated to the flows that already exist: chat creation happens in `Chat`
 * through `createNewConversation`, apps open in the MCP Apps dashboard and
 * linked tools open in the Tool Tester. No conversation API and no tool
 * invocation is called from here.
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
  const paperRef = useRef<HTMLDivElement | null>(null);
  const open = Boolean(anchorEl);

  const triggerId = `quick-actions-trigger-${variant}`;
  const menuId = `quick-actions-menu-${variant}`;

  // MCP discovery is scoped to the MCP branch, so opening the menu — and
  // `New Chat` in particular — never waits for an MCP round trip.
  const {
    servers,
    loading,
    refreshing,
    error,
    refresh,
  } = useMcpAppsDiscovery({
    active: open && view === 'mcp',
    favoritesOnly: true,
    requireApps: true,
  });

  // A route change means the menu's context is gone; close it.
  useEffect(() => {
    setAnchorEl(null);
  }, [pathname]);

  // Always reopen at the top of the hierarchy.
  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  // Keep the keyboard inside the menu when the user drills in or back out:
  // the previously focused item unmounts with the view it belonged to.
  useEffect(() => {
    if (!open) return;
    const first = paperRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    first?.focus();
  }, [open, view]);

  const closeMenu = () => setAnchorEl(null);

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

  const handleMcpTarget = (request: McpAppQuickAction) => runAction(() => {
    const token = createQuickActionToken();
    log.debug('Quick action: MCP target requested', { ...request, token });
    if (pathname === '/mcp') {
      emitOpenMcpApp(request, token);
      return;
    }
    onNavigate(mcpAppPath(request, token));
  });

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
        mcpItems.push(
          <MenuItem
            key={`app-${server.name}-${app.uri}`}
            onClick={() => handleMcpTarget({ serverName: app.serverName, uri: app.uri })}
            aria-label={t('nav.quickActions.openApp', { app: app.name })}
          >
            <ListItemIcon><AppsRounded fontSize="small" /></ListItemIcon>
            <ListItemText
              primary={app.name}
              secondary={app.uri}
              secondaryTypographyProps={{ sx: { overflowWrap: 'anywhere' } }}
            />
          </MenuItem>,
        );

        if (app.toolNames.length === 0) {
          mcpItems.push(
            <Box key={`no-tools-${server.name}-${app.uri}`} component="li" sx={{ ...staticItemSx, pl: 6, py: 0.25 }}>
              <Typography variant="caption" color="text.secondary">
                {t('nav.quickActions.noTools')}
              </Typography>
            </Box>,
          );
          continue;
        }

        for (const toolName of app.toolNames) {
          mcpItems.push(
            <MenuItem
              key={`tool-${server.name}-${app.uri}-${toolName}`}
              onClick={() => handleMcpTarget({ serverName: app.serverName, toolName })}
              aria-label={t('nav.quickActions.openTool', { tool: toolName })}
              sx={{ pl: 5 }}
            >
              <ListItemIcon><BuildRounded fontSize="small" /></ListItemIcon>
              <ListItemText primary={toolName} primaryTypographyProps={{ variant: 'body2' }} />
            </MenuItem>,
          );
        }
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
    </>
  );
}

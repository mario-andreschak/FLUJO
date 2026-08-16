'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AppsIcon from '@mui/icons-material/Apps';
import BuildIcon from '@mui/icons-material/Build';
import RefreshIcon from '@mui/icons-material/Refresh';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import { mcpAppKey as appKey, useMcpAppsDiscovery } from './useMcpAppsDiscovery';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** Server + `ui://` resource the dashboard should preview when it opens (#396). */
export interface McpAppsDashboardSelection {
  serverName: string;
  uri: string;
}

interface McpAppsDashboardProps {
  open: boolean;
  onClose: () => void;
  onOpenToolTester: (serverName: string, toolName: string) => void;
  /**
   * #396: the quick-actions menu opens this dashboard on a specific app.
   * Applied once per discovery run; discovery, rendering and the sandbox
   * boundary are unchanged, and an unknown target falls back to the first app.
   */
  initialSelection?: McpAppsDashboardSelection | null;
}

/**
 * Discover and launch standalone MCP App resources without weakening the
 * existing McpAppFrame authorization, validation, or sandbox boundary.
 */
const McpAppsDashboard: React.FC<McpAppsDashboardProps> = ({
  open,
  onClose,
  onOpenToolTester,
  initialSelection = null,
}) => {
  const { t, tp } = useI18n();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Discovery is shared with the navigation quick-actions menu (#396) so the
  // two surfaces cannot disagree about what an MCP App is. The dashboard keeps
  // its unfiltered mode: every enabled, opted-in server, apps or not.
  const {
    servers,
    apps: allApps,
    loading,
    refreshing,
    error: loadError,
    serverErrors: discoveryErrors,
    discoveryId,
    refresh,
  } = useMcpAppsDiscovery({ active: open });

  // Each discovery run (open, refresh, server config change) restarts the
  // selection exactly as before, so a revoked server can never keep an app
  // frame on screen.
  useEffect(() => {
    setSelectedKey(null);
  }, [discoveryId]);

  useEffect(() => {
    if (!open) setSelectedKey(null);
  }, [open]);

  // #396: a caller-supplied target is honored once and then forgotten, so a
  // later refresh or a manual click is not undone by it.
  const pendingSelectionRef = useRef<McpAppsDashboardSelection | null>(null);
  useEffect(() => {
    pendingSelectionRef.current = open ? initialSelection : null;
  }, [initialSelection, open]);

  const selectedApp = useMemo(
    () => allApps.find((app) => appKey(app.serverName, app.uri) === selectedKey),
    [allApps, selectedKey],
  );
  const eligibleServerCount = servers.length;

  // Opening the library should show an app, not another empty selection step.
  useEffect(() => {
    if (!open || selectedKey || allApps.length === 0) return;
    const wanted = pendingSelectionRef.current;
    if (wanted) {
      pendingSelectionRef.current = null;
      const match = allApps.find(
        (app) => app.serverName === wanted.serverName && app.uri === wanted.uri,
      );
      if (match) {
        setSelectedKey(appKey(match.serverName, match.uri));
        return;
      }
    }
    setSelectedKey(appKey(allApps[0].serverName, allApps[0].uri));
  }, [allApps, open, selectedKey]);


  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      aria-labelledby="mcp-apps-dashboard-title"
      slotProps={{
        paper: {
          sx: {
            // Opt out of the global theme's backdropFilter so that
            // position:fixed descendants (MCP App panels) resolve against
            // the real viewport instead of being clipped by this dialog.
            backdropFilter: 'none',
            borderRadius: 0,
            border: 0,
            margin: 0,
            width: '100%',
            maxWidth: '100%',
            height: '100%',
            maxHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <DialogHeaderActions
        title={(
          <Box display="flex" alignItems="center" gap={1} minWidth={0}>
            <AppsIcon color="primary" />
            <Typography id="mcp-apps-dashboard-title" variant="h6" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {t('mcp.apps.title')}
            </Typography>
          </Box>
        )}
        onClose={onClose}
        additionalActions={(
          <Tooltip title={t('mcp.apps.refresh')}>
            <span>
              <IconButton
                aria-label={t('mcp.apps.refresh')}
                onClick={refresh}
                disabled={loading || refreshing}
                size="small"
              >
                {refreshing ? <CircularProgress size={20} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}
      />
      <Divider />

      <DialogContent sx={{ p: 0, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading ? (
          <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ flex: 1 }}>
            <CircularProgress />
            <Typography color="text.secondary">{t('mcp.apps.discovering')}</Typography>
          </Stack>
        ) : loadError ? (
          <Alert severity="error" sx={{ m: 3 }}>{loadError}</Alert>
        ) : eligibleServerCount === 0 ? (
          <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ flex: 1, p: 3 }}>
            <AppsIcon color="disabled" sx={{ fontSize: 48 }} />
            <Typography variant="h6">{t('mcp.apps.noServers')}</Typography>
            <Typography color="text.secondary" textAlign="center">
              {t('mcp.apps.noServersHelp')}
            </Typography>
          </Stack>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(300px, 34%) 1fr' }, flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <Box sx={{ borderRight: { md: '1px solid' }, borderColor: { md: 'divider' }, p: 2, overflow: 'auto', minHeight: 0 }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                {t('mcp.apps.summary', {
                  apps: tp('mcp.apps.app', allApps.length),
                  servers: tp('mcp.apps.server', eligibleServerCount),
                })}
              </Typography>

              {servers.map((server) => (
                <Box key={server.name} sx={{ mb: 2.5 }}>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                    {server.name}
                  </Typography>
                  {server.error ? (
                    <Alert severity="warning">
                      <Typography variant="body2" fontWeight={600}>{t('mcp.apps.unavailable')}</Typography>
                      <Typography variant="body2">{server.error}</Typography>
                    </Alert>
                  ) : server.apps.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      {t('mcp.apps.noneForServer')}
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {server.apps.map((app) => {
                        const key = appKey(app.serverName, app.uri);
                        return (
                          <Card key={key} variant="outlined" sx={{ borderColor: selectedKey === key ? 'primary.main' : 'divider' }}>
                            <CardActionArea
                              onClick={() => setSelectedKey(key)}
                              aria-pressed={selectedKey === key}
                            >
                              <CardContent sx={{ py: 1.5 }}>
                                <Typography variant="subtitle2">{app.name}</Typography>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                                  {app.uri}
                                </Typography>
                                {app.toolNames.length > 0 && (
                                  <Chip icon={<BuildIcon />} label={tp('mcp.apps.tools', app.toolNames.length)} size="small" sx={{ mt: 1 }} />
                                )}
                                {!app.listedResource && (
                                  <Chip label={t('mcp.apps.toolDiscovered')} size="small" variant="outlined" sx={{ mt: 1, ml: app.toolNames.length > 0 ? 1 : 0 }} />
                                )}
                              </CardContent>
                            </CardActionArea>
                          </Card>
                        );
                      })}
                    </Stack>
                  )}
                </Box>
              ))}

              {allApps.length === 0 && discoveryErrors.length === 0 && (
                <Alert severity="info">{t('mcp.apps.none')}</Alert>
              )}
            </Box>

            <Box sx={{ p: { xs: 2, md: 3 }, minWidth: 0, overflow: 'auto', minHeight: 0 }}>
              {!selectedApp ? (
                <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: '100%' }}>
                  <AppsIcon color="disabled" sx={{ fontSize: 44 }} />
                  <Typography variant="h6">{t('mcp.apps.select')}</Typography>
                  <Typography color="text.secondary" textAlign="center">
                    {t('mcp.apps.sandbox')}
                  </Typography>
                </Stack>
              ) : (
                <Box>
                  <Typography variant="h6">{t('mcp.apps.preview', { app: selectedApp.name })}</Typography>
                  {selectedApp.description && (
                    <Typography color="text.secondary" sx={{ mt: 0.5 }}>{selectedApp.description}</Typography>
                  )}
                  <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                    <Chip label={selectedApp.serverName} size="small" />
                    <Chip label={selectedApp.mimeType} size="small" variant="outlined" />
                  </Stack>

                  {selectedApp.toolNames.length > 0 && (
                    <Alert severity="info" sx={{ mt: 2 }}>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        {t('mcp.apps.linkedHelp')}
                      </Typography>
                      <Stack direction="row" gap={1} flexWrap="wrap">
                        {selectedApp.toolNames.map((toolName) => (
                          <Button
                            key={toolName}
                            size="small"
                            variant="outlined"
                            startIcon={<BuildIcon />}
                            onClick={() => onOpenToolTester(selectedApp.serverName, toolName)}
                          >
                            {t('mcp.apps.test', { tool: toolName })}
                          </Button>
                        ))}
                      </Stack>
                    </Alert>
                  )}

                  <McpAppFrame
                    key={appKey(selectedApp.serverName, selectedApp.uri)}
                    defaultExpanded
                    serverName={selectedApp.serverName}
                    uri={selectedApp.uri}
                  />
                </Box>
              )}
            </Box>
          </Box>
        )}
      </DialogContent>

      <Divider />
      <DialogActions>
        <Button onClick={onClose}>{t('mcp.apps.close')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default McpAppsDashboard;
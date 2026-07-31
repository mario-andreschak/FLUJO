'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AppsIcon from '@mui/icons-material/Apps';
import BuildIcon from '@mui/icons-material/Build';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import {
  extractUiResourceUri,
  isMcpAppMimeType,
  isUiResourceUri,
} from '@/shared/utils/mcpApps';

interface McpAppsDashboardProps {
  open: boolean;
  onClose: () => void;
  onOpenToolTester: (serverName: string, toolName: string) => void;
}

interface DashboardApp {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  toolNames: string[];
}

interface ServerDiscovery {
  name: string;
  apps: DashboardApp[];
  error?: string;
}

const appKey = (serverName: string, uri: string) => `${serverName}\u0000${uri}`;

const readableError = (error: unknown, fallback: string): string => {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
};

/**
 * Discover and launch standalone MCP App resources without weakening the
 * existing McpAppFrame authorization, validation, or sandbox boundary.
 */
const McpAppsDashboard: React.FC<McpAppsDashboardProps> = ({
  open,
  onClose,
  onOpenToolTester,
}) => {
  const [servers, setServers] = useState<ServerDiscovery[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const discover = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    setSelectedKey(null);
    setLoadError(null);
    if (refresh) setRefreshing(true);
    else setLoading(true);

    try {
      const configsResult = await mcpService.loadServerConfigs();
      if (requestId !== requestIdRef.current) return;
      if (!Array.isArray(configsResult)) {
        setServers([]);
        setLoadError(readableError(
          (configsResult as { error?: unknown } | null)?.error,
          'Failed to load MCP server configurations.',
        ));
        return;
      }

      const eligible = (configsResult as MCPServerConfig[]).filter((server) => (
        server.disabled !== true && server.enableMcpApps === true
      ));

      const discoveries = await Promise.all(eligible.map(async (server): Promise<ServerDiscovery> => {
        if (refresh) {
          mcpService.clearCapabilitiesCache(server.name);
          mcpService.clearToolsCache(server.name);
        }

        const [resourceResult, toolResult] = await Promise.all([
          mcpService.listServerResources(server.name),
          mcpService.listServerTools(server.name),
        ]);
        if (resourceResult?.error) {
          return {
            name: server.name,
            apps: [],
            error: readableError(resourceResult.error, 'Resource discovery is unavailable.'),
          };
        }

        const toolsByResource = new Map<string, string[]>();
        for (const tool of Array.isArray(toolResult?.tools) ? toolResult.tools : []) {
          const uri = extractUiResourceUri(tool?._meta);
          if (!uri || typeof tool?.name !== 'string' || !tool.name.trim()) continue;
          toolsByResource.set(uri, [...(toolsByResource.get(uri) || []), tool.name]);
        }

        const apps: DashboardApp[] = [];
        for (const resource of Array.isArray(resourceResult?.resources) ? resourceResult.resources : []) {
          if (!isUiResourceUri(resource?.uri) || !isMcpAppMimeType(resource?.mimeType)) continue;
          const title = typeof resource.title === 'string' && resource.title.trim()
            ? resource.title.trim()
            : typeof resource.name === 'string' && resource.name.trim()
              ? resource.name.trim()
              : resource.uri;
          apps.push({
            serverName: server.name,
            uri: resource.uri,
            name: title,
            description: typeof resource.description === 'string' && resource.description.trim()
              ? resource.description.trim()
              : undefined,
            mimeType: resource.mimeType,
            toolNames: toolsByResource.get(resource.uri) || [],
          });
        }

        return {
          name: server.name,
          apps,
        };
      }));

      if (requestId === requestIdRef.current) setServers(discoveries);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setServers([]);
        setLoadError(readableError(error, 'Failed to discover MCP Apps.'));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setSelectedKey(null);
      return;
    }
    void discover(false);
  }, [discover, open]);

  useEffect(() => {
    if (!open) return;
    const onServerConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        serverName?: string;
        config?: { enableMcpApps?: boolean; disabled?: boolean };
      }>).detail;
      if (!detail?.serverName) return;

      const selectedServer = servers.find((server) => (
        selectedKey?.startsWith(`${server.name}\u0000`)
      ));
      const accessLost = detail.config?.disabled === true
        || detail.config?.enableMcpApps === false;
      if (selectedServer?.name === detail.serverName && accessLost) setSelectedKey(null);
      mcpService.clearCapabilitiesCache(detail.serverName);
      mcpService.clearToolsCache(detail.serverName);
      void discover(true);
    };
    window.addEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
    return () => window.removeEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
  }, [discover, open, selectedKey, servers]);

  const allApps = useMemo(() => servers.flatMap((server) => server.apps), [servers]);
  const selectedApp = useMemo(
    () => allApps.find((app) => appKey(app.serverName, app.uri) === selectedKey),
    [allApps, selectedKey],
  );
  const discoveryErrors = servers.filter((server) => server.error);
  const eligibleServerCount = servers.length;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xl" aria-labelledby="mcp-apps-dashboard-title">
      <DialogTitle id="mcp-apps-dashboard-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AppsIcon color="primary" />
        MCP Apps Dashboard
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh apps">
          <span>
            <IconButton
              aria-label="Refresh apps"
              onClick={() => void discover(true)}
              disabled={loading || refreshing}
              size="small"
            >
              {refreshing ? <CircularProgress size={20} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <IconButton aria-label="Close MCP Apps Dashboard" onClick={onClose} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <Divider />

      <DialogContent sx={{ p: 0, minHeight: { xs: 480, md: 620 } }}>
        {loading ? (
          <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ minHeight: 420 }}>
            <CircularProgress />
            <Typography color="text.secondary">Discovering MCP Apps…</Typography>
          </Stack>
        ) : loadError ? (
          <Alert severity="error" sx={{ m: 3 }}>{loadError}</Alert>
        ) : eligibleServerCount === 0 ? (
          <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 420, p: 3 }}>
            <AppsIcon color="disabled" sx={{ fontSize: 48 }} />
            <Typography variant="h6">No MCP Apps-capable servers are enabled</Typography>
            <Typography color="text.secondary" textAlign="center">
              Enable a server and opt in to MCP Apps from its configuration to discover interactive resources.
            </Typography>
          </Stack>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(300px, 38%) 1fr' }, minHeight: 620 }}>
            <Box sx={{ borderRight: { md: '1px solid' }, borderColor: { md: 'divider' }, p: 2, overflow: 'auto' }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                {allApps.length} {allApps.length === 1 ? 'app' : 'apps'} from {eligibleServerCount} {eligibleServerCount === 1 ? 'server' : 'servers'}
              </Typography>

              {servers.map((server) => (
                <Box key={server.name} sx={{ mb: 2.5 }}>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                    {server.name}
                  </Typography>
                  {server.error ? (
                    <Alert severity="warning">
                      <Typography variant="body2" fontWeight={600}>Unavailable or disconnected</Typography>
                      <Typography variant="body2">{server.error}</Typography>
                    </Alert>
                  ) : server.apps.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No eligible apps discovered for this server.
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
                                  <Chip icon={<BuildIcon />} label={`${app.toolNames.length} linked tool${app.toolNames.length === 1 ? '' : 's'}`} size="small" sx={{ mt: 1 }} />
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
                <Alert severity="info">No eligible MCP App resources were discovered.</Alert>
              )}
            </Box>

            <Box sx={{ p: { xs: 2, md: 3 }, minWidth: 0, overflow: 'auto' }}>
              {!selectedApp ? (
                <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 360 }}>
                  <AppsIcon color="disabled" sx={{ fontSize: 44 }} />
                  <Typography variant="h6">Select an app to preview</Typography>
                  <Typography color="text.secondary" textAlign="center">
                    Apps run through FLUJO&apos;s existing isolated MCP App sandbox.
                  </Typography>
                </Stack>
              ) : (
                <Box>
                  <Typography variant="h6">{selectedApp.name}</Typography>
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
                        This app is linked to a tool. Use Tool Tester when it needs invocation arguments or a tool result.
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
                            Test {toolName}
                          </Button>
                        ))}
                      </Stack>
                    </Alert>
                  )}

                  <McpAppFrame
                    key={appKey(selectedApp.serverName, selectedApp.uri)}
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
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default McpAppsDashboard;

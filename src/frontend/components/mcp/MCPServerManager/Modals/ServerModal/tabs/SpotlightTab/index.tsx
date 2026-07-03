'use client';

import React, { useEffect, useState } from 'react';
import { TabProps, MessageState } from '../../types';
import {
  SpotlightCache,
  RegistryServer,
  InstallOption,
  getInstallOptions,
  buildConfigFromOption,
  displayName
} from '@/utils/mcp/registry';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import { useTheme } from '@mui/material/styles';
import {
  Alert,
  Avatar,
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
  Grid,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import TerminalIcon from '@mui/icons-material/Terminal';
import CloudIcon from '@mui/icons-material/Cloud';
import StarIcon from '@mui/icons-material/Star';

/**
 * Spotlight: FLUJO's curated MCP servers. The list ships with FLUJO
 * (src/shared/config/spotlightServers.ts); the registry records are cached on
 * the backend (refreshed at startup or via the Refresh button — never on tab
 * open). Installation is one click: the config is built from the registry
 * record and added to the server list directly. Only when a server offers
 * both a local package and a remote endpoint is the user asked which to use.
 */
const SpotlightTab: React.FC<TabProps> = ({ onAdd, onClose }) => {
  const theme = useTheme();
  const [cache, setCache] = useState<SpotlightCache | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  // Server whose Local/Remote choice is pending
  const [choiceServer, setChoiceServer] = useState<RegistryServer | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/mcp-registry/spotlight');
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok || data.success === false) {
          throw new Error(data.error || `Request failed with status ${response.status}`);
        }
        setCache(data.cache ?? null);
      } catch (error) {
        if (!cancelled) {
          setMessage({
            type: 'error',
            text: `Could not load spotlight servers: ${error instanceof Error ? error.message : 'Unknown error'}`
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setMessage(null);
    try {
      const response = await fetch('/api/mcp-registry/spotlight', { method: 'POST' });
      const data = await response.json();
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Request failed with status ${response.status}`);
      }
      setCache(data.cache ?? null);
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const install = (server: RegistryServer, option: InstallOption) => {
    const config = buildConfigFromOption(server, option);
    setChoiceServer(null);
    // handleAddServer in the server manager saves the config and closes the
    // modal — the server appears as a card in the list immediately.
    onAdd(config as MCPServerConfig);
  };

  const handleServerClick = (server: RegistryServer) => {
    const options = getInstallOptions(server);
    if (options.length === 0) {
      setMessage({
        type: 'warning',
        text: `${displayName(server)} does not offer an installation method FLUJO can set up automatically.`
      });
      return;
    }
    const packageOptions = options.filter(o => o.kind === 'package');
    const remoteOptions = options.filter(o => o.kind === 'remote');
    if (packageOptions.length > 0 && remoteOptions.length > 0) {
      // The only decision Spotlight asks the user to make: local vs remote
      setChoiceServer(server);
      return;
    }
    install(server, options[0]);
  };

  const servers = (cache?.entries ?? [])
    .filter(entry => entry.result)
    .map(entry => entry.result!.server);
  const failures = (cache?.entries ?? []).filter(entry => !entry.result);

  const choiceOptions = choiceServer ? getInstallOptions(choiceServer) : [];
  const choicePackage = choiceOptions.find(o => o.kind === 'package');
  const choiceRemote = choiceOptions.find(o => o.kind === 'remote');

  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">Spotlight</Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={handleRefresh}
            disabled={isRefreshing}
            startIcon={isRefreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Box>

        <Typography variant="body2" color="text.secondary">
          Hand-picked MCP servers that work well with FLUJO — installed with a single click.
          {cache?.updatedAt && (
            <> Catalog updated {new Date(cache.updatedAt).toLocaleString()}.</>
          )}
        </Typography>

        {message && (
          <Alert severity={message.type} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
            <CircularProgress />
          </Box>
        ) : servers.length === 0 ? (
          <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center', my: 4 }}>
            No spotlight servers cached yet. They are fetched when FLUJO starts —
            click Refresh to fetch them now.
          </Typography>
        ) : (
          <Grid container spacing={2}>
            {servers.map(server => {
              const options = getInstallOptions(server);
              const hasLocal = options.some(o => o.kind === 'package');
              const hasRemote = options.some(o => o.kind === 'remote');
              return (
                <Grid item xs={12} sm={6} md={4} key={server.name}>
                  <Card
                    sx={{
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      transition: 'transform 0.2s, box-shadow 0.2s',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: 6
                      }
                    }}
                  >
                    <CardActionArea
                      sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
                      onClick={() => handleServerClick(server)}
                    >
                      <Box
                        sx={{
                          p: 2,
                          display: 'flex',
                          alignItems: 'center',
                          borderBottom: '1px solid',
                          borderColor: 'divider'
                        }}
                      >
                        <Avatar
                          sx={{
                            bgcolor: theme.palette.warning.main,
                            color: '#fff',
                            mr: 2,
                            boxShadow: 1
                          }}
                        >
                          <StarIcon fontSize="small" />
                        </Avatar>
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="subtitle1" component="div" noWrap title={displayName(server)}>
                            {displayName(server)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap component="div" title={server.name}>
                            {server.name}
                          </Typography>
                        </Box>
                      </Box>

                      <CardContent sx={{ flexGrow: 1, pt: 2, width: '100%' }}>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            mb: 2,
                            display: '-webkit-box',
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }}
                        >
                          {server.description || 'No description provided.'}
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                          {hasLocal && <Chip size="small" icon={<TerminalIcon />} label="Local" />}
                          {hasRemote && <Chip size="small" icon={<CloudIcon />} label="Remote" />}
                          {server.version && (
                            <Chip size="small" variant="outlined" label={`v${server.version}`} />
                          )}
                        </Box>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        )}

        {failures.length > 0 && !isLoading && (
          <Alert severity="warning">
            {failures.length} spotlight {failures.length === 1 ? 'entry' : 'entries'} could not be
            resolved against the MCP Registry:
            {failures.map(f => (
              <Typography key={f.url} variant="caption" component="div" sx={{ wordBreak: 'break-all' }}>
                {f.url} — {f.error || 'unknown error'}
              </Typography>
            ))}
          </Alert>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="outlined" onClick={onClose}>
            Cancel
          </Button>
        </Box>
      </Stack>

      {/* Local-vs-remote chooser — the single decision Spotlight leaves to the user */}
      <Dialog open={choiceServer !== null} onClose={() => setChoiceServer(null)} maxWidth="xs" fullWidth>
        {choiceServer && (
          <>
            <DialogTitle>{displayName(choiceServer)}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                This server can run locally on your machine or connect to a hosted endpoint.
              </Typography>
              <List>
                {choicePackage && (
                  <ListItemButton onClick={() => install(choiceServer, choicePackage)}>
                    <ListItemIcon>
                      <TerminalIcon />
                    </ListItemIcon>
                    <ListItemText primary="Local" secondary="Runs on your machine" />
                  </ListItemButton>
                )}
                {choiceRemote && (
                  <ListItemButton onClick={() => install(choiceServer, choiceRemote)}>
                    <ListItemIcon>
                      <CloudIcon />
                    </ListItemIcon>
                    <ListItemText primary="Remote" secondary="Connects to a hosted endpoint" />
                  </ListItemButton>
                )}
              </List>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setChoiceServer(null)}>Cancel</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
};

export default SpotlightTab;

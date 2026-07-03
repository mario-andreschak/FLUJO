'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TabProps, MessageState } from '../../types';
import {
  RegistryListResponse,
  RegistryServerResult,
  RegistryServer,
  InstallOption,
  getInstallOptions,
  buildConfigFromOption,
  displayName,
  missingRequiredInputs,
  registryTypeLabel
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
  IconButton,
  InputAdornment,
  Link,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import GitHubIcon from '@mui/icons-material/GitHub';
import LanguageIcon from '@mui/icons-material/Language';
import TerminalIcon from '@mui/icons-material/Terminal';
import CloudIcon from '@mui/icons-material/Cloud';
import ClearIcon from '@mui/icons-material/Clear';

const PAGE_SIZE = 30;

const MarketplaceTab: React.FC<TabProps> = ({
  onClose,
  setActiveTab,
  onUpdate,
  onOpenInGitHubTab
}) => {
  const theme = useTheme();
  const [searchInput, setSearchInput] = useState<string>('');
  // The term actually sent to the registry — only updated when the user commits
  // a search (Enter or the clear button), never while typing
  const [activeSearch, setActiveSearch] = useState<string>('');
  const [results, setResults] = useState<RegistryServerResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [selectedServer, setSelectedServer] = useState<RegistryServer | null>(null);
  // Monotonic id so stale fetch responses (rapid re-searches) can't clobber newer ones
  const fetchIdRef = useRef(0);

  const fetchServers = useCallback(async (search: string, cursor?: string) => {
    const fetchId = ++fetchIdRef.current;
    const isFirstPage = !cursor;
    if (isFirstPage) {
      setIsLoading(true);
    } else {
      setIsLoadingMore(true);
    }
    setMessage(null);

    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (search) params.set('search', search);
      if (cursor) params.set('cursor', cursor);

      const response = await fetch(`/api/mcp-registry?${params.toString()}`);
      const data: { success?: boolean; error?: string } & RegistryListResponse =
        await response.json();

      if (fetchId !== fetchIdRef.current) return; // superseded by a newer request

      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Request failed with status ${response.status}`);
      }

      const servers = data.servers ?? [];
      setResults(prev => (isFirstPage ? servers : [...prev, ...servers]));
      // The registry returns a nextCursor even on the last page when the page
      // is exactly full; an empty page just ends pagination gracefully.
      setNextCursor(servers.length > 0 ? data.metadata?.nextCursor ?? null : null);
    } catch (error) {
      if (fetchId !== fetchIdRef.current) return;
      console.error('Error fetching from MCP Registry:', error);
      setMessage({
        type: 'error',
        text: `Could not load servers from the MCP Registry: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      if (fetchId === fetchIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  // Initial load + committed searches (Enter / clear) — no search while typing
  useEffect(() => {
    fetchServers(activeSearch);
  }, [activeSearch, fetchServers]);

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
  };

  const handleInstall = (server: RegistryServer, option: InstallOption) => {
    const config = buildConfigFromOption(server, option);
    const missing = missingRequiredInputs(option);

    if (onUpdate) {
      // autoTestRun: registry configs need no manual install/build step, so the
      // local tab can start the test run (which performs the install) right away
      onUpdate(config as MCPServerConfig, { autoTestRun: true });
    }
    setSelectedServer(null);
    if (setActiveTab) {
      setActiveTab('local');
    }
    setMessage({
      type: missing.length > 0 ? 'warning' : 'success',
      text:
        missing.length > 0
          ? `Configuration prepared. Fill in the required value(s) before saving: ${missing.join(', ')}`
          : 'Configuration prepared. Review and save it in the Local Server tab.'
    });
  };

  // Repository URL if it points at github.com — the GitHub tab supports nothing else
  // (registry entries may also live on e.g. GitLab)
  const githubRepoUrl = (server: RegistryServer): string | null => {
    const url = server.repository?.url;
    if (!url) return null;
    try {
      return new URL(url).hostname === 'github.com' ? url : null;
    } catch {
      return null;
    }
  };

  // "Manual setup" fallback: hand the repository URL to the GitHub tab, where the
  // user can clone the repo and configure the server from there
  const handleManualInstall = (server: RegistryServer) => {
    const repoUrl = githubRepoUrl(server);
    if (!repoUrl || !onOpenInGitHubTab) return;
    setSelectedServer(null);
    onOpenInGitHubTab(repoUrl);
  };

  const handleServerClick = (server: RegistryServer) => {
    const options = getInstallOptions(server);
    if (options.length === 1) {
      handleInstall(server, options[0]);
    } else {
      // Zero or several options: open the dialog (it explains the zero case)
      setSelectedServer(server);
    }
  };

  const renderOptionChips = (server: RegistryServer) => {
    const chips: React.ReactNode[] = [];
    const seen = new Set<string>();
    for (const pkg of server.packages ?? []) {
      const label = registryTypeLabel(pkg.registryType);
      if (seen.has(label)) continue;
      seen.add(label);
      chips.push(<Chip key={`pkg-${label}`} size="small" icon={<TerminalIcon />} label={label} />);
    }
    if ((server.remotes ?? []).length > 0) {
      chips.push(<Chip key="remote" size="small" icon={<CloudIcon />} label="Remote" />);
    }
    return chips;
  };

  const selectedOptions = selectedServer ? getInstallOptions(selectedServer) : [];

  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={3}>
        <Typography variant="h6" gutterBottom>
          MCP Marketplace
        </Typography>

        <Typography variant="body2" color="text.secondary">
          Search the official{' '}
          <Link href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">
            MCP Registry
          </Link>{' '}
          and install servers with one click. Local packages run via npx, uvx or Docker;
          remote servers connect directly.
        </Typography>

        <TextField
          fullWidth
          size="small"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const term = searchInput.trim();
              if (term === activeSearch) {
                // Same term committed again — re-run it (e.g. retry after an error)
                fetchServers(term);
              } else {
                setActiveSearch(term);
              }
            }
          }}
          placeholder="Search servers by name and press Enter (e.g. github, filesystem, postgres)…"
          variant="outlined"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
            endAdornment: searchInput ? (
              <InputAdornment position="end">
                <IconButton size="small" onClick={handleClearSearch} aria-label="clear search">
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined
          }}
        />

        {message && (
          <Alert severity={message.type} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {results.length === 0 && !message && (
              <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center', my: 4 }}>
                No servers found{activeSearch ? ` for "${activeSearch}"` : ''}. The registry
                matches on server names — try a shorter term.
              </Typography>
            )}

            <Grid container spacing={2}>
              {results.map(result => {
                const server = result.server;
                const installable = getInstallOptions(server).length > 0;
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
                              bgcolor: theme.palette.primary.main,
                              color: '#fff',
                              mr: 2,
                              boxShadow: 1
                            }}
                          >
                            {displayName(server).charAt(0).toUpperCase()}
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
                            {renderOptionChips(server)}
                            {server.version && (
                              <Chip size="small" variant="outlined" label={`v${server.version}`} />
                            )}
                            {!installable && (
                              <Chip size="small" color="warning" variant="outlined" label="Manual setup" />
                            )}
                          </Box>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>

            {nextCursor && results.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <Button
                  variant="outlined"
                  onClick={() => fetchServers(activeSearch, nextCursor)}
                  disabled={isLoadingMore}
                  startIcon={isLoadingMore ? <CircularProgress size={20} color="inherit" /> : undefined}
                >
                  {isLoadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </Box>
            )}
          </>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="outlined" onClick={onClose}>
            Cancel
          </Button>
        </Box>
      </Stack>

      {/* Install-option chooser (also shown when nothing is installable) */}
      <Dialog open={selectedServer !== null} onClose={() => setSelectedServer(null)} maxWidth="sm" fullWidth>
        {selectedServer && (
          <>
            <DialogTitle>{displayName(selectedServer)}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {selectedServer.description || 'No description provided.'}
              </Typography>

              {selectedOptions.length > 0 ? (
                <>
                  <Typography variant="subtitle2" gutterBottom>
                    Choose how to install this server:
                  </Typography>
                  <List>
                    {selectedOptions.map((option, index) => {
                      const missing = missingRequiredInputs(option);
                      return (
                        <ListItemButton key={index} onClick={() => handleInstall(selectedServer, option)}>
                          <ListItemIcon>
                            {option.kind === 'package' ? <TerminalIcon /> : <CloudIcon />}
                          </ListItemIcon>
                          <ListItemText
                            primary={option.label}
                            secondary={
                              missing.length > 0
                                ? `Requires: ${missing.join(', ')}`
                                : option.kind === 'package'
                                  ? 'Runs locally'
                                  : 'Hosted remotely'
                            }
                            primaryTypographyProps={{ sx: { wordBreak: 'break-all' } }}
                          />
                        </ListItemButton>
                      );
                    })}
                  </List>
                </>
              ) : (
                <>
                  <Alert severity="info">
                    This server does not offer an installation method FLUJO can set up automatically.
                    Check its documentation for manual setup instructions.
                    {githubRepoUrl(selectedServer) && onOpenInGitHubTab && (
                      <> You can still try to clone it directly from GitHub, but additional steps
                      might still be required.</>
                    )}
                  </Alert>
                  {githubRepoUrl(selectedServer) && onOpenInGitHubTab && (
                    <Button
                      variant="contained"
                      startIcon={<GitHubIcon />}
                      onClick={() => handleManualInstall(selectedServer)}
                      sx={{ mt: 2 }}
                    >
                      Try manual installation
                    </Button>
                  )}
                </>
              )}

              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                {selectedServer.repository?.url && (
                  <Button
                    size="small"
                    startIcon={<GitHubIcon />}
                    component="a"
                    href={selectedServer.repository.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Repository
                  </Button>
                )}
                {selectedServer.websiteUrl && (
                  <Button
                    size="small"
                    startIcon={<LanguageIcon />}
                    component="a"
                    href={selectedServer.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Website
                  </Button>
                )}
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setSelectedServer(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
};

export default MarketplaceTab;

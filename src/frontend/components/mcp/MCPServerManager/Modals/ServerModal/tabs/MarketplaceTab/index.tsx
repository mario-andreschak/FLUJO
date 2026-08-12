'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TabProps, MessageState } from '../../types';
import {
  RegistryListResponse,
  RegistryServerResult,
  RegistryServer,
  InstallOption,
  ManualLaunchOption,
  getInstallOptions,
  isAutoInstallable,
  displayName,
  registryTypeLabel,
  verificationStatusOf,
  isVerifiedStatus,
  serverIconUrl
} from '@/utils/mcp/registry';
import { InstallOptionList } from '../../components/InstallOptionPicker';
import useRegistryInstall from '../../hooks/useRegistryInstall';
import {
  DEFAULT_MARKETPLACE_FILTERS,
  filterMarketplaceResults,
  hasActiveMarketplaceFilters,
  type MarketplaceSearchFilters,
} from './search';
import { useTheme } from '@mui/material/styles';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  InputLabel,
  Link,
  MenuItem,
  Select,
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import StarIcon from '@mui/icons-material/Star';
import DownloadIcon from '@mui/icons-material/Download';
import TuneIcon from '@mui/icons-material/Tune';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

const PAGE_SIZE = 30;

const MarketplaceTab: React.FC<TabProps> = ({
  onClose,
  onHandoff
}) => {
  const theme = useTheme();
  const { t, formatNumber, formatList } = useI18n();
  const [searchInput, setSearchInput] = useState<string>('');
  // The term actually sent to the registry — only updated when the user commits
  // a search (Enter or the clear button), never while typing
  const [activeSearch, setActiveSearch] = useState<string>('');
  const [results, setResults] = useState<RegistryServerResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [filters, setFilters] = useState<MarketplaceSearchFilters>(DEFAULT_MARKETPLACE_FILTERS);
  // The trust gate lives in the shared install pipeline: install actions stay
  // disabled until the user explicitly confirms they trust the server, and the
  // confirmation is reset every time the details dialog opens (#392).
  const registryInstall = useRegistryInstall({ requireTrust: true, onHandoff });
  const selectedServer = registryInstall.selection?.server ?? null;
  const trustConfirmed = registryInstall.trustConfirmed;
  // Monotonic id so stale fetch responses (rapid re-searches) can't clobber newer ones
  const fetchIdRef = useRef(0);
  const visibleResults = useMemo(
    () => filterMarketplaceResults(results, filters),
    [filters, results],
  );
  const filtersActive = hasActiveMarketplaceFilters(filters);

  const openServerDetails = useCallback((server: RegistryServer) => {
    registryInstall.open(server);
  }, [registryInstall]);

  const closeServerDetails = useCallback(() => {
    registryInstall.close();
  }, [registryInstall]);

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
        throw new Error(data.error || String(response.status));
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
        text: t('mcp.marketplace.loadError', { error: error instanceof Error ? error.message : t('mcp.server.unknownError') })
      });
    } finally {
      if (fetchId === fetchIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [t]);

  // Committed searches only (Enter) — nothing is fetched on mount or while typing,
  // so opening the tab issues no request to the registry
  useEffect(() => {
    if (activeSearch) {
      fetchServers(activeSearch);
    }
  }, [activeSearch, fetchServers]);

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
    // Empty the grid without a network request and invalidate any in-flight fetch
    fetchIdRef.current++;
    setIsLoading(false);
    setIsLoadingMore(false);
    setResults([]);
    setNextCursor(null);
    setMessage(null);
  };

  const handleSearch = () => {
    const term = searchInput.trim();
    if (!term) {
      handleClearSearch();
    } else if (term === activeSearch) {
      // Same term committed again — re-run it (e.g. retry after an error).
      fetchServers(term);
    } else {
      setActiveSearch(term);
    }
  };

  const updateFilter = <Key extends keyof MarketplaceSearchFilters>(
    key: Key,
    value: MarketplaceSearchFilters[Key],
  ) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const handleInstall = (server: RegistryServer, option: InstallOption) => {
    const missing = registryInstall.install(server, option);
    setMessage({
      type: missing.length > 0 ? 'warning' : 'success',
      text:
        missing.length > 0
          ? t('mcp.marketplace.preparedMissing', { values: formatList(missing) })
          : t('mcp.marketplace.prepared')
    });
  };

  // Launch-and-connect (#392): save it as an HTTP server carrying its launch
  // spec. No test run — nothing answers until the user starts the process.
  const handleConfigureAsRemote = (server: RegistryServer, option: ManualLaunchOption) => {
    registryInstall.configureAsRemote(server, option);
    setMessage({ type: 'success', text: t('mcp.marketplace.prepared') });
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
    if (!repoUrl || !onHandoff) return;
    closeServerDetails();
    onHandoff({ to: 'github', repoUrl });
  };

  // Every card click routes through the details/trust dialog — nothing installs
  // or switches tabs on click. Install happens only from an explicit action in
  // the dialog, after the trust checkbox is ticked.
  const handleServerClick = (server: RegistryServer) => {
    openServerDetails(server);
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
      chips.push(<Chip key="remote" size="small" icon={<CloudIcon />} label={t('mcp.marketplace.remote')} />);
    }
    return chips;
  };

  const selectedOptions = registryInstall.options;

  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={3}>
        <Typography variant="h6" gutterBottom>
          {t('mcp.marketplace.title')}
        </Typography>

        <Typography variant="body2" color="text.secondary">
          <Trans
            message="mcp.marketplace.help"
            values={{
              registryLink: (
                <Link href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">
                  {t('mcp.marketplace.registry')}
                </Link>
              ),
            }}
          />
        </Typography>

        <Box
          component="form"
          role="search"
          onSubmit={event => {
            event.preventDefault();
            handleSearch();
          }}
          sx={{ display: 'flex', gap: 1, alignItems: 'stretch' }}
        >
          <TextField
            fullWidth
            size="small"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder={t('mcp.marketplace.search')}
            variant="outlined"
            inputProps={{ 'aria-label': t('mcp.marketplace.searchLabel') }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
              endAdornment: searchInput ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={handleClearSearch} aria-label={t('mcp.marketplace.clearSearch')}>
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined
            }}
          />
          <Button
            type="submit"
            variant="contained"
            startIcon={<SearchIcon />}
            disabled={!searchInput.trim() || isLoading}
            sx={{ flexShrink: 0, px: { xs: 2, sm: 3 } }}
          >
            {t('mcp.marketplace.searchAction')}
          </Button>
        </Box>

        <Box
          aria-label={t('mcp.marketplace.filters')}
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr)) auto' },
            gap: 1,
            alignItems: 'center',
          }}
        >
          <FormControl size="small">
            <InputLabel id="marketplace-transport-filter-label">{t('mcp.marketplace.filterType')}</InputLabel>
            <Select
              labelId="marketplace-transport-filter-label"
              value={filters.transport}
              label={t('mcp.marketplace.filterType')}
              onChange={event => updateFilter('transport', event.target.value as MarketplaceSearchFilters['transport'])}
            >
              <MenuItem value="all">{t('mcp.marketplace.filterAnyType')}</MenuItem>
              <MenuItem value="local">{t('mcp.marketplace.filterLocal')}</MenuItem>
              <MenuItem value="remote">{t('mcp.marketplace.filterRemote')}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="marketplace-setup-filter-label">{t('mcp.marketplace.filterSetup')}</InputLabel>
            <Select
              labelId="marketplace-setup-filter-label"
              value={filters.setup}
              label={t('mcp.marketplace.filterSetup')}
              onChange={event => updateFilter('setup', event.target.value as MarketplaceSearchFilters['setup'])}
            >
              <MenuItem value="all">{t('mcp.marketplace.filterAnySetup')}</MenuItem>
              <MenuItem value="automatic">{t('mcp.marketplace.filterAutomatic')}</MenuItem>
              <MenuItem value="manual">{t('mcp.marketplace.filterManual')}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="marketplace-verification-filter-label">{t('mcp.marketplace.filterTrust')}</InputLabel>
            <Select
              labelId="marketplace-verification-filter-label"
              value={filters.verification}
              label={t('mcp.marketplace.filterTrust')}
              onChange={event => updateFilter('verification', event.target.value as MarketplaceSearchFilters['verification'])}
            >
              <MenuItem value="all">{t('mcp.marketplace.filterAnyTrust')}</MenuItem>
              <MenuItem value="verified">{t('mcp.marketplace.filterVerified')}</MenuItem>
              <MenuItem value="unverified">{t('mcp.marketplace.unverified')}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="marketplace-sort-label">{t('mcp.marketplace.sort')}</InputLabel>
            <Select
              labelId="marketplace-sort-label"
              value={filters.sort}
              label={t('mcp.marketplace.sort')}
              onChange={event => updateFilter('sort', event.target.value as MarketplaceSearchFilters['sort'])}
            >
              <MenuItem value="relevance">{t('mcp.marketplace.sortRelevance')}</MenuItem>
              <MenuItem value="stars">{t('mcp.marketplace.sortStars')}</MenuItem>
              <MenuItem value="downloads">{t('mcp.marketplace.sortDownloads')}</MenuItem>
              <MenuItem value="name">{t('mcp.marketplace.sortName')}</MenuItem>
            </Select>
          </FormControl>
          <Button
            size="small"
            startIcon={<TuneIcon />}
            disabled={!filtersActive}
            onClick={() => setFilters(DEFAULT_MARKETPLACE_FILTERS)}
            sx={{ whiteSpace: 'nowrap', justifySelf: { xs: 'start', md: 'stretch' } }}
          >
            {t('mcp.marketplace.resetFilters')}
          </Button>
        </Box>

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
            {results.length > 0 && (
              <Typography variant="caption" color="text.secondary" aria-live="polite">
                {t('mcp.marketplace.resultCount', { shown: visibleResults.length, loaded: results.length })}
              </Typography>
            )}

            {visibleResults.length === 0 && !message && (
              <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center', my: 4 }}>
                {results.length > 0 && filtersActive ? (
                  <>{t('mcp.marketplace.noFilteredResults')}</>
                ) : activeSearch ? (
                  <>{t('mcp.marketplace.noResults', { search: activeSearch })}</>
                ) : (
                  <>{t('mcp.marketplace.startSearch')}</>
                )}
              </Typography>
            )}

            <Grid container spacing={2}>
              {visibleResults.map(result => {
                const server = result.server;
                // Launch-and-connect entries are visible but not one-click
                // installable, so they still read as "manual setup".
                const installable = getInstallOptions(server).some(isAutoInstallable);
                const verified = isVerifiedStatus(verificationStatusOf(result));
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
                            src={serverIconUrl(server, theme.palette.mode) ?? undefined}
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
                            {server.description || t('mcp.spotlight.noDescription')}
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                            {typeof result.quality?.stars === 'number' && (
                              <Chip
                                size="small"
                                variant="outlined"
                                icon={<StarIcon />}
                                label={formatNumber(result.quality.stars, { notation: 'compact', maximumFractionDigits: 1 })}
                                title={t('mcp.marketplace.stars', { count: formatNumber(result.quality.stars) })}
                              />
                            )}
                            {typeof result.quality?.weeklyDownloads === 'number' && (
                              <Chip
                                size="small"
                                variant="outlined"
                                icon={<DownloadIcon />}
                                label={t('mcp.marketplace.weeklyCompact', { count: formatNumber(result.quality.weeklyDownloads, { notation: 'compact', maximumFractionDigits: 1 }) })}
                                title={t('mcp.marketplace.weeklyDownloads', { count: formatNumber(result.quality.weeklyDownloads) })}
                              />
                            )}
                            {renderOptionChips(server)}
                            {server.version && (
                              <Chip size="small" variant="outlined" label={`v${server.version}`} />
                            )}
                            {!installable && (
                              <Chip size="small" color="warning" variant="outlined" label={t('mcp.marketplace.manualSetup')} />
                            )}
                            {installable && !verified && (
                              <Chip
                                size="small"
                                color="warning"
                                variant="outlined"
                                icon={<WarningAmberIcon />}
                                label={t('mcp.marketplace.unverified')}
                                title={t('mcp.marketplace.unverifiedHelp')}
                              />
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
                  {isLoadingMore ? t('mcp.marketplace.loading') : t('mcp.marketplace.loadMore')}
                </Button>
              </Box>
            )}
          </>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="outlined" onClick={onClose}>
            {t('mcp.local.cancel')}
          </Button>
        </Box>
      </Stack>

      {/* Details + trust gate — every card click lands here first. Install
          happens only from an explicit action, and only once the user confirms
          they trust the server. */}
      <Dialog open={selectedServer !== null} onClose={closeServerDetails} maxWidth="sm" fullWidth>
        {selectedServer && (
          <>
            <DialogTitle component="div">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                <Avatar
                  src={serverIconUrl(selectedServer, theme.palette.mode) ?? undefined}
                  sx={{ bgcolor: theme.palette.primary.main, color: '#fff', width: 40, height: 40 }}
                >
                  {displayName(selectedServer).charAt(0).toUpperCase()}
                </Avatar>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h6" noWrap title={displayName(selectedServer)}>
                    {displayName(selectedServer)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="div" title={selectedServer.name}>
                    {selectedServer.name}
                  </Typography>
                </Box>
              </Box>
            </DialogTitle>
            <DialogContent>
              {/* Repository / website links, prominent near the top */}
              {(selectedServer.repository?.url || selectedServer.websiteUrl) && (
                <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
                  {selectedServer.repository?.url && (
                    <Button
                      size="small"
                      startIcon={<GitHubIcon />}
                      component="a"
                      href={selectedServer.repository.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('mcp.marketplace.repository')}
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
                      {t('mcp.marketplace.website')}
                    </Button>
                  )}
                </Box>
              )}

              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {selectedServer.description || t('mcp.spotlight.noDescription')}
              </Typography>

              {/* Persistent security warning + explicit trust confirmation */}
              <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 1 }}>
                {t('mcp.marketplace.securityWarning')}
              </Alert>
              <FormControlLabel
                sx={{ mb: 1 }}
                control={
                  <Checkbox
                    checked={trustConfirmed}
                    onChange={e => registryInstall.setTrustConfirmed(e.target.checked)}
                  />
                }
                label={t('mcp.marketplace.trust')}
              />

              {selectedOptions.length > 0 ? (
                <>
                  <Typography variant="subtitle2" gutterBottom>
                    {t('mcp.marketplace.chooseInstall')}
                  </Typography>
                  <InstallOptionList
                    options={selectedOptions}
                    disabled={registryInstall.installBlocked}
                    onSelect={option => handleInstall(selectedServer, option)}
                    onConfigureAsRemote={option => handleConfigureAsRemote(selectedServer, option)}
                  />
                </>
              ) : (
                <>
                  <Alert severity="info">
                    {t('mcp.marketplace.noAutomatic')}
                    {githubRepoUrl(selectedServer) && onHandoff && (
                      <> {t('mcp.marketplace.githubFallback')}</>
                    )}
                  </Alert>
                  {githubRepoUrl(selectedServer) && onHandoff && (
                    <Button
                      variant="contained"
                      startIcon={<GitHubIcon />}
                      disabled={!trustConfirmed}
                      onClick={() => handleManualInstall(selectedServer)}
                      sx={{ mt: 2 }}
                    >
                      {t('mcp.marketplace.tryManual')}
                    </Button>
                  )}
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={closeServerDetails}>{t('mcp.marketplace.close')}</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
};

export default MarketplaceTab;

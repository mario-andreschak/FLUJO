'use client';

import React, { useEffect, useState } from 'react';
import { TabProps, MessageState } from '../../types';
import {
  SpotlightCache,
  RegistryServer,
  InstallOption,
  ManualLaunchOption,
  getInstallOptions,
  isAutoInstallable,
  displayName
} from '@/utils/mcp/registry';
import InstallOptionPicker from '../../components/InstallOptionPicker';
import useRegistryInstall from '../../hooks/useRegistryInstall';
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
  Grid,
  Stack,
  Typography
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import TerminalIcon from '@mui/icons-material/Terminal';
import CloudIcon from '@mui/icons-material/Cloud';
import StarIcon from '@mui/icons-material/Star';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** A resolved curated server plus its shipped env-var defaults. */
interface SpotlightCard {
  server: RegistryServer;
  env?: Record<string, string>;
}

/**
 * Spotlight: FLUJO's curated MCP servers. The list ships with FLUJO
 * (src/shared/config/spotlightServers.ts); the registry records are cached on
 * the backend (refreshed at startup or via the Refresh button — never on tab
 * open). Clicking a server hands the generated config to the Configure & Test
 * tab — the same flow as the Marketplace (they share `useRegistryInstall` and
 * `InstallOptionPicker`, #392): the define/build sections arrive completed and
 * a test run starts automatically, so the user can review env vars and console
 * output before saving. The picker only appears when there is an actual choice
 * to make. Curated env defaults from the spotlight list are merged into the
 * generated config at handoff time, and count as provided values when warning
 * about missing required inputs.
 */
const SpotlightTab: React.FC<TabProps> = ({ onClose, onHandoff }) => {
  const theme = useTheme();
  const { t, tp, formatDate, formatList } = useI18n();
  const [cache, setCache] = useState<SpotlightCache | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  // Spotlight entries are curated and ship with FLUJO, so no trust gate.
  const registryInstall = useRegistryInstall({ requireTrust: false, onHandoff });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/mcp-registry/spotlight');
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok || data.success === false) {
          throw new Error(data.error || String(response.status));
        }
        setCache(data.cache ?? null);
      } catch (error) {
        if (!cancelled) {
          setMessage({
            type: 'error',
            text: t('mcp.spotlight.loadError', { error: error instanceof Error ? error.message : t('mcp.server.unknownError') })
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setMessage(null);
    try {
      const response = await fetch('/api/mcp-registry/spotlight', { method: 'POST' });
      const data = await response.json();
      if (!response.ok || data.success === false) {
        throw new Error(data.error || String(response.status));
      }
      setCache(data.cache ?? null);
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('mcp.spotlight.refreshError', { error: error instanceof Error ? error.message : t('mcp.server.unknownError') })
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  // Curated env defaults from the spotlight list are merged on top of the
  // registry record (adding vars the record didn't declare, filling the default
  // of ones it did) — editable in the Configure tab's Env editor before saving.
  const install = (card: SpotlightCard, option: InstallOption) => {
    const missing = registryInstall.install(card.server, option, card.env);
    if (missing.length > 0) {
      setMessage({
        type: 'warning',
        text: t('mcp.marketplace.preparedMissing', { values: formatList(missing) })
      });
    }
  };

  const configureAsRemote = (card: SpotlightCard, option: ManualLaunchOption) => {
    registryInstall.configureAsRemote(card.server, option, card.env);
  };

  const handleServerClick = (card: SpotlightCard) => {
    const options = registryInstall.open(card.server, card.env);
    if (options.length === 0) {
      registryInstall.close();
      setMessage({
        type: 'warning',
        text: t('mcp.spotlight.noInstall', { server: displayName(card.server) })
      });
      return;
    }
    // Only ask when there is an actual decision to make (local vs remote, or a
    // launch-and-connect entry the user has to start themselves).
    if (options.length === 1 && isAutoInstallable(options[0])) {
      install(card, options[0]);
    }
  };

  const cards: SpotlightCard[] = (cache?.entries ?? [])
    .filter(entry => entry.result)
    .map(entry => ({ server: entry.result!.server, env: entry.env }));
  const failures = (cache?.entries ?? []).filter(entry => !entry.result);

  const choiceCard: SpotlightCard | null = registryInstall.selection
    ? {
        server: registryInstall.selection.server,
        ...(registryInstall.selection.envDefaults ? { env: registryInstall.selection.envDefaults } : {})
      }
    : null;

  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">{t('mcp.spotlight.title')}</Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={handleRefresh}
            disabled={isRefreshing}
            startIcon={isRefreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
          >
            {isRefreshing ? t('mcp.spotlight.refreshing') : t('mcp.spotlight.refresh')}
          </Button>
        </Box>

        <Typography variant="body2" color="text.secondary">
          {t('mcp.spotlight.help')}
          {cache?.updatedAt && (
            <> {t('mcp.spotlight.updated', { date: formatDate(cache.updatedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</>
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
        ) : cards.length === 0 ? (
          <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center', my: 4 }}>
            {t('mcp.spotlight.empty')}
          </Typography>
        ) : (
          <Grid container spacing={2}>
            {cards.map(card => {
              const { server } = card;
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
                      onClick={() => handleServerClick(card)}
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
                          {server.description || t('mcp.spotlight.noDescription')}
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                          {hasLocal && <Chip size="small" icon={<TerminalIcon />} label={t('mcp.spotlight.local')} />}
                          {hasRemote && <Chip size="small" icon={<CloudIcon />} label={t('mcp.spotlight.remote')} />}
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
            {tp('mcp.spotlight.failures', failures.length)}
            {failures.map(f => (
              <Typography key={f.url} variant="caption" component="div" sx={{ wordBreak: 'break-all' }}>
                {f.url} — {f.error || t('mcp.server.unknownError')}
              </Typography>
            ))}
          </Alert>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="outlined" onClick={onClose}>
            {t('mcp.local.cancel')}
          </Button>
        </Box>
      </Stack>

      {/* Shared option picker — local vs remote, plus any launch-and-connect entry */}
      {choiceCard && (
        <InstallOptionPicker
          open
          title={displayName(choiceCard.server)}
          helpText={t('mcp.spotlight.chooseHelp')}
          options={registryInstall.options}
          {...(choiceCard.env ? { envDefaults: choiceCard.env } : {})}
          onClose={registryInstall.close}
          onSelect={option => install(choiceCard, option)}
          onConfigureAsRemote={option => configureAsRemote(choiceCard, option)}
        />
      )}
    </Box>
  );
};

export default SpotlightTab;

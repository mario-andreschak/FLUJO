'use client';

/**
 * Chain Chat — a read-only, root-centred view of one conversation family.
 *
 * The initial request stays deliberately small (topology + one latest-message
 * preview per conversation). A full transcript is fetched only when its chat
 * bubble is expanded, and opening the conversation still uses the canonical
 * Chat magic link.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import { alpha, useTheme } from '@mui/material/styles';
import { useRouter } from 'next/navigation';
import PageHeader from '@/frontend/components/shared/PageHeader';
import { chatService } from '@/frontend/services/chat';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import type { ConversationChainsResponse } from '@/shared/types/conversationChain';
import { createLogger } from '@/utils/logger';
import ChainFlowTree from './ChainFlowTree';

const log = createLogger('frontend/components/ConversationChainGraph');

type LoadState = 'loading' | 'ready' | 'error';

function ChainTreeSkeleton() {
  const { t } = useI18n();
  return (
    <Box aria-busy="true" aria-label={t('chainChat.loading')} sx={{ minHeight: 420, pt: 4 }}>
      <Stack alignItems="center" spacing={5}>
        <Stack direction="row" spacing={1.4} alignItems="center">
          <Skeleton variant="rounded" width={148} height={84} sx={{ borderRadius: 4 }} />
          <Skeleton variant="rounded" width={216} height={84} sx={{ borderRadius: 4 }} />
        </Stack>
        <Box sx={{ width: 1, height: 30, bgcolor: 'divider' }} />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
          {[0, 1].map((item) => (
            <Stack key={item} direction="row" spacing={1.4} alignItems="center">
              <Skeleton variant="rounded" width={148} height={82} sx={{ borderRadius: 3 }} />
              <Skeleton variant="rounded" width={216} height={82} sx={{ borderRadius: 4 }} />
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}

export function ConversationChainGraph() {
  const { t } = useI18n();
  const router = useRouter();
  const theme = useTheme();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isCompact = useMediaQuery(theme.breakpoints.down('sm'));

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<ConversationChainsResponse | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const liveRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setState('loading');

    chatService
      .getConversationChains({ signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setData(response);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
        log.warn('Failed to load conversation chains', error);
        setState('error');
      });

    return () => controller.abort();
  }, [reloadToken]);

  // Keep the map honest while work starts, pauses, branches, or completes.
  // The global sidebar stream is intentionally low-volume; debounce bursts so
  // a fan-out produces one refreshed projection rather than one per lane.
  useEffect(() => {
    if (typeof chatService.subscribeToSidebarEvents !== 'function') return;
    const stream = chatService.subscribeToSidebarEvents({
      onEvent: () => {
        if (liveRefreshTimerRef.current !== null) window.clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = window.setTimeout(() => {
          setReloadToken((token) => token + 1);
          liveRefreshTimerRef.current = null;
        }, 450);
      },
    });
    return () => {
      if (liveRefreshTimerRef.current !== null) window.clearTimeout(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = null;
      stream.close();
    };
  }, []);

  const chains = useMemo(() => data?.chains ?? [], [data]);

  useEffect(() => {
    if (chains.length === 0) {
      if (selectedRootId !== null) setSelectedRootId(null);
      return;
    }
    if (!selectedRootId || !chains.some((chain) => chain.rootId === selectedRootId)) {
      setSelectedRootId(chains[0].rootId);
    }
  }, [chains, selectedRootId]);

  const selectedChain = useMemo(
    () => chains.find((chain) => chain.rootId === selectedRootId) ?? chains[0] ?? null,
    [chains, selectedRootId],
  );

  // Sidebar lifecycle events intentionally omit message/tool payload events.
  // While the selected family is live, refresh just that bounded family so its
  // latest-message bubbles actually move with the run without re-reading every
  // recent chain or opening a high-volume event stream in the browser.
  useEffect(() => {
    if (!selectedChain || selectedChain.activeNodeCount === 0) return;

    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const rootId = selectedChain.rootId;

    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await chatService.getConversationChains({
          rootId,
          limit: 1,
          signal: controller.signal,
        });
        if (disposed || controller.signal.aborted) return;
        const refreshed = response.chains.find((chain) => chain.rootId === rootId);
        if (refreshed) {
          setData((current) => current ? {
            ...current,
            chains: current.chains.map((chain) => chain.rootId === rootId ? refreshed : chain),
            generatedAt: response.generatedAt,
          } : current);
        }
      } catch (error) {
        if (!disposed && (error as { name?: string })?.name !== 'AbortError') {
          log.debug('Selected chain live refresh skipped', error);
        }
      } finally {
        controller = null;
        if (!disposed) timer = window.setTimeout(poll, 3200);
      }
    };

    timer = window.setTimeout(poll, 2200);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [selectedChain?.activeNodeCount, selectedChain?.rootId]);

  const openConversation = useCallback(
    (conversationId: string) => {
      if (!conversationId) return;
      router.push(magicLinkPath({ kind: 'conversation', id: conversationId }));
    },
    [router],
  );

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const actions = (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: { xs: '100%', sm: 'auto' } }}>
      {chains.length > 1 && (
        <TextField
          select
          size="small"
          label={t('chainChat.chainLabel')}
          value={selectedChain?.rootId ?? ''}
          onChange={(event) => setSelectedRootId(event.target.value)}
          sx={{
            minWidth: { xs: 0, sm: 230 },
            flex: { xs: 1, sm: '0 0 auto' },
            '& .MuiOutlinedInput-root': {
              bgcolor: alpha(theme.palette.background.paper, 0.66),
              backdropFilter: 'blur(12px)',
            },
          }}
        >
          {chains.map((chain) => (
            <MenuItem key={chain.rootId} value={chain.rootId}>
              {`${chain.title || t('chainChat.untitled')} · ${t('chainChat.activeCount', {
                count: chain.activeNodeCount,
              })}`}
            </MenuItem>
          ))}
        </TextField>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<RefreshRoundedIcon sx={{ animation: state === 'loading' && data && !reducedMotion ? 'chainRefreshSpin 900ms linear infinite' : 'none' }} />}
        onClick={refresh}
        disabled={state === 'loading'}
        sx={{
          flexShrink: 0,
          '@keyframes chainRefreshSpin': { to: { transform: 'rotate(360deg)' } },
        }}
      >
        {t('chainChat.refresh')}
      </Button>
    </Stack>
  );

  let body: React.ReactNode;

  if (state === 'loading' && !data) {
    body = <ChainTreeSkeleton />;
  } else if (state === 'error') {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={refresh}>
            {t('chainChat.retry')}
          </Button>
        }
        sx={{ m: { xs: 2, md: 3 } }}
      >
        <AlertTitle>{t('chainChat.errorTitle')}</AlertTitle>
      </Alert>
    );
  } else if (!selectedChain || selectedChain.nodes.length === 0) {
    body = (
      <Paper
        variant="outlined"
        sx={{
          m: { xs: 2, md: 3 },
          p: 5,
          textAlign: 'center',
          borderRadius: 4,
          background: `linear-gradient(145deg, ${alpha(theme.palette.primary.main, 0.055)}, ${alpha(theme.palette.background.paper, 0.86)})`,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
          {t('chainChat.emptyTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('chainChat.emptyBody')}
        </Typography>
      </Paper>
    );
  } else {
    body = (
      <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', overflow: 'hidden', px: { xs: 1, sm: 2.5 }, py: 2 }}>
        {(data?.truncated || selectedChain.truncated) && (
          <Stack spacing={1} sx={{ mx: 'auto', mb: 1.5, width: 'min(100%, 920px)' }}>
            {data?.truncated && (
              <Alert severity="info" variant="outlined">
                {t('chainChat.truncatedChains', { count: chains.length })}
              </Alert>
            )}
            {selectedChain.truncated && (
              <Alert severity="warning" variant="outlined">
                {t('chainChat.truncatedNodes', { count: selectedChain.nodes.length })}
              </Alert>
            )}
          </Stack>
        )}

        <Stack
          direction="row"
          spacing={0.8}
          alignItems="center"
          justifyContent="center"
          sx={{ mb: 0.5, color: 'text.secondary' }}
        >
          <Chip
            size="small"
            variant="outlined"
            label={t('chainChat.conversationCount', { count: selectedChain.nodes.length })}
            sx={{ height: 24, color: 'text.secondary', bgcolor: alpha(theme.palette.background.paper, 0.45) }}
          />
          {selectedChain.activeNodeCount > 0 && (
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label={t('chainChat.activeCount', { count: selectedChain.activeNodeCount })}
              sx={{ height: 24, bgcolor: alpha(theme.palette.primary.main, 0.055) }}
            />
          )}
        </Stack>

        <ChainFlowTree
          key={selectedChain.rootId}
          rootId={selectedChain.rootId}
          nodes={selectedChain.nodes}
          onOpenConversation={openConversation}
          reducedMotion={reducedMotion}
          compact={isCompact}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        titleKey="chainChat.title"
        descriptionKey="chainChat.subtitle"
        eyebrowKey="chainChat.eyebrow"
        icon={AccountTreeRoundedIcon}
        badge={<Chip size="small" color="secondary" variant="outlined" label={t('chainChat.experimental')} sx={{ height: 20, fontSize: '0.64rem' }} />}
        actions={actions}
        compact
        maxWidth="none"
      />
      {body}
    </Box>
  );
}

export default ConversationChainGraph;

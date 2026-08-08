'use client';

/**
 * Chain Chat (issue #405) — experimental, read-only.
 *
 * Fetches the bounded chain projection (`GET /v1/chat/conversation-chains`),
 * lets the user pick one chain, and renders it as an animated graph whose
 * bubbles deep-link into `/chat?conversation=<id>` — the SAME canonical magic
 * link the sidebar, navbar and message links already use, so selection
 * behaviour never diverges and Back/Forward keeps working.
 *
 * The container owns fetching/selection only; graph adaptation is a pure
 * shared util and rendering lives in ChainGraphCanvas, so each layer is
 * testable on its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  ButtonBase,
  Chip,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import { useTheme } from '@mui/material/styles';
import { useRouter } from 'next/navigation';
import { chatService } from '@/frontend/services/chat';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import type { ConversationChainsResponse } from '@/shared/types/conversationChain';
import { createLogger } from '@/utils/logger';
import ChainGraphCanvas from './ChainGraphCanvas';

const log = createLogger('frontend/components/ConversationChainGraph');

type LoadState = 'loading' | 'ready' | 'error';

export function ConversationChainGraph() {
  const { t } = useI18n();
  const router = useRouter();
  const theme = useTheme();
  // MUI evaluates this to false during SSR/tests without matchMedia, which is
  // the safe default (motion enabled, canvas rendered).
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isCompact = useMediaQuery(theme.breakpoints.down('sm'));

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<ConversationChainsResponse | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

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
        // Never log conversation content — only the failure itself.
        log.warn('Failed to load conversation chains', error);
        setState('error');
      });

    return () => controller.abort();
  }, [reloadToken]);

  // Stable identity: the selection effect below depends on it.
  const chains = useMemo(() => data?.chains ?? [], [data]);

  // Default to the most recently updated chain and recover from a chain that
  // disappeared between refreshes.
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
    [chains, selectedRootId]
  );

  const openConversation = useCallback(
    (conversationId: string) => {
      if (!conversationId) return;
      // magicLinkPath encodes the id; Chat validates it and falls back safely
      // when it no longer exists.
      router.push(magicLinkPath({ kind: 'conversation', id: conversationId }));
    },
    [router]
  );

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const header = (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      alignItems={{ xs: 'flex-start', sm: 'center' }}
      justifyContent="space-between"
      sx={{ mb: 2 }}
    >
      <Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            {t('chainChat.title')}
          </Typography>
          <Chip size="small" color="secondary" variant="outlined" label={t('chainChat.experimental')} />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('chainChat.subtitle')}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center">
        {chains.length > 1 && (
          <TextField
            select
            size="small"
            label={t('chainChat.chainLabel')}
            value={selectedChain?.rootId ?? ''}
            onChange={(event) => setSelectedRootId(event.target.value)}
            sx={{ minWidth: 220 }}
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
        <Button size="small" variant="outlined" startIcon={<RefreshRoundedIcon />} onClick={refresh}>
          {t('chainChat.refresh')}
        </Button>
      </Stack>
    </Stack>
  );

  let body: React.ReactNode;

  if (state === 'loading' && !data) {
    body = (
      <Stack spacing={2} aria-busy="true" aria-label={t('chainChat.loading')}>
        <Skeleton variant="rounded" height={136} />
        <Skeleton variant="rounded" height={136} sx={{ ml: { sm: 6 } }} />
        <Skeleton variant="rounded" height={136} sx={{ ml: { sm: 12 } }} />
      </Stack>
    );
  } else if (state === 'error') {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={refresh}>
            {t('chainChat.retry')}
          </Button>
        }
      >
        <AlertTitle>{t('chainChat.errorTitle')}</AlertTitle>
      </Alert>
    );
  } else if (!selectedChain || selectedChain.nodes.length === 0) {
    body = (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', borderRadius: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {t('chainChat.emptyTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('chainChat.emptyBody')}
        </Typography>
      </Paper>
    );
  } else {
    body = (
      <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0 }}>
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
        {isCompact ? (
          // Small viewports: a pannable canvas of 288px bubbles stops being
          // legible, so the same view-only bubbles are stacked as a list.
          <Stack spacing={1.25} data-testid="chain-chat-list">
            {selectedChain.nodes.map((node) => {
              const title = node.title?.trim() || t('chainChat.untitled');
              const previewText = node.lastMessage
                ? node.lastMessage.text
                : node.previewUnavailable
                  ? t('chainChat.previewUnavailable')
                  : t('chainChat.noMessages');
              return (
                <ButtonBase
                  key={node.id}
                  onClick={() => openConversation(node.id)}
                  aria-label={t('chainChat.openConversation', { title })}
                  data-testid={`chain-list-item-${node.id}`}
                  sx={{
                    display: 'block',
                    width: '100%',
                    minHeight: 56,
                    p: 1.5,
                    textAlign: 'left',
                    borderRadius: 2.5,
                    border: '1px solid',
                    borderColor: 'divider',
                    '&:focus-visible': {
                      outline: `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
                    {title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {previewText}
                  </Typography>
                </ButtonBase>
              );
            })}
          </Stack>
        ) : (
          <Box sx={{ flex: 1, minHeight: 420 }}>
            <ChainGraphCanvas
              nodes={selectedChain.nodes}
              onOpenConversation={openConversation}
              reducedMotion={reducedMotion}
            />
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {header}
      {body}
    </Box>
  );
}

export default ConversationChainGraph;

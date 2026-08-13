"use client";

import {
  AddRounded,
  PersonAddRounded,
  RefreshRounded,
} from '@mui/icons-material';
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { PersonaSummary } from '@/frontend/services/personas/summary';
import {
  getSelectedWorkspace,
  onWorkspaceChanged,
} from '@/frontend/utils/workspaceSelection';

import PersonaSummaryCard from './PersonaSummaryCard';
import {
  invalidatePersonaSummaryCache,
  loadPersonaSummaryPage,
} from './personaQueries';

const PAGE_SIZE = 24;

export default function PersonasGallery({
  busy,
  onCreate,
  onTalk,
}: {
  busy: boolean;
  onCreate: () => void;
  onTalk: (persona: Pick<PersonaSummary, 'id' | 'name'>) => Promise<void>;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [items, setItems] = useState<PersonaSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async ({
    cursor = null,
    force = false,
    append = false,
  }: {
    cursor?: string | null;
    force?: boolean;
    append?: boolean;
  } = {}) => {
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);

    try {
      const page = await loadPersonaSummaryPage({
        cursor,
        pageSize: PAGE_SIZE,
        signal: controller.signal,
        force,
      });
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setItems((current) => {
        if (!append) return page.items;
        const merged = new Map(current.map((item) => [item.id, item]));
        page.items.forEach((item) => merged.set(item.id, item));
        return [...merged.values()];
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : t('personas.loadFailed'));
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void load();
    const unsubscribe = onWorkspaceChanged(() => {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      setItems([]);
      setNextCursor(null);
      setHasMore(false);
    });
    return () => {
      unsubscribe();
      requestSequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [load]);

  const refresh = () => {
    invalidatePersonaSummaryCache(getSelectedWorkspace());
    void load({ force: true });
  };

  return (
    <Stack spacing={3}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' },
        }}
      >
        <Box>
          <Typography variant="overline" color="primary.main" fontWeight={800}>
            {t('personas.eyebrow')}
          </Typography>
          <Typography
            variant="h3"
            component="h1"
            sx={{ fontWeight: 780, letterSpacing: '-0.045em' }}
          >
            {t('personas.title')}
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 760, mt: 1 }}>
            {t('personas.description')}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            startIcon={<RefreshRounded />}
            onClick={refresh}
            disabled={busy || loading}
          >
            {t('personas.refresh')}
          </Button>
          <Button variant="contained" startIcon={<PersonAddRounded />} onClick={onCreate}>
            {t('personas.create')}
          </Button>
        </Stack>
      </Box>

      {loading && items.length === 0 ? (
        <Stack alignItems="center" justifyContent="center" minHeight="45vh" spacing={2}>
          <CircularProgress />
          <Typography color="text.secondary">{t('personas.loading')}</Typography>
        </Stack>
      ) : error && items.length === 0 ? (
        <Alert
          severity="error"
          action={<Button onClick={() => void load({ force: true })}>{t('personas.retry')}</Button>}
        >
          {error}
        </Alert>
      ) : items.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center', borderRadius: 4 }}>
          <Avatar
            sx={{
              width: 64,
              height: 64,
              mx: 'auto',
              mb: 2,
              bgcolor: alpha(theme.palette.primary.main, 0.15),
              color: 'primary.main',
            }}
          >
            <PersonAddRounded />
          </Avatar>
          <Typography variant="h5" fontWeight={750}>{t('personas.empty')}</Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 520, mx: 'auto', my: 1.5 }}>
            {t('personas.emptyHelp')}
          </Typography>
          <Button variant="contained" startIcon={<AddRounded />} onClick={onCreate}>
            {t('personas.create')}
          </Button>
        </Paper>
      ) : (
        <>
          {error && (
            <Alert
              severity="warning"
              action={<Button onClick={() => void load({ force: true })}>{t('personas.retry')}</Button>}
            >
              {error}
            </Alert>
          )}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'repeat(2, minmax(0, 1fr))',
                xl: 'repeat(3, minmax(0, 1fr))',
              },
              gap: 2,
            }}
          >
            {items.map((summary) => (
              <PersonaSummaryCard
                key={summary.id}
                summary={summary}
                busy={busy}
                onTalk={onTalk}
              />
            ))}
          </Box>
          {hasMore && nextCursor && (
            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <Button
                variant="outlined"
                disabled={loadingMore}
                onClick={() => void load({ cursor: nextCursor, append: true })}
              >
                {loadingMore ? t('personas.loadingMore') : t('personas.loadMore')}
              </Button>
            </Box>
          )}
        </>
      )}
    </Stack>
  );
}

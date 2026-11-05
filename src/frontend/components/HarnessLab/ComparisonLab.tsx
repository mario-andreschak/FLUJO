'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, FormHelperText, IconButton, LinearProgress, List, ListItem, ListItemButton, ListItemText, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { DeleteOutlineRounded } from '@mui/icons-material';
import { v4 as uuidv4 } from 'uuid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { modelService } from '@/frontend/services/model';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import {
  HARNESS_COMPARISON_MAX_BODY_BYTES,
  MAX_COMPARISON_VARIANTS,
  type HarnessComparison,
  type HarnessComparisonListItem,
  type HarnessComparisonStatus,
} from '@/shared/types/harnessComparison';
import { modelsOutsideBoundary } from '@/utils/shared/flowModelBoundary';
import { buildComparisonInput, casesToRows, emptyExampleRow, emptyVariantRow, type ExampleRow, type VariantRow } from './comparisonDraft';
import ComparisonExamplesEditor from './ComparisonExamplesEditor';
import ComparisonResults from './ComparisonResults';
import { useDraftProblemText } from './useDraftProblemText';

const statusLook: Record<HarnessComparisonStatus, { key: 'harness.compare.statusRunning' | 'harness.compare.statusCompleted' | 'harness.compare.statusCancelled' | 'harness.compare.statusInterrupted' | 'harness.compare.statusFailed'; color: 'info' | 'success' | 'default' | 'warning' | 'error' }> = {
  running: { key: 'harness.compare.statusRunning', color: 'info' },
  completed: { key: 'harness.compare.statusCompleted', color: 'success' },
  cancelled: { key: 'harness.compare.statusCancelled', color: 'default' },
  interrupted: { key: 'harness.compare.statusInterrupted', color: 'warning' },
  failed: { key: 'harness.compare.statusFailed', color: 'error' },
};

class ComparisonRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const POLL_FIRST_MS = 1_500;
const POLL_MAX_MS = 5_000;
const POLL_FAILING_MAX_MS = 15_000;

export default function ComparisonLab({ enabled, active, flows, workspace }: {
  enabled: boolean;
  /** False while another tab of the page shows, which pauses the updates. */
  active: boolean;
  flows: Flow[];
  workspace: string;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const problemText = useDraftProblemText();
  const [models, setModels] = useState<Model[]>([]);
  const [list, setList] = useState<HarnessComparisonListItem[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<HarnessComparison | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState<HarnessComparisonListItem | null>(null);
  const [name, setName] = useState('');
  const [variants, setVariants] = useState<VariantRow[]>(() => [emptyVariantRow(), emptyVariantRow()]);
  const [rows, setRows] = useState<ExampleRow[]>(() => [emptyExampleRow()]);
  const [maxCalls, setMaxCalls] = useState('8');
  const [jsonInvalid, setJsonInvalid] = useState(false);
  const identity = useRef<{ id: string; payload: string } | null>(null);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(withWorkspaceUrl(`/api/harness/comparisons${path}`, workspace), init);
    const data = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new ComparisonRequestError(data?.error || t('harness.compare.requestFailed', { status: response.status }), response.status);
    return data as T;
  }, [t, workspace]);

  const loadList = useCallback(async () => {
    const data = await api<{ comparisons: HarnessComparisonListItem[] }>('');
    setList(data.comparisons);
  }, [api]);

  useEffect(() => {
    let current = true;
    void modelService.loadModels().then((loaded) => { if (current) setModels(loaded); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    loadList().catch((cause: Error) => setError(cause.message));
  }, [enabled, loadList]);

  // Read the open comparison until it ends. A failed read tries again more slowly, so a
  // server restart or a dropped connection does not leave the page stuck.
  const openStatus = comparison?.id === openId ? comparison?.status : undefined;
  useEffect(() => {
    if (!enabled || !active || !openId || (openStatus && openStatus !== 'running')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_FIRST_MS;
    const tick = async () => {
      try {
        const next = await api<HarnessComparison>(`/${openId}`);
        if (cancelled) return;
        setComparison(next);
        setReconnecting(false);
        if (next.status !== 'running') { void loadList().catch(() => undefined); return; }
        delay = Math.min(delay * 1.3, POLL_MAX_MS);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ComparisonRequestError && cause.status === 404) {
          setOpenId(null); setComparison(null); setError(t('harness.compare.gone'));
          void loadList().catch(() => undefined);
          return;
        }
        setReconnecting(true);
        delay = Math.min(delay * 2, POLL_FAILING_MAX_MS);
      }
      timer = setTimeout(() => { void tick(); }, delay);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [active, api, enabled, loadList, openId, openStatus, t]);

  const draft = useMemo(() => buildComparisonInput({ name, variants, rows, maxModelCallsPerCase: Number(maxCalls) }), [maxCalls, name, rows, variants]);
  const body = draft.input ? JSON.stringify(draft.input) : '';
  const bytes = useMemo(() => new Blob([body]).size, [body]);
  const tooLarge = bytes > HARNESS_COMPARISON_MAX_BODY_BYTES;
  const megabytes = (value: number) => `${formatNumber(value / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
  const blocker = draft.problem
    ? problemText(draft.problem)
    : tooLarge ? t('harness.compare.problemTooLarge', { size: megabytes(bytes), max: megabytes(HARNESS_COMPARISON_MAX_BODY_BYTES) }) : '';

  const start = async () => {
    if (!draft.input || tooLarge || jsonInvalid) return;
    // One id per request text: pressing again after a dropped answer does not run it twice.
    if (identity.current?.payload !== body) identity.current = { id: uuidv4(), payload: body };
    setStarting(true); setError('');
    try {
      const created = await api<HarnessComparison>('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: identity.current.id, input: draft.input }),
      });
      identity.current = null;
      setComparison(created);
      setOpenId(created.id);
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!openId) return;
    setStopping(true); setError('');
    try {
      await api(`/${openId}`, { method: 'DELETE' });
      setComparison(await api<HarnessComparison>(`/${openId}`));
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null); setError('');
    try {
      await api(`/${target.id}`, { method: 'DELETE' });
      if (openId === target.id) { setOpenId(null); setComparison(null); }
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const useAgain = (source: HarnessComparison) => {
    setName(source.input.name);
    setVariants(source.input.variants.map((variant) => ({ ...emptyVariantRow(), flowId: variant.flowId, modelId: variant.modelId ?? '', label: variant.label ?? '' })));
    setRows(casesToRows(source.input.cases));
    setMaxCalls(String(source.input.maxModelCallsPerCase));
    setOpenId(null); setComparison(null); setError('');
  };

  const changeVariant = (key: string, patch: Partial<VariantRow>) => setVariants((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  const shown = comparison?.id === openId ? comparison : null;
  const done = shown?.results.length ?? 0;
  const total = shown ? shown.input.variants.length * shown.input.cases.length : 0;
  const callsNumber = Number(maxCalls);
  const callsValid = Number.isInteger(callsNumber) && callsNumber >= 1 && callsNumber <= 40;

  return (
    <Stack spacing={3} sx={{ minWidth: 0 }}>
      <Alert severity="info">
        <Box>{t('harness.compare.intro')}</Box>
        <Box sx={{ mt: 0.5 }}>{t('harness.compare.limits')}</Box>
      </Alert>
      {error && <Alert severity="error" onClose={() => setError('')} sx={{ overflowWrap: 'anywhere' }}>{error}</Alert>}

      {openId ? (
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}>
          {!shown ? <CircularProgress aria-label={t('common.loading')} /> : (
            <Stack spacing={2.5} sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography component="h2" variant="h5" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{shown.input.name}</Typography>
                <Chip size="small" color={statusLook[shown.status].color} label={t(statusLook[shown.status].key)} />
                <Box sx={{ flex: 1 }} />
                {shown.status === 'running'
                  ? <Button color="warning" variant="outlined" disabled={stopping} onClick={() => { void stop(); }}>{t(stopping ? 'harness.compare.stopping' : 'harness.compare.stop')}</Button>
                  : <Button onClick={() => useAgain(shown)}>{t('harness.compare.useAgain')}</Button>}
                <Button onClick={() => { setOpenId(null); setComparison(null); }}>{t('harness.compare.new')}</Button>
              </Stack>
              {shown.status === 'running' && (
                <Box>
                  <LinearProgress variant={done ? 'determinate' : 'indeterminate'} value={total ? (done / total) * 100 : 0} aria-label={t('harness.compare.progress', { done, total })} />
                  <Typography variant="body2" sx={{ mt: 0.5 }}>{t('harness.compare.progress', { done, total })}</Typography>
                  <Typography variant="caption" color="text.secondary">{t('harness.compare.keepsRunning')}</Typography>
                </Box>
              )}
              {reconnecting && <Alert severity="warning">{t('harness.compare.reconnecting')}</Alert>}
              {shown.status === 'interrupted' && <Alert severity="warning">{t('harness.compare.interrupted')}</Alert>}
              {shown.status === 'cancelled' && <Alert severity="info">{t('harness.compare.cancelled')}</Alert>}
              {shown.status === 'failed' && <Alert severity="error" sx={{ overflowWrap: 'anywhere' }}>{t('harness.compare.failedRun', { error: shown.error ?? '' })}</Alert>}
              <ComparisonResults comparison={shown} />
            </Stack>
          )}
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}>
          <Stack spacing={3} sx={{ minWidth: 0 }}>
            <Typography variant="h5" component="h2">{t('harness.compare.new')}</Typography>
            <TextField label={t('harness.compare.name')} value={name} onChange={(event) => setName(event.target.value)} fullWidth slotProps={{ htmlInput: { maxLength: 200 } }} />

            <Stack spacing={1.5}>
              <Box>
                <Typography variant="h6" component="h3">{t('harness.compare.variants')}</Typography>
                <Typography variant="body2" color="text.secondary">{t('harness.compare.variantsHelp', { max: MAX_COMPARISON_VARIANTS })}</Typography>
              </Box>
              {variants.map((variant, index) => {
                const flow = flows.find((item) => item.id === variant.flowId);
                const model = models.find((item) => item.id === variant.modelId);
                const outside = flow?.allowedModels && variant.modelId
                  ? modelsOutsideBoundary(model ?? { id: variant.modelId }, flow.allowedModels)
                  : [];
                const remove = t('harness.compare.removeVariant', { number: index + 1 });
                return (
                  <Stack key={variant.key} spacing={0.5}>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ alignItems: { md: 'center' } }}>
                      <TextField select size="small" fullWidth label={t('harness.compare.flow')} value={variant.flowId} onChange={(event) => changeVariant(variant.key, { flowId: event.target.value })}>
                        {variant.flowId && !flow && <MenuItem value={variant.flowId}>{variant.flowId}</MenuItem>}
                        {flows.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
                      </TextField>
                      <TextField select size="small" fullWidth label={t('harness.compare.model')} value={variant.modelId} onChange={(event) => changeVariant(variant.key, { modelId: event.target.value })}>
                        <MenuItem value="">{t('harness.compare.ownModels')}</MenuItem>
                        {variant.modelId && !model && <MenuItem value={variant.modelId}>{variant.modelId}</MenuItem>}
                        {models.map((item) => <MenuItem key={item.id} value={item.id}>{item.displayName || item.name}</MenuItem>)}
                      </TextField>
                      <TextField size="small" fullWidth label={t('harness.compare.variantLabel')} value={variant.label} onChange={(event) => changeVariant(variant.key, { label: event.target.value })} slotProps={{ htmlInput: { maxLength: 200 } }} />
                      <Tooltip title={remove}>
                        <span>
                          <IconButton aria-label={remove} disabled={variants.length <= 1} onClick={() => setVariants((current) => current.filter((row) => row.key !== variant.key))}>
                            <DeleteOutlineRounded fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                    {outside.length > 0 && <FormHelperText error sx={{ overflowWrap: 'anywhere' }}>{t('harness.compare.outsideList', { models: outside.join(', ') })}</FormHelperText>}
                  </Stack>
                );
              })}
              <Box>
                <Button disabled={variants.length >= MAX_COMPARISON_VARIANTS} onClick={() => setVariants((current) => [...current, emptyVariantRow()])}>{t('harness.compare.addVariant')}</Button>
              </Box>
            </Stack>

            <ComparisonExamplesEditor rows={rows} setRows={setRows} disabled={starting} onJsonInvalid={setJsonInvalid} />

            <TextField
              type="number"
              size="small"
              label={t('harness.compare.maxCalls')}
              value={maxCalls}
              onChange={(event) => setMaxCalls(event.target.value)}
              error={!callsValid}
              helperText={t('harness.compare.maxCallsHelp')}
              slotProps={{ htmlInput: { min: 1, max: 40 } }}
              sx={{ maxWidth: 320 }}
            />
            {draft.input && <Alert severity="info">{t('harness.compare.total', { runs: draft.input.variants.length * draft.input.cases.length, calls: draft.input.maxModelCallsPerCase })}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
              <Button variant="contained" disabled={!enabled || starting || !!blocker || jsonInvalid} onClick={() => { void start(); }}>
                {t(starting ? 'harness.compare.starting' : 'harness.compare.start')}
              </Button>
              {blocker && <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{blocker}</Typography>}
            </Stack>
          </Stack>
        </Paper>
      )}

      {enabled && (
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('harness.compare.earlier')}</Typography>
          {list === null ? <CircularProgress size={24} aria-label={t('common.loading')} />
            : list.length === 0 ? <Typography color="text.secondary">{t('harness.compare.noEarlier')}</Typography>
              : (
                <List disablePadding>
                  {list.map((item, index) => (
                    <Box key={item.id}>
                      {index > 0 && <Divider component="li" />}
                      <ListItem
                        disablePadding
                        secondaryAction={item.status === 'running' ? undefined : (
                          <Tooltip title={t('harness.compare.delete')}>
                            <IconButton edge="end" aria-label={`${t('harness.compare.delete')}: ${item.name}`} onClick={() => setDeleting(item)}><DeleteOutlineRounded fontSize="small" /></IconButton>
                          </Tooltip>
                        )}
                      >
                        <ListItemButton selected={item.id === openId} onClick={() => { setComparison(null); setOpenId(item.id); setError(''); }}>
                          <ListItemText
                            primary={(
                              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                                <Typography component="span" variant="body1" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{item.name}</Typography>
                                <Chip size="small" color={statusLook[item.status].color} label={t(statusLook[item.status].key)} />
                              </Stack>
                            )}
                            secondary={t('harness.compare.listLine', {
                              date: formatDate(item.createdAt, { dateStyle: 'medium', timeStyle: 'short' }),
                              cases: formatNumber(item.cases),
                              variants: formatNumber(item.summary.length),
                            })}
                          />
                        </ListItemButton>
                      </ListItem>
                    </Box>
                  ))}
                </List>
              )}
        </Paper>
      )}

      <Dialog open={!!deleting} onClose={() => setDeleting(null)}>
        <DialogTitle>{t('harness.compare.deleteTitle')}</DialogTitle>
        <DialogContent><DialogContentText>{t('harness.compare.deleteBody', { name: deleting?.name ?? '' })}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
          <Button color="error" onClick={() => { void remove(); }}>{t('harness.compare.delete')}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

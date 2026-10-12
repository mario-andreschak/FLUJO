'use client';
import { useEffect, useId, useState, type MouseEvent } from 'react';
import { Box, Button, Collapse, IconButton, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import { useAllowance } from '@/frontend/contexts/AllowanceContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { ALLOWANCE_MAX_AGE_MS, isSubscriptionAllowance, modelAllowancePercent, type ModelAllowance } from '@/shared/types/model/allowance';

/** Account groups are alternatives, not additive balances. Never average their percentages. */
export function groupAllowances(rows: ModelAllowance[], now = Date.now()): ModelAllowance[] {
  const groups = new Map<string, ModelAllowance>();
  for (const row of rows) {
    const key = `${row.provider}:${row.accountGroup ?? row.modelId}`;
    const age = row.observedAt === null ? NaN : now - Date.parse(row.observedAt);
    const expired = row.status === 'available' && (!Number.isFinite(age) || age < 0 || age >= ALLOWANCE_MAX_AGE_MS);
    const windows = row.windows.map(window => {
      const reset = window.resetAt === null ? null : Date.parse(window.resetAt);
      const value = window.remainingPercent;
      const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
      return { ...window, remainingPercent: expired || !valid || (reset !== null && (!Number.isFinite(reset) || reset <= now)) ? null : value };
    });
    const fresh = { ...row, status: expired ? 'stale' as const : row.status, windows };
    const existing = groups.get(key);
    if (!existing) groups.set(key, fresh);
    else {
      if (existing.status !== fresh.status) existing.status = existing.status === 'stale' || fresh.status === 'stale' ? 'stale' : 'unknown';
      existing.windows = [...existing.windows, ...windows].filter((window, index, all) => all.findIndex(other => other.id === window.id && other.modelFamily === window.modelFamily) === index);
    }
  }
  return [...groups.values()];
}

export function expandAllowanceIds(ids: string[], rows: ModelAllowance[], visited = new Set<string>()): string[] {
  return ids.flatMap(id => {
    if (visited.has(id)) return [];
    visited.add(id);
    const policy = rows.find(row => row.modelId === id)?.policyModelIds;
    return policy ? expandAllowanceIds(policy, rows, visited) : [id];
  });
}

export default function AllowanceBar({ modelIds, provider, entity, overview = false }: {
  modelIds?: string[]; provider?: string; entity?: { kind: 'flows' | 'personas'; id: string }; overview?: boolean;
}) {
  const { snapshot, loading, failed, now, refresh, observe, ensureFresh } = useAllowance();
  const { t, formatNumber, formatDate, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const catalogue = snapshot?.models ?? [];
  const selectedIds = (entity ? snapshot?.entities?.[entity.kind]?.[entity.id] : undefined) ?? modelIds ?? (entity ? [] : undefined);
  const ids = selectedIds ? expandAllowanceIds(selectedIds, catalogue) : undefined;
  const rows: ModelAllowance[] = (ids ? ids.map(id => catalogue.find(row => row.modelId === id) ?? { modelId: id, provider: '', status: 'unknown' as const, observedAt: null, source: null, windows: [] }) : catalogue.filter(row => !row.policyModelIds)).filter(row => !provider || row.provider === provider);
  const detailRows = overview ? rows.filter(isSubscriptionAllowance) : rows;
  const accounts = groupAllowances(rows.filter(isSubscriptionAllowance), now);
  const hasAccounts = accounts.length > 0;
  const paused = hasAccounts && accounts.every(row => row.retryAt && Date.parse(row.retryAt) > now);
  useEffect(() => observe(), [observe]);
  useEffect(() => { if (hasAccounts) void ensureFresh(rows.map(row => row.modelId)); }, [hasAccounts, rows, snapshot, now, ensureFresh]);
  if (!hasAccounts && !(overview && failed)) return null;

  const accountKey = (row: ModelAllowance) => row.provider + ':' + (row.accountGroup ?? row.modelId);
  const accountName = (row: ModelAllowance) => {
    const name = row.provider === 'claude' ? 'Claude' : 'Codex';
    const sameProvider = accounts.filter(account => account.provider === row.provider);
    return sameProvider.length > 1 ? name + ' · ' + t('models.allowance.accountNumber', { number: sameProvider.findIndex(account => accountKey(account) === accountKey(row)) + 1 }) : name;
  };
  const relativeTime = (value: string) => {
    const minutes = Math.round((Date.parse(value) - now) / 60_000);
    if (!Number.isFinite(minutes)) return t('models.allowance.unknown');
    const unit = Math.abs(minutes) >= 1440 ? 'day' : Math.abs(minutes) >= 60 ? 'hour' : 'minute';
    const count = unit === 'day' ? Math.round(minutes / 1440) : unit === 'hour' ? Math.round(minutes / 60) : minutes;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(count, unit);
  };
  const windowName = (label: string) => {
    const minutes = /(?:^|·\s*)(\d+) minutes$/.exec(label)?.[1];
    if (!minutes) return label;
    const duration = Number(minutes);
    const prefix = label.includes('·') ? label.slice(0, label.lastIndexOf('·')).trim() + ' · ' : '';
    const days = duration % 1440 === 0;
    return prefix + formatNumber(days ? duration / 1440 : duration / 60) + ' ' + t(days ? 'models.allowance.days' : 'models.allowance.hours');
  };
  const toggle = (event: MouseEvent) => { event.stopPropagation(); setExpanded(value => !value); };
  const check = (event: MouseEvent) => { event.stopPropagation(); void refresh(rows.filter(isSubscriptionAllowance).map(row => row.modelId)); };
  return <Box data-testid={overview ? 'allowance-overview' : 'allowance-summary'}
    sx={{ minWidth: 0, ...(overview ? { mb: 2.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 3, overflow: 'hidden' } : { px: 1.5, py: 1.25, borderTop: 1, borderColor: 'divider' }) }}
    onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
    {overview && <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 1.75, pb: 1.25 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t('models.allowance.title')}</Typography>
        <Typography variant="body2" color="text.secondary">{t('models.allowance.accountsNote')}</Typography></Box>
      <Button size="small" onClick={check} disabled={loading || paused} aria-label={t(loading ? 'models.allowance.checking' : 'models.allowance.refresh')} startIcon={<RefreshRoundedIcon />}
        sx={{ flexShrink: 0, minWidth: { xs: 36, sm: 64 }, textTransform: 'none', '& .MuiButton-startIcon': { mr: { xs: 0, sm: 1 }, ml: { xs: 0, sm: -0.5 } } }}>
        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{t(loading ? 'models.allowance.checking' : 'models.allowance.refresh')}</Box>
      </Button>
    </Stack>}
    <Box sx={{ display: 'flex', flexWrap: 'wrap' }} aria-label={t('models.allowance.accounts')}>
      {accounts.map(row => {
        const incomplete = row.windows.some(window => window.remainingPercent === null);
        const percent = incomplete ? null : modelAllowancePercent(row);
        const limiting = percent === null ? undefined : row.windows.find(window => window.remainingPercent === percent);
        const sharing = catalogue.filter(model => !model.policyModelIds && model.accountGroup && model.accountGroup === row.accountGroup && model.provider === row.provider).length;
        const state = row.reason === 'rate-limited' ? t('models.allowance.rateLimited')
          : row.reason === 'usage-permission' ? t('models.allowance.usagePermission')
          : row.refreshFailed && percent === null ? t('models.allowance.checkFailed')
          : incomplete && row.status === 'available' ? t('models.allowance.partialSummary')
          : t(row.status === 'stale' ? 'models.allowance.stale' : 'models.allowance.unknown');
        return <Box key={accountKey(row)} sx={{ flex: '1 1 240px', minWidth: 0, ...(overview ? { px: 2, pb: 1.5 } : {}) }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Button onClick={toggle} aria-expanded={expanded} aria-controls={detailsId} aria-label={accountName(row) + ' · ' + t('models.allowance.title')}
              sx={{ flex: 1, minWidth: 0, p: 0, justifyContent: 'space-between', color: 'text.primary', textTransform: 'none', gap: 1, '&:hover': { bgcolor: 'action.hover' } }}>
              <Typography variant="body2" sx={{ textAlign: 'left', fontWeight: 700 }}>{accountName(row)}</Typography>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography component="span" sx={{ fontSize: overview ? '1.3rem' : '0.875rem', fontWeight: percent === null ? 500 : 750 }}>
                  {percent === null ? (loading ? t('models.allowance.checking') : state) : t('models.allowance.remaining', { percent: formatNumber(percent, { maximumFractionDigits: 0 }) })}
                </Typography>
                <ExpandMoreRoundedIcon fontSize="small" sx={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
              </Stack>
            </Button>
            {!overview && <Tooltip title={t('models.allowance.refresh')}><span><IconButton size="small" aria-label={t('models.allowance.refresh')} onClick={check} disabled={loading || paused}><RefreshRoundedIcon fontSize="small" /></IconButton></span></Tooltip>}
          </Stack>
          {percent !== null && <LinearProgress variant="determinate" value={percent} color={percent <= 10 ? 'error' : percent <= 25 ? 'warning' : 'success'}
            aria-label={accountName(row) + ': ' + t('models.allowance.remaining', { percent: formatNumber(percent) })}
            sx={{ height: overview ? 8 : 6, borderRadius: 4, my: 0.75, bgcolor: 'action.hover', '& .MuiLinearProgress-bar': { backgroundImage: 'none', bgcolor: percent <= 10 ? 'error.main' : percent <= 25 ? 'warning.main' : 'success.main' } }} />}
          {limiting && <Typography variant="caption" component="div" color="text.secondary">{windowName(limiting.label)}{limiting.resetAt ? ' · ' + t('models.allowance.resetIn', { time: relativeTime(limiting.resetAt) }) : ''}</Typography>}
          {sharing > 1 && <Typography variant="caption" component="div" color="text.secondary">{t('models.allowance.shared', { count: sharing })}</Typography>}
          {row.retryAt && Date.parse(row.retryAt) > now && <Typography variant="caption" component="div" color="text.secondary">{t('models.allowance.retryIn', { time: relativeTime(row.retryAt) })}</Typography>}
          {(row.reason === 'usage-permission' || row.reason === 'rate-limited') && <Button component="a" href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer" size="small" endIcon={<OpenInNewRoundedIcon fontSize="small" />} sx={{ p: 0, mt: 0.5, textTransform: 'none' }}>{t('models.allowance.providerUsage')}</Button>}
        </Box>;
      })}
    </Box>
    {failed && <Typography role="status" color="error" variant="body2" sx={{ px: overview ? 2 : 0, pb: 1 }}>{t('models.allowance.failed')}</Typography>}
    <Collapse in={expanded} id={detailsId} unmountOnExit>
      <Stack spacing={1.5} sx={{ p: overview ? 2 : 0, pt: 1.5, mt: 1, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">{t('models.allowance.summaryNote')}</Typography>
        {accounts.map(row => <Box key={accountKey(row)}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>{accountName(row)}</Typography>
            {row.observedAt && <Typography variant="caption" color="text.secondary" title={formatDate(row.observedAt, { dateStyle: 'medium', timeStyle: 'short' })}>{t('models.allowance.lastChecked', { time: relativeTime(row.observedAt) })}</Typography>}
          </Stack>
          {row.reason === 'usage-permission' && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('models.allowance.setupTokenHelp')}</Typography>}
          {row.reason === 'rate-limited' && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('models.allowance.rateLimitHelp')}</Typography>}
          {row.refreshFailed && row.reason !== 'usage-permission' && row.reason !== 'rate-limited' && <Typography role="status" variant="body2" color="error" sx={{ mt: 0.5 }}>{t('models.allowance.failed')}</Typography>}
          {row.windows.map(window => <Stack key={window.id + ':' + (window.modelFamily ?? '')} direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', mt: 0.75 }}>
            <Typography variant="body2">{windowName(window.label)}{window.modelFamily ? ' (' + window.modelFamily + ')' : ''}</Typography>
            <Box sx={{ textAlign: 'right' }}><Typography variant="body2" sx={{ fontWeight: 600 }}>{row.status !== 'available' || window.remainingPercent === null ? t('models.allowance.unknown') : t('models.allowance.remaining', { percent: formatNumber(window.remainingPercent) })}</Typography>
              {window.resetAt && <Typography variant="caption" color="text.secondary" title={formatDate(window.resetAt, { dateStyle: 'medium', timeStyle: 'short' })}>{t('models.allowance.resetIn', { time: relativeTime(window.resetAt) })}</Typography>}</Box>
          </Stack>)}
        </Box>)}
        <Box component="ol" sx={{ pl: 2.5, m: 0 }}>{detailRows.map(row => <Typography component="li" variant="body2" key={row.modelId} sx={{ py: 0.25 }}>
          {row.modelName ?? row.modelId} · {!row.provider ? t('models.allowance.connectionMissing') : isSubscriptionAllowance(row) ? accountName(row) : t(row.billing === 'local' ? 'models.allowance.localInference' : 'models.allowance.apiBilling')}
        </Typography>)}</Box>
      </Stack>
    </Collapse>
  </Box>;
}

'use client';
import { useId, useState } from 'react';
import { Box, Button, Collapse, LinearProgress, Stack, Typography } from '@mui/material';
import { useAllowance } from '@/frontend/contexts/AllowanceContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { ALLOWANCE_MAX_AGE_MS, modelAllowancePercent, type ModelAllowance } from '@/shared/types/model/allowance';

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
  const { snapshot, loading, failed, now, refresh } = useAllowance();
  const { t, formatNumber } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const selectedIds = (entity ? snapshot?.entities?.[entity.kind]?.[entity.id] : undefined) ?? modelIds ?? (entity ? [] : undefined);
  const catalogue = snapshot?.models ?? [];
  const ids = selectedIds ? expandAllowanceIds(selectedIds, catalogue) : undefined;
  const rows: ModelAllowance[] = (ids ? ids.map(id => catalogue.find(row => row.modelId === id) ?? { modelId: id, provider: '', status: 'unknown' as const, observedAt: null, source: null, windows: [] }) : catalogue.filter(row => !row.policyModelIds)).filter(row => !provider || row.provider === provider);
  const accounts = groupAllowances(rows, now);
  if (!overview && accounts.length === 0 && !entity && !modelIds) return null;
  return <Box sx={{ p: 1.25, minWidth: 0 }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
    <Button size="small" fullWidth onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}
      aria-expanded={expanded} aria-controls={detailsId} title={t('models.allowance.summaryNote')} sx={{ justifyContent: 'space-between', textTransform: 'none' }}>
      <span>{t('models.allowance.title')}</span><span>{expanded ? '−' : '+'}</span>
    </Button>
    <Stack direction="row" spacing={0.75} aria-label={t('models.allowance.accounts')}>
      {accounts.map((row, index) => {
        const percent = row.windows.some(window => window.remainingPercent === null) ? null : modelAllowancePercent(row);
        return <Box key={`${row.provider}:${row.accountGroup ?? row.modelId}`} sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" component="div">{row.provider} {percent === null ? t(`models.allowance.${row.status === 'available' ? 'unknown' : row.status}`) : t('models.allowance.remaining', { percent: formatNumber(percent, { maximumFractionDigits: 0 }) })}</Typography>
          {row.windows.some(window => window.remainingPercent === null) && <Typography variant="caption" component="div">{t('models.allowance.partial', { count: row.windows.filter(window => window.remainingPercent === null).length })}</Typography>}
          {percent !== null ? <LinearProgress variant="determinate" value={percent} color={percent <= 10 ? 'error' : percent <= 25 ? 'warning' : index % 2 ? 'secondary' : 'primary'} aria-label={`${row.provider}: ${t('models.allowance.remaining', { percent: formatNumber(percent) })}`} />
            : <Box sx={{ height: 4, bgcolor: 'action.disabledBackground', borderRadius: 1 }} />}
        </Box>;
      })}
    </Stack>
    {accounts.length === 0 && <Typography variant="caption">{t(loading ? 'models.allowance.loading' : 'models.allowance.unknown')}</Typography>}
    <Collapse in={expanded} id={detailsId} unmountOnExit>
      <Stack spacing={1} sx={{ mt: 1 }}>
        <Typography variant="caption">{t('models.allowance.summaryNote')}</Typography>
        <Box component="ol" sx={{ pl: 2.5, m: 0 }}>
          {rows.map(row => <Typography component="li" variant="caption" key={row.modelId}>
            {row.modelName ?? row.modelId} · {row.provider || t('models.allowance.unknown')}
            {row.accountGroup && <> · {t('models.allowance.shared', { count: rows.filter(other => other.provider === row.provider && other.accountGroup === row.accountGroup).length })}</>}
          </Typography>)}
        </Box>
        {accounts.map(row => <Box key={`${row.provider}:${row.accountGroup ?? row.modelId}`}>
          <Typography variant="body2" fontWeight={700}>{row.provider}</Typography>
          <Typography variant="caption" component="div">{t('models.allowance.observed', { time: row.observedAt ?? t('models.allowance.unknown') })}</Typography>
          {row.provider === 'claude' && <Typography variant="caption" component="div">{t('models.allowance.claudeNote')}</Typography>}
          {row.windows.map(window => <Typography key={`${window.id}:${window.modelFamily ?? ''}`} variant="caption" component="div">
            {window.label}{window.modelFamily ? ` (${window.modelFamily})` : ''}: {row.status !== 'available' || window.remainingPercent === null ? t('models.allowance.unknown') : t('models.allowance.remaining', { percent: formatNumber(window.remainingPercent) })}
            {window.resetAt && <> · {t('models.allowance.reset', { time: window.resetAt })}</>}
          </Typography>)}
        </Box>)}
        {failed && <Typography role="status" color="error" variant="caption">{t('models.allowance.failed')}</Typography>}
        <Button size="small" disabled={loading} onClick={event => { event.stopPropagation(); void refresh(); }}>{t('models.allowance.refresh')}</Button>
      </Stack>
    </Collapse>
  </Box>;
}

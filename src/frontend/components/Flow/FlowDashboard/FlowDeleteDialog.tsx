"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Flow } from '@/frontend/types/flow/flow';
import type {
  FlowDeletePlan,
  FlowUsage,
  FlowUse,
  FlowUseChoice,
} from '@/shared/types/flow/flowUsage';

/**
 * Asks what happens to each place that still uses an agent before it is
 * deleted (#1389): switch it to another agent, or take the agent away. Nothing
 * is deleted until every place has an answer.
 */
export interface FlowDeleteDialogProps {
  usage: FlowUsage | null;
  flows: Flow[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onCancel: () => void;
  onConfirm: (plan: FlowDeletePlan) => void;
}

const REMOVE = 'remove';
const flowValue = (flowId: string) => `flow:${flowId}`;

function initialChoices(usage: FlowUsage, candidates: readonly Flow[]): Record<string, string> {
  return Object.fromEntries(usage.uses.flatMap((use) => (
    use.suggestedFlowId && candidates.some((flow) => flow.id === use.suggestedFlowId)
      ? [[use.key, flowValue(use.suggestedFlowId)]]
      : []
  )));
}

function toChoice(value: string): FlowUseChoice | null {
  if (value === REMOVE) return { remove: true };
  return value.startsWith('flow:') ? { replaceWith: value.slice('flow:'.length) } : null;
}

function ownerName(use: FlowUse): string {
  switch (use.place.kind) {
    case 'persona-core':
    case 'persona-behavior':
      return use.place.personaName;
    case 'automation':
      return use.place.automationName;
    case 'subflow':
      return use.place.flowName;
  }
}

function PlaceChoice({ use, flows, value, disabled, onChange }: {
  use: FlowUse;
  flows: Flow[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const owner = ownerName(use);
  const place = use.place;
  const description = place.kind === 'persona-core'
    ? t('flows.delete.place.personaCore')
    : place.kind === 'persona-behavior'
      ? t('flows.delete.place.personaBehavior', { name: place.behaviorName })
      : place.kind === 'automation'
        ? t(place.role === 'runs'
          ? 'flows.delete.place.automationRuns'
          : place.role === 'checks' ? 'flows.delete.place.automationChecks' : 'flows.delete.place.automationWaits')
        : t('flows.delete.place.subflow');
  const removeLabel = place.kind === 'persona-core'
    ? use.removePauses ? t('flows.delete.remove.personaCore', { persona: owner }) : t('flows.delete.remove.plain')
    : place.kind === 'persona-behavior'
      ? t('flows.delete.remove.personaBehavior')
      : place.kind === 'automation' ? t('flows.delete.remove.automation') : t('flows.delete.remove.subflow');
  const options = flows.filter((flow) => (
    flow.id !== use.suggestedFlowId
    && !(place.kind === 'subflow' && flow.id === place.flowId)
  ));
  const suggested = use.suggestedFlowId ? flows.find((flow) => flow.id === use.suggestedFlowId) : undefined;
  const label = `${owner}: ${description}`;

  return (
    <Box
      role="group"
      aria-label={label}
      sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(0, 1fr)' }, alignItems: 'center' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700 }} noWrap title={owner}>{owner}</Typography>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
        {!use.canRemove && place.kind === 'persona-behavior' && (
          <Typography variant="caption" color="text.secondary">
            {t('flows.delete.required', { persona: owner })}
          </Typography>
        )}
      </Box>
      <TextField
        select
        fullWidth
        size="small"
        label={t('flows.delete.switchTo')}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {suggested && (
          <MenuItem value={flowValue(suggested.id)}>
            {t('flows.delete.original', { name: suggested.name })}
          </MenuItem>
        )}
        {options.map((flow) => (
          <MenuItem key={flow.id} value={flowValue(flow.id)}>{flow.name}</MenuItem>
        ))}
        {use.canRemove && (
          <MenuItem value={REMOVE} sx={{ borderTop: 1, borderColor: 'divider' }}>{removeLabel}</MenuItem>
        )}
      </TextField>
    </Box>
  );
}

function DeleteChoices({ usage, flows, busy, error, notice, onCancel, onConfirm }: FlowDeleteDialogProps & { usage: FlowUsage }) {
  const { t, formatList } = useI18n();
  const candidates = useMemo(() => flows
    .filter((flow) => flow.id !== usage.flowId && !flow.personaOwnership)
    .sort((left, right) => left.name.localeCompare(right.name)), [flows, usage.flowId]);
  const [choices, setChoices] = useState<Record<string, string>>(() => initialChoices(usage, candidates));
  const plan = useMemo(() => {
    const answers: Record<string, FlowUseChoice> = {};
    for (const use of usage.uses) {
      const choice = toChoice(choices[use.key] ?? '');
      if (!choice || ('remove' in choice && !use.canRemove)) return null;
      answers[use.key] = choice;
    }
    return { choices: answers };
  }, [choices, usage.uses]);
  const paused = [...new Set(usage.uses
    .filter((use) => use.removePauses && choices[use.key] === REMOVE)
    .map(ownerName))];

  return (
    <>
      <DialogTitle>{t('flows.delete.title', { name: usage.flowName })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {notice && <Alert severity="info" role="status">{notice}</Alert>}
          <Typography color="text.secondary">{t('flows.delete.intro')}</Typography>
          {usage.uses.map((use, index) => (
            <React.Fragment key={use.key}>
              {index > 0 && <Divider />}
              <PlaceChoice
                use={use}
                flows={candidates}
                value={choices[use.key] ?? ''}
                disabled={busy}
                onChange={(value) => setChoices((current) => ({ ...current, [use.key]: value }))}
              />
            </React.Fragment>
          ))}
          {usage.copySources.map((source) => (
            <Typography key={source.personaId} variant="body2" color="text.secondary">
              {t('flows.delete.keepsCopy', { persona: source.personaName })}
            </Typography>
          ))}
          {paused.length > 0 && (
            <Alert severity="warning" role="status">{t('flows.delete.pauseWarning', { names: formatList(paused) })}</Alert>
          )}
          {error && <Alert severity="error" role="alert">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button
          color="error"
          variant="contained"
          disabled={busy || !plan}
          onClick={() => plan && onConfirm(plan)}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {busy ? t('flows.delete.deleting') : t('flows.card.delete')}
        </Button>
      </DialogActions>
    </>
  );
}

const FlowDeleteDialog = (props: FlowDeleteDialogProps) => {
  const { usage, busy, onCancel } = props;
  // Fresh answers whenever the places themselves change; a refresh with the same places keeps them.
  const placesKey = usage ? usage.uses.map((use) => use.key).join('|') : '';
  return (
    <Dialog open={usage !== null} onClose={busy ? undefined : onCancel} fullWidth maxWidth="sm">
      {usage && <DeleteChoices key={`${usage.flowId}:${placesKey}`} {...props} usage={usage} />}
    </Dialog>
  );
};

export default FlowDeleteDialog;

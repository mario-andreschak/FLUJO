"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import UseChoiceRow, {
  REMOVE_CHOICE,
  choiceFromValue,
  itemChoiceValue,
} from '@/frontend/components/shared/UseChoiceRow';
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

const FLOW = 'flow';

/** Agents that can take over a place: shared, and not one that is being deleted. */
export function flowCandidates(flows: readonly Flow[], leaving: readonly string[]): Flow[] {
  return flows
    .filter((flow) => !leaving.includes(flow.id) && !flow.personaOwnership)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function initialFlowChoices(usage: FlowUsage, candidates: readonly Flow[]): Record<string, string> {
  return Object.fromEntries(usage.uses.flatMap((use) => (
    use.suggestedFlowId && candidates.some((flow) => flow.id === use.suggestedFlowId)
      ? [[use.key, itemChoiceValue(FLOW, use.suggestedFlowId)]]
      : []
  )));
}

/** The plan for these answers, or `null` while a place still needs one. */
export function flowPlanFromChoices(usage: FlowUsage, choices: Record<string, string>): FlowDeletePlan | null {
  const answers: Record<string, FlowUseChoice> = {};
  for (const use of usage.uses) {
    const choice = choiceFromValue(choices[use.key] ?? '', FLOW);
    if (!choice || ('remove' in choice && !use.canRemove)) return null;
    answers[use.key] = choice;
  }
  return { choices: answers };
}

/** Personas that lose their Core Flow with these answers, so they will be paused. */
export function flowPausedPersonas(usage: FlowUsage, choices: Record<string, string>): string[] {
  return [...new Set(usage.uses
    .filter((use) => use.removePauses && choices[use.key] === REMOVE_CHOICE)
    .map(ownerName))];
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
  const suggested = use.suggestedFlowId ? flows.find((flow) => flow.id === use.suggestedFlowId) : undefined;
  const options = [
    ...(suggested ? [{ value: itemChoiceValue(FLOW, suggested.id), label: t('flows.delete.original', { name: suggested.name }) }] : []),
    ...flows
      .filter((flow) => flow.id !== use.suggestedFlowId && !(place.kind === 'subflow' && flow.id === place.flowId))
      .map((flow) => ({ value: itemChoiceValue(FLOW, flow.id), label: flow.name })),
  ];

  return (
    <UseChoiceRow
      owner={owner}
      description={description}
      note={!use.canRemove && place.kind === 'persona-behavior' ? t('flows.delete.required', { persona: owner }) : undefined}
      value={value}
      options={options}
      removeLabel={use.canRemove ? removeLabel : undefined}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

/** Every place that uses one agent, each with its choice. */
export function FlowUseRows({ usage, candidates, choices, disabled, onChange }: {
  usage: FlowUsage;
  candidates: Flow[];
  choices: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {usage.uses.map((use, index) => (
        <React.Fragment key={use.key}>
          {index > 0 && <Divider />}
          <PlaceChoice
            use={use}
            flows={candidates}
            value={choices[use.key] ?? ''}
            disabled={disabled}
            onChange={(value) => onChange(use.key, value)}
          />
        </React.Fragment>
      ))}
      {usage.copySources.map((source) => (
        <Typography key={source.personaId} variant="body2" color="text.secondary">
          {t('flows.delete.keepsCopy', { persona: source.personaName })}
        </Typography>
      ))}
    </>
  );
}

function DeleteChoices({ usage, flows, busy, error, notice, onCancel, onConfirm }: FlowDeleteDialogProps & { usage: FlowUsage }) {
  const { t, formatList } = useI18n();
  const candidates = useMemo(() => flowCandidates(flows, [usage.flowId]), [flows, usage.flowId]);
  const [choices, setChoices] = useState<Record<string, string>>(() => initialFlowChoices(usage, candidates));
  const plan = useMemo(() => flowPlanFromChoices(usage, choices), [choices, usage]);
  const paused = flowPausedPersonas(usage, choices);

  return (
    <>
      <DialogTitle>{t('flows.delete.title', { name: usage.flowName })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {notice && <Alert severity="info" role="status">{notice}</Alert>}
          <Typography color="text.secondary">{t('flows.delete.intro')}</Typography>
          <FlowUseRows
            usage={usage}
            candidates={candidates}
            choices={choices}
            disabled={busy}
            onChange={(key, value) => setChoices((current) => ({ ...current, [key]: value }))}
          />
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

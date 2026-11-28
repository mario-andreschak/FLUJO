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
import type { DeletePlan, UseChoice } from '@/shared/types/deletePlan';
import type { McpServerUsage, McpServerUse } from '@/shared/types/mcp/serverUsage';

/**
 * Asks what happens to each place that still uses a Connected App before it
 * is deleted (#1389): switch it to another app, or take the app away. Nothing
 * is deleted until every place has an answer.
 */

export interface McpServerChoice {
  name: string;
  disabled?: boolean;
}

export interface McpServerDeleteDialogProps {
  usage: McpServerUsage | null;
  servers: McpServerChoice[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onCancel: () => void;
  onConfirm: (plan: DeletePlan) => void;
}

const APP = 'app';

/** Apps that can take over a place: not one that is being deleted. */
export function serverCandidates(servers: readonly McpServerChoice[], leaving: readonly string[]): McpServerChoice[] {
  return servers
    .filter((server) => !leaving.includes(server.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The plan for these answers, or `null` while a place still needs one. */
export function serverPlanFromChoices(usage: McpServerUsage, choices: Record<string, string>): DeletePlan | null {
  const answers: Record<string, UseChoice> = {};
  for (const use of usage.uses) {
    const choice = choiceFromValue(choices[use.key] ?? '', APP);
    if (!choice) return null;
    answers[use.key] = choice;
  }
  return { choices: answers };
}

function ownerName(use: McpServerUse): string {
  switch (use.place.kind) {
    case 'flow':
      return use.place.flowName;
    case 'persona-app':
      return use.place.personaName;
    case 'automation':
      return use.place.automationName;
  }
}

/** Names of the places that lose the app with these answers. */
export function serverRemovedPlaces(usage: McpServerUsage, choices: Record<string, string>): string[] {
  return [...new Set(usage.uses.filter((use) => choices[use.key] === REMOVE_CHOICE).map(ownerName))];
}

function PlaceChoice({ use, servers, value, disabled, onChange }: {
  use: McpServerUse;
  servers: McpServerChoice[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t, tp } = useI18n();
  const place = use.place;
  const owner = ownerName(use);
  const description = place.kind === 'flow'
    ? tp('mcp.delete.place.flow', place.steps, { count: place.steps })
    : place.kind === 'persona-app'
      ? t('mcp.delete.place.persona')
      : t(place.role === 'polls' ? 'mcp.delete.place.automationPolls' : 'mcp.delete.place.automationListens');
  const removeLabel = place.kind === 'flow'
    ? t('mcp.delete.remove.flow')
    : place.kind === 'persona-app'
      ? t('mcp.delete.remove.persona', { persona: owner })
      : t('flows.delete.remove.automation');
  // A Persona can only be given an app that is switched on.
  const options = servers
    .filter((server) => place.kind !== 'persona-app' || !server.disabled)
    .map((server) => ({ value: itemChoiceValue(APP, server.name), label: server.name }));

  return (
    <UseChoiceRow
      owner={owner}
      description={description}
      note={place.kind === 'flow' && place.personaName ? t('mcp.delete.personaCopy', { persona: place.personaName }) : undefined}
      value={value}
      options={options}
      removeLabel={removeLabel}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

/** Every place that uses one app, each with its choice. */
export function McpServerUseRows({ usage, candidates, choices, disabled, onChange }: {
  usage: McpServerUsage;
  candidates: McpServerChoice[];
  choices: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {usage.uses.map((use, index) => (
        <React.Fragment key={use.key}>
          {index > 0 && <Divider />}
          <PlaceChoice
            use={use}
            servers={candidates}
            value={choices[use.key] ?? ''}
            disabled={disabled}
            onChange={(value) => onChange(use.key, value)}
          />
        </React.Fragment>
      ))}
    </>
  );
}

function DeleteChoices({ usage, servers, busy, error, notice, onCancel, onConfirm }: McpServerDeleteDialogProps & { usage: McpServerUsage }) {
  const { t, formatList } = useI18n();
  const candidates = useMemo(() => serverCandidates(servers, [usage.serverName]), [servers, usage.serverName]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const plan = useMemo(() => serverPlanFromChoices(usage, choices), [choices, usage]);
  const removed = serverRemovedPlaces(usage, choices);

  return (
    <>
      <DialogTitle>{t('flows.delete.title', { name: usage.serverName })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {notice && <Alert severity="info" role="status">{notice}</Alert>}
          <Typography color="text.secondary">{t('mcp.delete.intro')}</Typography>
          <McpServerUseRows
            usage={usage}
            candidates={candidates}
            choices={choices}
            disabled={busy}
            onChange={(key, value) => setChoices((current) => ({ ...current, [key]: value }))}
          />
          {removed.length > 0 && (
            <Alert severity="warning" role="status">{t('mcp.delete.removeWarning', { names: formatList(removed) })}</Alert>
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
          {busy ? t('flows.delete.deleting') : t('mcp.delete.confirm')}
        </Button>
      </DialogActions>
    </>
  );
}

const McpServerDeleteDialog = (props: McpServerDeleteDialogProps) => {
  const { usage, busy, onCancel } = props;
  // Fresh answers whenever the places themselves change; a refresh with the same places keeps them.
  const placesKey = usage ? usage.uses.map((use) => use.key).join('|') : '';
  return (
    <Dialog open={usage !== null} onClose={busy ? undefined : onCancel} fullWidth maxWidth="sm">
      {usage && <DeleteChoices key={`${usage.serverName}:${placesKey}`} {...props} usage={usage} />}
    </Dialog>
  );
};

export default McpServerDeleteDialog;

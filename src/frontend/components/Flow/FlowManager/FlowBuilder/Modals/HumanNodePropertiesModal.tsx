"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteIcon from '@mui/icons-material/Delete';
import type { FlowNode } from '@/frontend/types/flow/flow';
import type { TranslationKey } from '@/frontend/i18n/messages';
import type { Translator } from '@/frontend/i18n/core';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import {
  DEFAULT_HUMAN_OUTPUT_VARIABLE,
  DEFAULT_HUMAN_TIMEOUT_MINUTES,
  HUMAN_FIELD_TYPES,
  MAX_HUMAN_FIELDS,
  humanStepIssues,
  type HumanField,
  type HumanFieldType,
  type HumanNoChoice,
  type HumanStepIssue,
  type HumanStepMode,
  type HumanStepProperties,
} from '@/utils/shared/humanStep';

interface HumanNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: FlowNode['data']) => void;
  authoringMode?: FlowAuthoringMode;
}

type WaitUnit = 'days' | 'hours' | 'minutes';

const UNIT_MINUTES: Record<WaitUnit, number> = { days: 24 * 60, hours: 60, minutes: 1 };

interface FieldRow {
  key: number;
  name: string;
  label: string;
  type: HumanFieldType;
  required: boolean;
  optionsText: string;
  minText: string;
  maxText: string;
}

const HUMAN_KEYS = [
  'mode', 'title', 'prompt', 'review', 'fields', 'outputVariable',
  'timeoutMinutes', 'onReject', 'onTimeout', 'rejectedText', 'timedOutText',
] as const;

const ISSUE_KEYS: Record<string, TranslationKey> = {
  'human-invalid-mode': 'flows.human.issue.mode',
  'human-missing-prompt': 'flows.human.issue.prompt',
  'human-invalid-output-variable': 'flows.human.issue.outputVariable',
  'human-invalid-timeout': 'flows.human.issue.timeout',
  'human-invalid-choice': 'flows.human.issue.choice',
  'human-invalid-review': 'flows.human.issue.review',
  'human-missing-fields': 'flows.human.issue.noFields',
  'human-too-many-fields': 'flows.human.issue.tooManyFields',
  'human-invalid-field': 'flows.human.issue.field',
};

const FIELD_TYPE_KEYS: Record<HumanFieldType, TranslationKey> = {
  text: 'flows.human.fieldType.text',
  longText: 'flows.human.fieldType.longText',
  number: 'flows.human.fieldType.number',
  integer: 'flows.human.fieldType.integer',
  boolean: 'flows.human.fieldType.boolean',
  choice: 'flows.human.fieldType.choice',
  multiChoice: 'flows.human.fieldType.multiChoice',
};

function issueText(issue: HumanStepIssue, t: Translator): string {
  const key = ISSUE_KEYS[issue.code];
  return key ? t(key, { count: MAX_HUMAN_FIELDS }) : issue.message;
}

function splitWait(minutes: number | undefined): { amount: string; unit: WaitUnit } {
  const total = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : DEFAULT_HUMAN_TIMEOUT_MINUTES;
  if (total % UNIT_MINUTES.days === 0) return { amount: String(total / UNIT_MINUTES.days), unit: 'days' };
  if (total % UNIT_MINUTES.hours === 0) return { amount: String(total / UNIT_MINUTES.hours), unit: 'hours' };
  return { amount: String(total), unit: 'minutes' };
}

function waitMinutes(amount: string, unit: WaitUnit): number {
  const value = Number(amount.trim());
  return amount.trim() !== '' && Number.isInteger(value) ? value * UNIT_MINUTES[unit] : Number.NaN;
}

function optionalNumber(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text.trim());
}

function toRow(field: HumanField, key: number): FieldRow {
  return {
    key,
    name: field.name ?? '',
    label: field.label ?? '',
    type: field.type ?? 'text',
    required: field.required === true,
    optionsText: (field.options ?? []).join('\n'),
    minText: field.min === undefined ? '' : String(field.min),
    maxText: field.max === undefined ? '' : String(field.max),
  };
}

function toField(row: FieldRow): HumanField {
  const field: HumanField = { name: row.name.trim(), type: row.type };
  if (row.label.trim()) field.label = row.label.trim();
  if (row.required) field.required = true;
  if (row.type === 'choice' || row.type === 'multiChoice') {
    field.options = row.optionsText.split('\n').map((option) => option.trim()).filter(Boolean);
  }
  if (row.type === 'number' || row.type === 'integer') {
    const min = optionalNumber(row.minText);
    const max = optionalNumber(row.maxText);
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
  }
  return field;
}

function fieldHasProblem(field: HumanField): boolean {
  return humanStepIssues({ mode: 'input', prompt: 'x', fields: [field] }).length > 0;
}

function NoChoice({ label, value, onChange }: {
  label: string;
  value: HumanNoChoice;
  onChange: (value: HumanNoChoice) => void;
}) {
  const { t } = useI18n();
  return (
    <TextField
      select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as HumanNoChoice)}
      fullWidth
      size="small"
    >
      <MenuItem value="stop">{t('flows.human.choiceStop')}</MenuItem>
      <MenuItem value="continue">{t('flows.human.choiceContinue')}</MenuItem>
    </TextField>
  );
}

function HumanStepEditor({ node, onClose, onSave, authoringMode }: Omit<HumanNodePropertiesModalProps, 'open' | 'node'> & { node: FlowNode }) {
  const { t } = useI18n();
  const initial = (node.data.properties ?? {}) as HumanStepProperties & Record<string, unknown>;
  const initialWait = splitWait(initial.timeoutMinutes);
  const [title, setTitle] = useState(() => (initial.title ?? node.data.label ?? '').trim());
  const [mode, setMode] = useState<HumanStepMode>(() => initial.mode ?? 'approval');
  const [prompt, setPrompt] = useState(() => initial.prompt ?? '');
  const [reviewSource, setReviewSource] = useState<'last-assistant' | 'variable'>(() => initial.review?.source ?? 'last-assistant');
  const [reviewVariable, setReviewVariable] = useState(() => initial.review?.variable ?? '');
  const [reviewFormat, setReviewFormat] = useState<'text' | 'json'>(() => initial.review?.format ?? 'text');
  const [rows, setRows] = useState<FieldRow[]>(() => (initial.fields ?? []).map(toRow));
  const [nextKey, setNextKey] = useState(() => (initial.fields ?? []).length);
  const [outputVariable, setOutputVariable] = useState(() => initial.outputVariable ?? DEFAULT_HUMAN_OUTPUT_VARIABLE);
  const [waitAmount, setWaitAmount] = useState(initialWait.amount);
  const [waitUnit, setWaitUnit] = useState<WaitUnit>(initialWait.unit);
  const [onReject, setOnReject] = useState<HumanNoChoice>(() => initial.onReject ?? 'stop');
  const [onTimeout, setOnTimeout] = useState<HumanNoChoice>(() => initial.onTimeout ?? 'stop');
  const [rejectedText, setRejectedText] = useState(() => initial.rejectedText ?? '');
  const [timedOutText, setTimedOutText] = useState(() => initial.timedOutText ?? '');

  const properties = useMemo<HumanStepProperties>(() => {
    const built: HumanStepProperties = { mode, prompt };
    if (title.trim()) built.title = title.trim();
    if (mode !== 'input' && (reviewSource === 'variable' || (mode === 'edit' && reviewFormat === 'json'))) {
      built.review = {
        source: reviewSource,
        ...(reviewSource === 'variable' ? { variable: reviewVariable.trim() } : {}),
        ...(mode === 'edit' && reviewFormat === 'json' ? { format: 'json' as const } : {}),
      };
    }
    if (mode === 'input') built.fields = rows.map(toField);
    if (outputVariable.trim() !== DEFAULT_HUMAN_OUTPUT_VARIABLE) built.outputVariable = outputVariable.trim();
    built.timeoutMinutes = waitMinutes(waitAmount, waitUnit);
    if (onReject === 'continue') built.onReject = 'continue';
    else if (rejectedText.trim()) built.rejectedText = rejectedText.trim();
    if (onTimeout === 'continue') built.onTimeout = 'continue';
    else if (timedOutText.trim()) built.timedOutText = timedOutText.trim();
    return built;
  }, [mode, prompt, title, reviewSource, reviewVariable, reviewFormat, rows, outputVariable, waitAmount, waitUnit, onReject, onTimeout, rejectedText, timedOutText]);

  const issues = humanStepIssues(properties);
  const duplicateNames = new Set(rows.map((row) => row.name.trim()).filter((name, index, names) => names.indexOf(name) !== index));
  const showRouting = authoringMode !== 'guided' || onReject === 'continue' || onTimeout === 'continue';
  const resultName = outputVariable.trim() || DEFAULT_HUMAN_OUTPUT_VARIABLE;

  const updateRow = (key: number, patch: Partial<FieldRow>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  const moveRow = (index: number, delta: number) => setRows((current) => {
    const target = index + delta;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const addRow = () => {
    const used = new Set(rows.map((row) => row.name));
    let number = rows.length + 1;
    while (used.has(`answer${number}`)) number += 1;
    setRows((current) => [...current, toRow({ name: `answer${number}`, type: 'text' }, nextKey)]);
    setNextKey((key) => key + 1);
  };

  const handleSave = () => {
    if (issues.length > 0) return;
    const kept = Object.fromEntries(Object.entries(initial).filter(([key]) => !(HUMAN_KEYS as readonly string[]).includes(key)));
    onSave(node.id, {
      ...node.data,
      label: title.trim() || t('flows.human.defaultLabel'),
      properties: { ...kept, ...properties },
    });
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogHeaderActions title={t('flows.human.title')} onClose={onClose} />
      <Divider />
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">{t('flows.human.intro')}</Typography>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('flows.human.modeLabel')}</Typography>
            <ToggleButtonGroup
              exclusive
              color="primary"
              size="small"
              value={mode}
              onChange={(_, value: HumanStepMode | null) => { if (value) setMode(value); }}
              sx={{ flexWrap: 'wrap' }}
            >
              <ToggleButton value="approval">{t('flows.human.mode.approval')}</ToggleButton>
              <ToggleButton value="input">{t('flows.human.mode.input')}</ToggleButton>
              <ToggleButton value="edit">{t('flows.human.mode.edit')}</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              {t(mode === 'input' ? 'flows.human.modeHelp.input' : mode === 'edit' ? 'flows.human.modeHelp.edit' : 'flows.human.modeHelp.approval')}
            </Typography>
          </Box>

          <TextField
            label={t('flows.human.stepTitle')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            helperText={t('flows.human.stepTitleHelp')}
            fullWidth
            size="small"
          />

          <TextField
            label={t('flows.human.prompt')}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            error={!prompt.trim()}
            helperText={t('flows.human.promptHelp')}
            placeholder={t('flows.human.defaultPrompt')}
            fullWidth
            multiline
            minRows={2}
            required
          />

          {mode !== 'input' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                label={t('flows.human.reviewSource')}
                value={reviewSource}
                onChange={(event) => setReviewSource(event.target.value as 'last-assistant' | 'variable')}
                fullWidth
                size="small"
              >
                <MenuItem value="last-assistant">{t('flows.human.reviewLastAnswer')}</MenuItem>
                <MenuItem value="variable">{t('flows.human.reviewVariable')}</MenuItem>
              </TextField>
              {reviewSource === 'variable' && (
                <TextField
                  label={t('flows.human.reviewVariableName')}
                  value={reviewVariable}
                  onChange={(event) => setReviewVariable(event.target.value)}
                  error={issues.some((issue) => issue.code === 'human-invalid-review')}
                  fullWidth
                  size="small"
                />
              )}
              {mode === 'edit' && (
                <TextField
                  select
                  label={t('flows.human.reviewFormat')}
                  value={reviewFormat}
                  onChange={(event) => setReviewFormat(event.target.value as 'text' | 'json')}
                  fullWidth
                  size="small"
                >
                  <MenuItem value="text">{t('flows.human.formatText')}</MenuItem>
                  <MenuItem value="json">{t('flows.human.formatJson')}</MenuItem>
                </TextField>
              )}
            </Stack>
          )}

          {mode === 'input' && (
            <Box>
              <Typography variant="subtitle2">{t('flows.human.fieldsTitle')}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {t('flows.human.fieldsHelp')}
              </Typography>
              <Stack spacing={1.5}>
                {rows.map((row, index) => {
                  const duplicate = duplicateNames.has(row.name.trim());
                  const badName = duplicate || fieldHasProblem({ name: row.name.trim(), type: 'text' });
                  const broken = badName || fieldHasProblem(toField(row));
                  const choiceType = row.type === 'choice' || row.type === 'multiChoice';
                  const numberType = row.type === 'number' || row.type === 'integer';
                  return (
                    <Paper
                      key={row.key}
                      variant="outlined"
                      aria-label={t('flows.human.fieldRow', { number: index + 1 })}
                      sx={{ p: 1.5, borderRadius: 2, borderColor: broken ? 'error.main' : 'divider' }}
                    >
                      <Stack spacing={1.25}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                          <TextField
                            label={t('flows.human.fieldLabel')}
                            value={row.label}
                            onChange={(event) => updateRow(row.key, { label: event.target.value })}
                            fullWidth
                            size="small"
                          />
                          <TextField
                            label={t('flows.human.fieldName')}
                            value={row.name}
                            onChange={(event) => updateRow(row.key, { name: event.target.value })}
                            error={badName}
                            helperText={t('flows.human.fieldNameHelp')}
                            fullWidth
                            size="small"
                          />
                          <TextField
                            select
                            label={t('flows.human.fieldType')}
                            value={row.type}
                            onChange={(event) => updateRow(row.key, { type: event.target.value as HumanFieldType })}
                            fullWidth
                            size="small"
                          >
                            {HUMAN_FIELD_TYPES.map((type) => (
                              <MenuItem key={type} value={type}>{t(FIELD_TYPE_KEYS[type])}</MenuItem>
                            ))}
                          </TextField>
                        </Stack>
                        {choiceType && (
                          <TextField
                            label={t('flows.human.fieldOptions')}
                            value={row.optionsText}
                            onChange={(event) => updateRow(row.key, { optionsText: event.target.value })}
                            helperText={t('flows.human.fieldOptionsHelp')}
                            fullWidth
                            multiline
                            minRows={2}
                            size="small"
                          />
                        )}
                        {numberType && (
                          <Stack direction="row" spacing={1}>
                            <TextField
                              label={t('flows.human.fieldMin')}
                              value={row.minText}
                              onChange={(event) => updateRow(row.key, { minText: event.target.value })}
                              size="small"
                              fullWidth
                            />
                            <TextField
                              label={t('flows.human.fieldMax')}
                              value={row.maxText}
                              onChange={(event) => updateRow(row.key, { maxText: event.target.value })}
                              size="small"
                              fullWidth
                            />
                          </Stack>
                        )}
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <FormControlLabel
                            control={(
                              <Checkbox
                                size="small"
                                checked={row.required}
                                onChange={(event) => updateRow(row.key, { required: event.target.checked })}
                              />
                            )}
                            label={t('flows.human.fieldRequired')}
                          />
                          <Box>
                            <IconButton size="small" aria-label={t('flows.human.moveUp')} onClick={() => moveRow(index, -1)} disabled={index === 0}>
                              <ArrowUpwardIcon fontSize="small" />
                            </IconButton>
                            <IconButton size="small" aria-label={t('flows.human.moveDown')} onClick={() => moveRow(index, 1)} disabled={index === rows.length - 1}>
                              <ArrowDownwardIcon fontSize="small" />
                            </IconButton>
                            <IconButton size="small" aria-label={t('flows.human.removeField')} onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </Stack>
                      </Stack>
                    </Paper>
                  );
                })}
                <Button
                  variant="outlined"
                  startIcon={<AddRoundedIcon />}
                  onClick={addRow}
                  disabled={rows.length >= MAX_HUMAN_FIELDS}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {t('flows.human.addField')}
                </Button>
              </Stack>
            </Box>
          )}

          <Divider />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label={t('flows.human.outputVariable')}
              value={outputVariable}
              onChange={(event) => setOutputVariable(event.target.value)}
              error={issues.some((issue) => issue.code === 'human-invalid-output-variable')}
              helperText={t('flows.human.outputVariableHelp', { name: resultName })}
              fullWidth
              size="small"
            />
            <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
              <TextField
                label={t('flows.human.waitFor')}
                value={waitAmount}
                onChange={(event) => setWaitAmount(event.target.value)}
                error={issues.some((issue) => issue.code === 'human-invalid-timeout')}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                size="small"
                fullWidth
              />
              <TextField
                select
                label={t('flows.human.waitUnit')}
                value={waitUnit}
                onChange={(event) => setWaitUnit(event.target.value as WaitUnit)}
                size="small"
                fullWidth
              >
                <MenuItem value="days">{t('flows.human.unit.days')}</MenuItem>
                <MenuItem value="hours">{t('flows.human.unit.hours')}</MenuItem>
                <MenuItem value="minutes">{t('flows.human.unit.minutes')}</MenuItem>
              </TextField>
            </Stack>
          </Stack>

          {showRouting && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <NoChoice label={t('flows.human.onReject')} value={onReject} onChange={setOnReject} />
              <NoChoice label={t('flows.human.onTimeout')} value={onTimeout} onChange={setOnTimeout} />
            </Stack>
          )}
          {(onReject === 'continue' || onTimeout === 'continue') && (
            <Alert severity="info">{t('flows.human.continueHelp', { name: resultName })}</Alert>
          )}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            {onReject === 'stop' && (
              <TextField
                label={t('flows.human.rejectedText')}
                value={rejectedText}
                onChange={(event) => setRejectedText(event.target.value)}
                placeholder={t('flows.human.rejectedTextDefault')}
                fullWidth
                size="small"
              />
            )}
            {onTimeout === 'stop' && (
              <TextField
                label={t('flows.human.timedOutText')}
                value={timedOutText}
                onChange={(event) => setTimedOutText(event.target.value)}
                placeholder={t('flows.human.timedOutTextDefault')}
                fullWidth
                size="small"
              />
            )}
          </Stack>

          {issues.length > 0 && (
            <Alert severity="warning">{issueText(issues[0], t)}</Alert>
          )}
        </Stack>
      </DialogContent>
      <Divider />
      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={issues.length > 0}>
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export const HumanNodePropertiesModal = ({ open, node, ...rest }: HumanNodePropertiesModalProps) => {
  if (!open || !node) return null;
  return <HumanStepEditor key={node.id} node={node} {...rest} />;
};

export default HumanNodePropertiesModal;

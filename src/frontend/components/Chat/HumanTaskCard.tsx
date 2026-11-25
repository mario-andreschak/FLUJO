"use client";

import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  checkHumanAnswer,
  type HumanAnswer,
  type HumanField,
  type HumanTaskCallArguments,
} from '@/utils/shared/humanStep';

/** What the server said about an answer the card sent. */
export type HumanTaskAnswerResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export interface HumanTaskCardProps {
  toolCallId: string;
  task: HumanTaskCallArguments;
  onAnswer?: (
    target: { toolCallId: string; requestId: string },
    action: 'approve' | 'reject',
    human: HumanAnswer,
  ) => Promise<HumanTaskAnswerResult>;
}

type FieldValue = string | boolean | string[];

function initialValue(field: HumanField): FieldValue {
  if (field.type === 'boolean') return false;
  if (field.type === 'multiChoice') return [];
  return '';
}

function answerFor(field: HumanField, raw: FieldValue): unknown {
  if (field.type === 'boolean' || field.type === 'multiChoice') return raw;
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (field.type === 'number' || field.type === 'integer') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/**
 * The chat card for a waiting Human step (#1095): the question, what to review, the
 * questions to fill in, and two plainly labelled buttons. It checks answers before
 * sending, keeps what was typed when the server refuses an answer, and shows each
 * problem next to its question.
 */
const HumanTaskCard: React.FC<HumanTaskCardProps> = ({ toolCallId, task, onAnswer }) => {
  const { t } = useI18n();
  const fields = useMemo(() => task.fields ?? [], [task.fields]);
  const [values, setValues] = useState<Record<string, FieldValue>>(
    () => Object.fromEntries(fields.map((field) => [field.name, initialValue(field)])),
  );
  const [edited, setEdited] = useState(task.candidate ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'saved'>('idle');
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const editInput = useRef<HTMLInputElement | null>(null);

  const accepting = task.mode === 'approval' ? t('chat.humanStep.approve') : t('chat.humanStep.send');
  const declining = task.mode === 'approval' ? t('chat.humanStep.reject') : t('chat.humanStep.decline');
  const deadline = new Date(task.expiresAt);
  const deadlineText = Number.isFinite(deadline.getTime()) ? deadline.toLocaleString() : task.expiresAt;
  const busy = phase !== 'idle' || !onAnswer;

  const value = (): unknown => {
    if (task.mode === 'edit') return edited;
    if (task.mode === 'input') {
      return Object.fromEntries(fields
        .map((field) => [field.name, answerFor(field, values[field.name] ?? initialValue(field))] as const)
        .filter(([, answer]) => answer !== undefined));
    }
    return undefined;
  };

  const showProblems = (message: string, problems: Record<string, string> = {}) => {
    setError(message);
    setFieldErrors(problems);
    setPhase('idle');
    const firstProblem = fields.find((field) => problems[field.name]);
    (firstProblem ? inputs.current[firstProblem.name] : task.mode === 'edit' ? editInput.current : null)?.focus();
  };

  const send = async (action: 'approve' | 'reject') => {
    if (!onAnswer) return;
    const answer = action === 'approve' ? value() : undefined;
    if (action === 'approve') {
      const checked = checkHumanAnswer(task, answer);
      if (!checked.ok) {
        showProblems(checked.error, checked.fieldErrors);
        return;
      }
    }
    setError(null);
    setFieldErrors({});
    setPhase('sending');
    const result = await onAnswer({ toolCallId, requestId: task.requestId }, action, {
      digest: task.digest,
      ...(answer !== undefined ? { value: answer } : {}),
      idempotencyKey: `${task.requestId}:${action}`,
    });
    if (result.ok) setPhase('saved');
    else showProblems(result.error, result.fieldErrors);
  };

  const setField = (name: string, next: FieldValue) => setValues((previous) => ({ ...previous, [name]: next }));
  const inputRef = (name: string) => (element: HTMLInputElement | null) => { inputs.current[name] = element; };

  const renderField = (field: HumanField) => {
    const label = field.label || field.name;
    const problem = fieldErrors[field.name];
    const raw = values[field.name] ?? initialValue(field);
    if (field.type === 'boolean') {
      return (
        <FormControl key={field.name} error={!!problem}>
          <FormControlLabel
            control={<Switch checked={raw === true} slotProps={{ input: { ref: inputRef(field.name) } }}
              onChange={(event) => setField(field.name, event.target.checked)} disabled={busy} />}
            label={label}
          />
          {problem && <FormHelperText>{problem}</FormHelperText>}
        </FormControl>
      );
    }
    if (field.type === 'choice') {
      return (
        <FormControl key={field.name} error={!!problem} component="fieldset">
          <FormLabel component="legend" required={field.required}>{label}</FormLabel>
          <RadioGroup value={typeof raw === 'string' ? raw : ''} onChange={(event) => setField(field.name, event.target.value)}>
            {(field.options ?? []).map((option, index) => (
              <FormControlLabel key={option} value={option} label={option} disabled={busy}
                control={<Radio size="small" slotProps={{ input: { ref: index === 0 ? inputRef(field.name) : undefined } }} />} />
            ))}
          </RadioGroup>
          {problem && <FormHelperText>{problem}</FormHelperText>}
        </FormControl>
      );
    }
    if (field.type === 'multiChoice') {
      const picked = Array.isArray(raw) ? raw : [];
      return (
        <FormControl key={field.name} error={!!problem} component="fieldset">
          <FormLabel component="legend" required={field.required}>{label}</FormLabel>
          {(field.options ?? []).map((option, index) => (
            <FormControlLabel key={option} label={option} disabled={busy} control={
              <Checkbox size="small" checked={picked.includes(option)} slotProps={{ input: { ref: index === 0 ? inputRef(field.name) : undefined } }}
                onChange={() => setField(field.name, picked.includes(option)
                  ? picked.filter((item) => item !== option) : [...picked, option])} />
            } />
          ))}
          {problem && <FormHelperText>{problem}</FormHelperText>}
        </FormControl>
      );
    }
    const numeric = field.type === 'number' || field.type === 'integer';
    return (
      <TextField
        key={field.name}
        label={label}
        required={field.required}
        value={typeof raw === 'string' ? raw : ''}
        onChange={(event) => setField(field.name, event.target.value)}
        error={!!problem}
        helperText={problem}
        disabled={busy}
        fullWidth
        size="small"
        inputRef={inputRef(field.name)}
        multiline={field.type === 'longText'}
        minRows={field.type === 'longText' ? 3 : undefined}
        type={numeric ? 'number' : 'text'}
        slotProps={{ htmlInput: {
          ...(numeric ? { inputMode: field.type === 'integer' ? 'numeric' : 'decimal' } : {}),
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        } }}
      />
    );
  };

  return (
    <Paper
      elevation={2}
      data-testid="human-task-card"
      sx={{ p: 2, mt: 2, border: '1px solid', borderColor: 'primary.main', borderRadius: 2, maxWidth: '100%', overflowWrap: 'anywhere' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <PanToolOutlinedIcon color="primary" fontSize="small" />
        <Typography variant="h6" component="h3" sx={{ flexGrow: 1, fontSize: '1.05rem' }}>
          {task.title || t('chat.humanStep.title')}
        </Typography>
        <Chip size="small" label={t('chat.humanStep.waiting')} color="primary" variant="outlined" />
      </Box>
      <Typography variant="body1" sx={{ mb: 1, whiteSpace: 'pre-wrap' }}>{task.prompt}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        {t('chat.humanStep.deadline', { time: deadlineText })}
      </Typography>

      {task.mode === 'edit' ? (
        <TextField
          label={t('chat.humanStep.editLabel')}
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
          multiline
          minRows={4}
          maxRows={16}
          fullWidth
          disabled={busy}
          inputRef={editInput}
          helperText={edited !== (task.candidate ?? '') ? t('chat.humanStep.edited') : t('chat.humanStep.unchanged')}
          sx={{ mb: 1.5 }}
        />
      ) : task.candidate !== undefined && task.candidate !== '' ? (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="overline" color="text.secondary">{t('chat.humanStep.reviewLabel')}</Typography>
          <Box component="pre" sx={{
            m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, maxHeight: 240, overflow: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: task.format === 'json' ? 'monospace' : 'inherit', fontSize: '0.875rem',
          }}>
            {task.candidate}
          </Box>
        </Box>
      ) : null}

      {task.mode === 'input' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 1.5 }}>
          {fields.map(renderField)}
        </Box>
      )}

      {error && <Alert severity="error" sx={{ mb: 1.5 }} role="alert">{error}</Alert>}
      {phase === 'saved' && <Alert severity="success" sx={{ mb: 1.5 }}>{t('chat.humanStep.saved')}</Alert>}

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button variant="outlined" color="inherit" onClick={() => { void send('reject'); }} disabled={busy}
          sx={{ minHeight: 44, flex: { xs: '1 1 100%', sm: '0 0 auto' } }}>
          {declining}
        </Button>
        <Button variant="contained" color="primary" onClick={() => { void send('approve'); }} disabled={busy}
          sx={{ minHeight: 44, flex: { xs: '1 1 100%', sm: '0 0 auto' } }}>
          {phase === 'sending' ? t('chat.humanStep.sending') : accepting}
        </Button>
      </Box>
    </Paper>
  );
};

export default HumanTaskCard;

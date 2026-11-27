'use client';

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import { vetElicitationUrl } from '@/shared/utils/elicitationUrl';
import {
  elicitationContentOf,
  elicitationErrors,
  elicitationFieldsOf,
  initialElicitationValues,
  type ElicitationContent,
  type ElicitationField,
  type ElicitationFieldError,
  type ElicitationValue,
  type ElicitationValues,
} from './elicitationForm';

/** A request from an MCP server shown in chat: a form, or a link to open. */
export type PendingElicitation = {
  elicitationId: string;
  message: string;
  serverName?: string;
} & ({ mode: 'form'; requestedSchema: Record<string, unknown> } | { mode: 'url'; url: string });

export interface ElicitationHandlers {
  onSubmit?: (elicitationId: string, content: ElicitationContent) => void;
  onDone?: (elicitationId: string) => void;
  onDecline?: (elicitationId: string) => void;
  onCancel?: (elicitationId: string) => void;
}

const ERROR_KEYS: Record<ElicitationFieldError, TranslationKey> = {
  required: 'chat.elicitation.error.required',
  number: 'chat.elicitation.error.number',
  integer: 'chat.elicitation.error.integer',
  minimum: 'chat.elicitation.error.minimum',
  maximum: 'chat.elicitation.error.maximum',
  minLength: 'chat.elicitation.error.minLength',
  maxLength: 'chat.elicitation.error.maxLength',
  email: 'chat.elicitation.error.email',
  uri: 'chat.elicitation.error.uri',
  date: 'chat.elicitation.error.date',
  dateTime: 'chat.elicitation.error.dateTime',
  minItems: 'chat.elicitation.error.minItems',
  maxItems: 'chat.elicitation.error.maxItems',
  option: 'chat.elicitation.error.option',
};

const INPUT_TYPES: Partial<Record<ElicitationField['kind'], string>> = {
  email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local', number: 'number', integer: 'number',
};

interface FieldProps {
  id: string;
  field: ElicitationField;
  value: ElicitationValue;
  error?: string;
  onChange: (value: ElicitationValue) => void;
}

const ElicitationInput: React.FC<FieldProps> = ({ id, field, value, error, onChange }) => {
  const help = error ?? field.description;
  if (field.kind === 'boolean') {
    return (
      <Box>
        <FormControlLabel
          control={<Checkbox checked={value === true} onChange={(event) => onChange(event.target.checked)} size="small" />}
          label={field.label}
        />
        {field.description && <FormHelperText sx={{ mt: -0.5 }}>{field.description}</FormHelperText>}
      </Box>
    );
  }
  if (field.kind === 'multiselect') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <FormControl component="fieldset" error={Boolean(error)} required={field.required}>
        <FormLabel component="legend">{field.label}</FormLabel>
        <FormGroup>
          {(field.options ?? []).map((option) => (
            <FormControlLabel
              key={option.value}
              label={option.label}
              control={(
                <Checkbox
                  size="small"
                  checked={picked.includes(option.value)}
                  onChange={(event) => onChange(event.target.checked
                    ? [...picked, option.value]
                    : picked.filter((entry) => entry !== option.value))}
                />
              )}
            />
          ))}
        </FormGroup>
        {help && <FormHelperText>{help}</FormHelperText>}
      </FormControl>
    );
  }
  if (field.kind === 'select') {
    return (
      <FormControl size="small" sx={{ minWidth: 200 }} error={Boolean(error)} required={field.required}>
        <InputLabel id={`${id}-label`}>{field.label}</InputLabel>
        <Select
          id={id}
          labelId={`${id}-label`}
          label={field.label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(String(event.target.value))}
        >
          {!field.required && <MenuItem value=""><em>—</em></MenuItem>}
          {(field.options ?? []).map((option) => (
            <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
          ))}
        </Select>
        {help && <FormHelperText>{help}</FormHelperText>}
      </FormControl>
    );
  }
  const type = INPUT_TYPES[field.kind] ?? 'text';
  return (
    <TextField
      id={id}
      size="small"
      label={field.label}
      type={type}
      required={field.required}
      value={typeof value === 'string' ? value : ''}
      error={Boolean(error)}
      helperText={help}
      slotProps={{
        inputLabel: type === 'date' || type === 'datetime-local' ? { shrink: true } : undefined,
        htmlInput: {
          minLength: field.minLength,
          maxLength: field.maxLength,
          min: field.minimum,
          max: field.maximum,
          step: field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined,
        },
      }}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

const RequestHeader: React.FC<{ title: string; serverName?: string; message: string }> = ({ title, serverName, message }) => {
  const { t } = useI18n();
  return (
    <>
      <Typography variant="h6" sx={{ mb: 0.5 }}>{title}</Typography>
      {serverName && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {t('chat.elicitation.fromServer', { server: serverName })}
        </Typography>
      )}
      <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>{message}</Typography>
    </>
  );
};

const FormRequest: React.FC<{ request: Extract<PendingElicitation, { mode: 'form' }> } & ElicitationHandlers> = ({
  request, onSubmit, onDecline, onCancel,
}) => {
  const { t } = useI18n();
  const fields = useMemo(() => elicitationFieldsOf(request.requestedSchema), [request.requestedSchema]);
  const [values, setValues] = useState<ElicitationValues>(() => initialElicitationValues(fields));
  const [showErrors, setShowErrors] = useState(false);
  const errors = elicitationErrors(fields, values);

  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    onSubmit?.(request.elicitationId, elicitationContentOf(fields, values));
  };

  return (
    <>
      <RequestHeader title={t('chat.elicitation.title')} serverName={request.serverName} message={request.message} />
      <Box component="form" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {fields.map((field, index) => (
          <ElicitationInput
            key={field.key}
            id={`${request.elicitationId}-${index}`}
            field={field}
            value={values[field.key]}
            error={showErrors && errors[field.key] ? t(ERROR_KEYS[errors[field.key]], {
              min: field.minimum ?? field.minLength ?? field.minItems ?? '',
              max: field.maximum ?? field.maxLength ?? field.maxItems ?? '',
            }) : undefined}
            onChange={(value) => setValues((previous) => ({ ...previous, [field.key]: value }))}
          />
        ))}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
          <Button variant="text" color="inherit" size="small" onClick={() => onCancel?.(request.elicitationId)} disabled={!onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="outlined" color="inherit" size="small" onClick={() => onDecline?.(request.elicitationId)} disabled={!onDecline}>
            {t('chat.elicitation.decline')}
          </Button>
          <Button type="submit" variant="contained" color="primary" size="small" disabled={!onSubmit}>
            {t('chat.elicitation.submit')}
          </Button>
        </Box>
      </Box>
    </>
  );
};

/**
 * A link request. FLUJO never opens it by itself: the card shows the whole
 * link and the site's address, warns about look-alike addresses, and opens it
 * only when the person clicks, in a separate tab that FLUJO cannot read.
 */
const UrlRequest: React.FC<{ request: Extract<PendingElicitation, { mode: 'url' }> } & ElicitationHandlers> = ({
  request, onDone, onDecline, onCancel,
}) => {
  const { t } = useI18n();
  const vetted = vetElicitationUrl(request.url);
  const [opened, setOpened] = useState(false);

  const open = () => {
    if (!vetted) return;
    window.open(vetted.href, '_blank', 'noopener,noreferrer');
    setOpened(true);
  };

  return (
    <>
      <RequestHeader title={t('chat.elicitation.urlTitle')} serverName={request.serverName} message={request.message} />
      {vetted ? (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="body2">
            {t('chat.elicitation.urlSite')}{' '}
            <Box component="strong" data-testid="elicitation-url-host">{vetted.host}</Box>
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div"
            sx={{ wordBreak: 'break-all', fontFamily: 'monospace', mt: 0.5 }} data-testid="elicitation-url">
            {vetted.href}
          </Typography>
          {vetted.lookalikeHost && <Alert severity="warning" sx={{ mt: 1 }}>{t('chat.elicitation.urlLookalike')}</Alert>}
          {vetted.insecureLocal && <Alert severity="info" sx={{ mt: 1 }}>{t('chat.elicitation.urlLocal')}</Alert>}
        </Box>
      ) : (
        <Alert severity="error" sx={{ mb: 1.5 }}>{t('chat.elicitation.urlUnsafe')}</Alert>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {opened ? t('chat.elicitation.urlAfterOpen') : t('chat.elicitation.urlConsent')}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="text" color="inherit" size="small" onClick={() => onCancel?.(request.elicitationId)} disabled={!onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="outlined" color="inherit" size="small" onClick={() => onDecline?.(request.elicitationId)} disabled={!onDecline}>
          {t('chat.elicitation.decline')}
        </Button>
        <Button variant={opened ? 'outlined' : 'contained'} size="small" startIcon={<OpenInNewIcon />} onClick={open} disabled={!vetted}>
          {opened ? t('chat.elicitation.urlOpenAgain') : t('chat.elicitation.urlOpen')}
        </Button>
        {opened && (
          <Button variant="contained" size="small" onClick={() => onDone?.(request.elicitationId)} disabled={!onDone}>
            {t('chat.elicitation.urlDone')}
          </Button>
        )}
      </Box>
    </>
  );
};

export const ElicitationCard: React.FC<{ elicitation: PendingElicitation } & ElicitationHandlers> = ({ elicitation, ...handlers }) => (
  <Paper
    elevation={2}
    data-testid="elicitation-card"
    data-mode={elicitation.mode}
    sx={{ p: 2, mt: 2, bgcolor: 'info.light', border: '1px solid', borderColor: 'info.main', borderRadius: 2 }}
  >
    {elicitation.mode === 'url'
      ? <UrlRequest request={elicitation} {...handlers} />
      : <FormRequest request={elicitation} {...handlers} />}
  </Paper>
);

"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import GlobalReferenceEditor from './GlobalReferenceEditor';
import { useI18n } from '@/frontend/contexts/I18nContext';

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

/**
 * Render input fields for an MCP tool's parameters from its JSON schema
 * (`inputSchema`: { type:'object', properties, required }). Extracted from the
 * tool tester so every place that collects tool arguments (tester, watch-tool
 * triggers, …) shares ONE schema→form mapping.
 *
 * Mapping: boolean → switch; enum → dropdown; number/integer → number field;
 * object/array → JSON textarea (with parse feedback); everything else → text.
 * Values are stored TYPED in `values` (numbers as numbers, objects parsed).
 */
export interface SchemaParamsFormProps {
  /** The tool's inputSchema (a JSON Schema object). */
  schema: Record<string, unknown> | undefined;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  size?: 'small' | 'medium';
}

const SchemaParamsForm = ({ schema, values, onChange, size = 'small' }: SchemaParamsFormProps) => {
  const { globalEnvVars } = useStorage();
  const { t } = useI18n();
  const globalNames = useMemo(
    () => Object.keys(globalEnvVars).sort((a, b) => a.localeCompare(b)),
    [globalEnvVars],
  );
  // Local text drafts for JSON-edited fields, so half-typed JSON doesn't get
  // destroyed by round-tripping through the parsed value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const properties = asRecord(schema?.properties) ?? {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t('schema.noParameters')}
      </Typography>
    );
  }

  const setValue = (key: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {keys.map(key => {
        const prop = asRecord(properties[key]) ?? {};
        const label = required.includes(key) ? `${key} *` : key;
        const description = typeof prop.description === 'string' ? prop.description : '';
        const enumOptions = Array.isArray(prop.enum)
          ? prop.enum.filter((option): option is string | number => (
              typeof option === 'string' || typeof option === 'number'
            ))
          : [];

        if (prop.type === 'boolean') {
          return (
            <FormControlLabel
              key={key}
              control={
                <Switch
                  size={size}
                  checked={values[key] === true}
                  onChange={(e) => setValue(key, e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">{label}</Typography>
                  {description && (
                    <Typography variant="caption" color="text.secondary">
                      {description}
                    </Typography>
                  )}
                </Box>
              }
            />
          );
        }

        if (enumOptions.length > 0) {
          const current = values[key];
          return (
            <FormControl key={key} size={size} fullWidth>
              <InputLabel id={`schema-param-${key}`}>{label}</InputLabel>
              <Select
                labelId={`schema-param-${key}`}
                label={label}
                value={enumOptions.includes(current as string | number) ? current as string | number : ''}
                onChange={(e) => setValue(key, e.target.value)}
              >
                {enumOptions.map((option) => (
                  <MenuItem key={String(option)} value={option}>
                    {String(option)}
                  </MenuItem>
                ))}
              </Select>
              {description && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, mx: 1.75 }}>
                  {description}
                </Typography>
              )}
            </FormControl>
          );
        }

        if (prop.type === 'number' || prop.type === 'integer') {
          return (
            <TextField
              key={key}
              fullWidth
              size={size}
              type="number"
              label={label}
              value={values[key] !== undefined ? String(values[key]) : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setValue(key, undefined);
                  return;
                }
                const parsed = prop.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
                setValue(key, Number.isNaN(parsed) ? undefined : parsed);
              }}
              helperText={description}
            />
          );
        }

        if (prop.type === 'object' || prop.type === 'array') {
          const draft =
            drafts[key] ??
            (values[key] !== undefined ? JSON.stringify(values[key], null, 2) : '');
          let parseError: string | null = null;
          if (draft.trim()) {
            try {
              JSON.parse(draft);
            } catch {
              parseError = t('schema.invalidJson');
            }
          }
          return (
            <TextField
              key={key}
              fullWidth
              size={size}
              multiline
              minRows={2}
              label={`${label} (JSON ${prop.type})`}
              value={draft}
              error={!!parseError}
              helperText={parseError ?? description}
              onChange={(e) => {
                const text = e.target.value;
                setDrafts(prev => ({ ...prev, [key]: text }));
                if (!text.trim()) {
                  setValue(key, undefined);
                  return;
                }
                try {
                  setValue(key, JSON.parse(text));
                } catch {
                  /* keep the previous parsed value until the draft parses */
                }
              }}
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
            />
          );
        }

        return (
          <Box key={key}>
            <Typography variant="body2" component="label" sx={{ display: 'block', mb: 0.5 }}>
              {label}
            </Typography>
            <GlobalReferenceEditor
              value={values[key] !== undefined ? String(values[key]) : ''}
              onChange={(nextValue) => setValue(key, nextValue === '' ? undefined : nextValue)}
              globalNames={globalNames}
              placeholder={description || key}
              multiline={false}
              minRows={1}
              ariaLabel={label}
            />
            {description && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mx: 1.75 }}>
                {description}
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
};

export default SchemaParamsForm;

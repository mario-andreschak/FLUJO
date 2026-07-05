"use client";

import React, { useState } from 'react';
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
  schema: Record<string, any> | undefined;
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
  size?: 'small' | 'medium';
}

const SchemaParamsForm = ({ schema, values, onChange, size = 'small' }: SchemaParamsFormProps) => {
  // Local text drafts for JSON-edited fields, so half-typed JSON doesn't get
  // destroyed by round-tripping through the parsed value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const properties: Record<string, any> = schema?.properties ?? {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        This tool takes no parameters.
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
        const prop = properties[key] ?? {};
        const label = required.includes(key) ? `${key} *` : key;
        const description = typeof prop.description === 'string' ? prop.description : '';

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

        if (Array.isArray(prop.enum) && prop.enum.length > 0) {
          const current = values[key];
          return (
            <FormControl key={key} size={size} fullWidth>
              <InputLabel id={`schema-param-${key}`}>{label}</InputLabel>
              <Select
                labelId={`schema-param-${key}`}
                label={label}
                value={prop.enum.includes(current) ? current : ''}
                onChange={(e) => setValue(key, e.target.value)}
              >
                {prop.enum.map((option: unknown) => (
                  <MenuItem key={String(option)} value={option as string | number}>
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
              parseError = 'Not valid JSON yet';
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
          <TextField
            key={key}
            fullWidth
            size={size}
            label={label}
            value={values[key] !== undefined ? String(values[key]) : ''}
            onChange={(e) => setValue(key, e.target.value === '' ? undefined : e.target.value)}
            helperText={description}
          />
        );
      })}
    </Box>
  );
};

export default SchemaParamsForm;

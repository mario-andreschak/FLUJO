"use client";

import React from 'react';
import {
  Box,
  TextField,
  Typography,
  MenuItem,
  Button,
  Stack,
} from '@mui/material';
import { KV_SCOPE_KINDS, KvRefScope, isValidKvName } from '@/utils/shared/resolveKvRefs';
import { isValidRunVarName } from '@/utils/shared/resolveRunVars';

/**
 * The editor state for the three data-flow "capture" fields. `captureKv` is
 * split into a scope + key here (via `parseKvRef` on load, recombined via
 * `buildKvRef` on save) so the UI never hand-parses the scope grammar.
 */
export interface CaptureFieldsValue {
  captureVariable: string;
  captureResource: string;
  captureKvScope: KvRefScope;
  captureKvKey: string;
}

interface CaptureFieldsProps {
  value: CaptureFieldsValue;
  onChange: (patch: Partial<CaptureFieldsValue>) => void;
  /**
   * Optional: when provided, "Insert ${…}" helper buttons are rendered and this
   * callback injects the reference token into the caller's prompt editor. When
   * omitted (e.g. a subflow mode with no prompt editor), the buttons are hidden
   * but the fields themselves still work.
   */
  onInsertRef?: (text: string) => void;
}

/**
 * "Data-flow capture" editor section shared by the process- and subflow-node
 * property modals (issue #203, Phase 3 of #186).
 *
 * Lets an author save a step's output into the run-scoped variable scratchpad
 * (`captureVariable` → `${var:NAME}`), a run resource (`captureResource` →
 * `${res:NAME}`), or the cross-run persistent kv store (`captureKv` →
 * `${kv:NAME}`, with a folder/flow/global scope selector). Purely
 * presentational: it holds no state and simply reflects `value` and reports
 * edits through `onChange`. The parent modal is responsible for delete-on-empty
 * semantics when persisting to `node.data.properties`.
 */
const CaptureFields: React.FC<CaptureFieldsProps> = ({ value, onChange, onInsertRef }) => {
  const varName = value.captureVariable.trim();
  const kvKey = value.captureKvKey.trim();
  const resName = value.captureResource.trim();

  const varValid = varName === '' || isValidRunVarName(varName);
  const kvValid = kvKey === '' || isValidKvName(kvKey);

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Data-flow capture
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Optionally save this step&apos;s output so a later step can reuse it.
        Leave a field empty to not capture it.
      </Typography>

      {/* ${var:NAME} — run-scoped scratchpad (Tier 2c) */}
      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 2 }}>
        <TextField
          fullWidth
          size="small"
          label="Capture as run variable"
          value={value.captureVariable}
          onChange={(e) => onChange({ captureVariable: e.target.value })}
          error={!varValid}
          helperText={
            !varValid
              ? 'Use letters, digits, _ or - and start with a letter or _.'
              : 'Saves this step’s output into a run-scoped variable, injected later with ${var:NAME}.'
          }
        />
        {onInsertRef && (
          <Button
            variant="outlined"
            size="small"
            sx={{ mt: 0.5, whiteSpace: 'nowrap', textTransform: 'none' }}
            disabled={!varName || !varValid}
            onClick={() => onInsertRef(`\${var:${varName}}`)}
          >
            Insert ${'{var:NAME}'}
          </Button>
        )}
      </Stack>

      {/* ${res:NAME} — run resource (Tier 3) */}
      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 2 }}>
        <TextField
          fullWidth
          size="small"
          label="Capture as run resource"
          value={value.captureResource}
          onChange={(e) => onChange({ captureResource: e.target.value })}
          helperText="Saves this step’s output as a named run resource, referenced later with ${res:NAME}."
        />
        {onInsertRef && (
          <Button
            variant="outlined"
            size="small"
            sx={{ mt: 0.5, whiteSpace: 'nowrap', textTransform: 'none' }}
            disabled={!resName}
            onClick={() => onInsertRef(`\${res:${resName}}`)}
          >
            Insert ${'{res:NAME}'}
          </Button>
        )}
      </Stack>

      {/* ${kv:NAME} — cross-run persistent kv (Tier 4) */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          select
          size="small"
          label="Scope"
          sx={{ width: 130, flexShrink: 0 }}
          value={value.captureKvScope}
          onChange={(e) => onChange({ captureKvScope: e.target.value as KvRefScope })}
        >
          {KV_SCOPE_KINDS.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          size="small"
          label="Capture as persistent key (kv)"
          value={value.captureKvKey}
          onChange={(e) => onChange({ captureKvKey: e.target.value })}
          error={!kvValid}
          helperText={
            !kvValid
              ? 'Use letters, digits, _ or - and start with a letter or _.'
              : 'Persists across runs. Reference later with ${kv:NAME} (scope lives on this capture, not the reference).'
          }
        />
        {onInsertRef && (
          <Button
            variant="outlined"
            size="small"
            sx={{ mt: 0.5, whiteSpace: 'nowrap', textTransform: 'none' }}
            disabled={!kvKey || !kvValid}
            onClick={() => onInsertRef(`\${kv:${kvKey}}`)}
          >
            Insert ${'{kv:NAME}'}
          </Button>
        )}
      </Stack>
    </Box>
  );
};

export default CaptureFields;

"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  IconButton,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  TextField,
  Switch,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { Edge } from '@xyflow/react';
import {
  EdgeCondition,
  EdgeConditionKind,
  EdgeConditionTarget,
  EDGE_CONDITION_KINDS,
  EDGE_CONDITION_TARGETS,
  isRegexCompilable,
} from '@/utils/shared/edgeConditions';

interface EdgePropertiesModalProps {
  open: boolean;
  edge: Edge | null;
  onClose: () => void;
  /** Persist the edited condition; pass `undefined` to clear it (plain edge). */
  onSave: (edgeId: string, condition?: EdgeCondition) => void;
}

const KIND_LABELS: Record<EdgeConditionKind, string> = {
  contains: 'Contains',
  regex: 'Regex',
  equals: 'Equals',
  always: 'Always (any reply)',
};

const TARGET_LABELS: Record<EdgeConditionTarget, string> = {
  'last-assistant': "Last assistant reply (this step's output)",
  'last-message': 'Last message (any role)',
};

/**
 * Edits the Tier 2b deterministic-routing predicate (`edge.data.condition`) on
 * a standard flow-control edge. Intentionally lean (no async hooks) — mirrors
 * the FinishNodePropertiesModal shape. When "Conditional" is off, saving clears
 * the condition (`onSave(id, undefined)`) so the edge stays byte-compatible
 * with the compiler's plain-edge output.
 */
export const EdgePropertiesModal = ({ open, edge, onClose, onSave }: EdgePropertiesModalProps) => {
  const [conditional, setConditional] = useState(false);
  const [kind, setKind] = useState<EdgeConditionKind>('contains');
  const [value, setValue] = useState('');
  const [target, setTarget] = useState<EdgeConditionTarget>('last-assistant');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [negate, setNegate] = useState(false);

  // Re-seed local state from the edge whenever the modal (re)opens.
  useEffect(() => {
    const cond = (edge?.data as { condition?: EdgeCondition } | undefined)?.condition;
    if (cond) {
      setConditional(true);
      setKind(cond.kind);
      setValue(typeof cond.value === 'string' ? cond.value : '');
      setTarget(cond.target ?? 'last-assistant');
      setIgnoreCase(!!cond.ignoreCase);
      setNegate(!!cond.negate);
    } else {
      setConditional(false);
      setKind('contains');
      setValue('');
      setTarget('last-assistant');
      setIgnoreCase(false);
      setNegate(false);
    }
  }, [edge, open]);

  if (!edge) return null;

  const needsValue = kind !== 'always';
  // A regex with a value that can't compile is invalid; block Save so a broken
  // predicate can't be persisted (the evaluator would silently never match it).
  const regexInvalid = conditional && kind === 'regex' && value.length > 0 && !isRegexCompilable(value);
  const valueMissing = conditional && needsValue && value.length === 0;
  const saveDisabled = regexInvalid;

  const handleSave = () => {
    if (!conditional) {
      onSave(edge.id, undefined);
      onClose();
      return;
    }
    const condition: EdgeCondition = { kind };
    if (needsValue) {
      condition.value = value;
      if (ignoreCase) condition.ignoreCase = true;
    }
    if (target !== 'last-assistant') condition.target = target;
    if (negate) condition.negate = true;
    onSave(edge.id, condition);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5,
          borderColor: 'primary.main',
          width: '520px',
          maxWidth: '95vw',
          maxHeight: '90vh',
        },
      }}
    >
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">Edge Properties</Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          A conditional edge is taken only when its predicate matches the selected
          message at runtime. The flow takes the first matching outgoing edge; a
          plain (condition-less) edge is the default/fallback.
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={conditional}
              onChange={(e) => setConditional(e.target.checked)}
            />
          }
          label="Conditional edge"
        />

        {conditional && (
          <>
            <FormControl fullWidth size="small">
              <InputLabel id="edge-condition-kind-label">Kind</InputLabel>
              <Select
                labelId="edge-condition-kind-label"
                label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as EdgeConditionKind)}
              >
                {EDGE_CONDITION_KINDS.map((k) => (
                  <MenuItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {needsValue && (
              <TextField
                fullWidth
                size="small"
                label={kind === 'regex' ? 'Pattern (JS regex source)' : 'Value'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                error={regexInvalid || valueMissing}
                helperText={
                  regexInvalid
                    ? 'Invalid regular expression — will never match at runtime.'
                    : valueMissing
                    ? 'A value is required for this kind (an empty value never matches).'
                    : ' '
                }
              />
            )}

            <FormControl fullWidth size="small">
              <InputLabel id="edge-condition-target-label">Test against</InputLabel>
              <Select
                labelId="edge-condition-target-label"
                label="Test against"
                value={target}
                onChange={(e) => setTarget(e.target.value as EdgeConditionTarget)}
              >
                {EDGE_CONDITION_TARGETS.map((t) => (
                  <MenuItem key={t} value={t}>
                    {TARGET_LABELS[t]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box display="flex" gap={2} flexWrap="wrap">
              {needsValue && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={ignoreCase}
                      onChange={(e) => setIgnoreCase(e.target.checked)}
                    />
                  }
                  label="Ignore case"
                />
              )}
              <FormControlLabel
                control={
                  <Checkbox checked={negate} onChange={(e) => setNegate(e.target.checked)} />
                }
                label="Negate (match when NOT true)"
              />
            </Box>

            <FormHelperText>
              Predicates never throw at runtime: a broken regex simply never matches.
            </FormHelperText>
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" color="primary" disabled={saveDisabled}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EdgePropertiesModal;

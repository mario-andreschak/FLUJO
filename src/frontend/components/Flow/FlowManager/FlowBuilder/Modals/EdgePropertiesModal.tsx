"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
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
import { Edge } from '@xyflow/react';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import {
  EdgeCondition,
  EdgeConditionKind,
  EdgeConditionTarget,
  EDGE_CONDITION_KINDS,
  EDGE_CONDITION_TARGETS,
  isRegexCompilable,
} from '@/utils/shared/edgeConditions';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface EdgePropertiesModalProps {
  open: boolean;
  edge: Edge | null;
  onClose: () => void;
  /** Persist the edited condition; pass `undefined` to clear it (plain edge). */
  onSave: (edgeId: string, condition?: EdgeCondition) => void;
}

/**
 * Edits the Tier 2b deterministic-routing predicate (`edge.data.condition`) on
 * a standard flow-control edge. Intentionally lean (no async hooks) — mirrors
 * the FinishNodePropertiesModal shape. When "Conditional" is off, saving clears
 * the condition (`onSave(id, undefined)`) so the edge stays byte-compatible
 * with the compiler's plain-edge output.
 */
export const EdgePropertiesModal = ({ open, edge, onClose, onSave }: EdgePropertiesModalProps) => {
  const { t } = useI18n();
  const kindLabels: Record<EdgeConditionKind, string> = {
    contains: t('flows.edgeModal.contains'),
    regex: t('flows.edgeModal.regex'),
    equals: t('flows.edgeModal.equals'),
    always: t('flows.edgeModal.always'),
  };
  const targetLabels: Record<EdgeConditionTarget, string> = {
    'last-assistant': t('flows.edgeModal.lastAgent'),
    'last-message': t('flows.edgeModal.lastMessage'),
  };
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
      <DialogHeaderActions title={t('flows.edgeModal.title')} onClose={onClose} />

      <Divider />

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          {t('flows.edgeModal.help')}
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={conditional}
              onChange={(e) => setConditional(e.target.checked)}
            />
          }
          label={t('flows.edgeModal.conditional')}
        />

        {conditional && (
          <>
            <FormControl fullWidth size="small">
              <InputLabel id="edge-condition-kind-label">{t('flows.edgeModal.kind')}</InputLabel>
              <Select
                labelId="edge-condition-kind-label"
                label={t('flows.edgeModal.kind')}
                value={kind}
                onChange={(e) => setKind(e.target.value as EdgeConditionKind)}
              >
                {EDGE_CONDITION_KINDS.map((k) => (
                  <MenuItem key={k} value={k}>
                    {kindLabels[k]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {needsValue && (
              <TextField
                fullWidth
                size="small"
                label={kind === 'regex' ? t('flows.edgeModal.pattern') : t('flows.edgeModal.value')}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                error={regexInvalid || valueMissing}
                helperText={
                  regexInvalid
                    ? t('flows.edgeModal.invalidRegex')
                    : valueMissing
                    ? t('flows.edgeModal.valueRequired')
                    : ' '
                }
              />
            )}

            <FormControl fullWidth size="small">
              <InputLabel id="edge-condition-target-label">{t('flows.edgeModal.testAgainst')}</InputLabel>
              <Select
                labelId="edge-condition-target-label"
                label={t('flows.edgeModal.testAgainst')}
                value={target}
                onChange={(e) => setTarget(e.target.value as EdgeConditionTarget)}
              >
                {EDGE_CONDITION_TARGETS.map((t) => (
                  <MenuItem key={t} value={t}>
                    {targetLabels[t]}
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
                  label={t('flows.edgeModal.ignoreCase')}
                />
              )}
              <FormControlLabel
                control={
                  <Checkbox checked={negate} onChange={(e) => setNegate(e.target.checked)} />
                }
                label={t('flows.edgeModal.negate')}
              />
            </Box>

            <FormHelperText>
              {t('flows.edgeModal.runtimeSafety')}
            </FormHelperText>
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" color="primary" disabled={saveDisabled}>
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EdgePropertiesModal;

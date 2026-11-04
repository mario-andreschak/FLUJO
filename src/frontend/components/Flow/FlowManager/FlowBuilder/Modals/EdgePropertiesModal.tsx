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
  VARIABLE_SOURCES,
  VariableSource,
  defaultConditionTarget,
  isRegexCompilable,
} from '@/utils/shared/edgeConditions';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface EdgePropertiesModalProps {
  open: boolean;
  edge: Edge | null;
  onClose: () => void;
  /** Type of the node the edge leaves. It decides which message is tested by default. */
  sourceNodeType?: string;
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
export const EdgePropertiesModal = ({ open, edge, sourceNodeType, onClose, onSave }: EdgePropertiesModalProps) => {
  const { t } = useI18n();
  const kindLabels: Record<EdgeConditionKind, string> = {
    contains: t('flows.edgeModal.contains'),
    regex: t('flows.edgeModal.regex'),
    equals: t('flows.edgeModal.equals'),
    always: t('flows.edgeModal.always'),
    exists: t('flows.edgeModal.exists'),
    gt: t('flows.edgeModal.gt'),
    gte: t('flows.edgeModal.gte'),
    lt: t('flows.edgeModal.lt'),
    lte: t('flows.edgeModal.lte'),
  };
  const targetLabels: Record<EdgeConditionTarget, string> = {
    'last-assistant': t('flows.edgeModal.lastAgent'),
    'last-message': t('flows.edgeModal.lastMessage'),
    'last-user': t('flows.edgeModal.lastUser'),
    variable: t('flows.edgeModal.targetVariable'),
  };
  const sourceLabels: Record<VariableSource, string> = {
    model: t('flows.edgeModal.sourceModel'),
    tool: t('flows.edgeModal.sourceTool'),
    person: t('flows.edgeModal.sourcePerson'),
    rule: t('flows.edgeModal.sourceRule'),
    input: t('flows.edgeModal.sourceInput'),
  };
  const defaultTarget = defaultConditionTarget(sourceNodeType);
  const [conditional, setConditional] = useState(false);
  const [kind, setKind] = useState<EdgeConditionKind>('contains');
  const [value, setValue] = useState('');
  const [variable, setVariable] = useState('');
  const [source, setSource] = useState<VariableSource | ''>('');
  const [target, setTarget] = useState<EdgeConditionTarget>(defaultTarget);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [negate, setNegate] = useState(false);

  // Re-seed local state from the edge whenever the modal (re)opens.
  useEffect(() => {
    const cond = (edge?.data as { condition?: EdgeCondition } | undefined)?.condition;
    if (cond) {
      setConditional(true);
      setKind(cond.kind);
      setValue(typeof cond.value === 'string' ? cond.value : '');
      setVariable(typeof cond.variable === 'string' ? cond.variable : '');
      setSource(typeof cond.from === 'string' ? cond.from : '');
      setTarget(cond.target ?? defaultTarget);
      setIgnoreCase(!!cond.ignoreCase);
      setNegate(!!cond.negate);
    } else {
      setConditional(false);
      setKind('contains');
      setValue('');
      setVariable('');
      setSource('');
      setTarget(defaultTarget);
      setIgnoreCase(false);
      setNegate(false);
    }
  }, [edge, open, defaultTarget]);

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
    if (target !== defaultTarget) condition.target = target;
    if (target === 'variable') {
      condition.variable = variable.trim();
      if (source) condition.from = source;
    }
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
      slotProps={{ paper: {
        sx: {
          borderTop: 5,
          borderColor: 'primary.main',
          width: '520px',
          maxWidth: '95vw',
          maxHeight: '90vh',
        },
      } }}
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

            {target === 'variable' && (
              <TextField
                fullWidth
                size="small"
                label={t('flows.edgeModal.variableName')}
                value={variable}
                onChange={(e) => setVariable(e.target.value)}
                error={!variable.trim()}
                helperText={t('flows.edgeModal.variableHelp')}
                placeholder="status.items.0.code"
              />
            )}

            {target === 'variable' && (
              <FormControl fullWidth size="small">
                <InputLabel id="edge-condition-source-label">{t('flows.edgeModal.source')}</InputLabel>
                <Select
                  labelId="edge-condition-source-label"
                  label={t('flows.edgeModal.source')}
                  value={source}
                  onChange={(e) => setSource(e.target.value as VariableSource | '')}
                >
                  <MenuItem value="">{t('flows.edgeModal.sourceAny')}</MenuItem>
                  {VARIABLE_SOURCES.map((option) => (
                    <MenuItem key={option} value={option}>{sourceLabels[option]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
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

"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import type { Flow } from '@/shared/types/flow';
import type {
  FlowPlausibilityResult,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import { flowService } from '@/frontend/services/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { localizeFlowIssue } from '@/frontend/i18n/flowValidation';

interface FlowAssistanceDialogProps {
  open: boolean;
  flow: Flow;
  relatedFlows?: Flow[];
  nodeId?: string | null;
  modelId?: string | null;
  models?: Array<{ id: string; name: string; displayName?: string }>;
  onApply: (flow: Flow) => void;
  onApplyRelatedFlows?: (flows: Flow[]) => void;
  onClose: () => void;
}

type Stage = 'suggesting' | 'tools' | 'checking' | 'plausibility';

export default function FlowAssistanceDialog({
  open,
  flow,
  relatedFlows = [],
  nodeId,
  modelId,
  models = [],
  onApply,
  onApplyRelatedFlows,
  onClose,
}: FlowAssistanceDialogProps) {
  const { t, tp } = useI18n();
  const [stage, setStage] = useState<Stage>('suggesting');
  const [suggestion, setSuggestion] = useState<StepToolSuggestionResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plausibility, setPlausibility] = useState<FlowPlausibilityResult | null>(null);
  const [workingFlow, setWorkingFlow] = useState(flow);
  const [chosenModelId, setChosenModelId] = useState(modelId ?? '');
  const [error, setError] = useState<string | null>(null);

  const check = async (candidate: Flow) => {
    setStage('checking');
    setError(null);
    try {
      const result = await flowService.checkPlausibility({
        flow: candidate,
        relatedFlows,
        modelId: chosenModelId || modelId || undefined,
        intendedContext: 'chat',
      });
      setPlausibility(result);
      setStage('plausibility');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.checkFailed'));
      setStage('plausibility');
    }
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setWorkingFlow(flow);
    setSuggestion(null);
    setPlausibility(null);
    setSelected(new Set());
    setChosenModelId(modelId ?? '');
    setError(null);
    if (!nodeId) {
      void check(flow);
      return () => { active = false; };
    }
    if (!modelId) {
      setStage('tools');
      return () => { active = false; };
    }
    setStage('suggesting');
    void flowService.suggestToolsForStep({
      flow,
      nodeId,
      modelId,
      goal: flow.description,
    }).then((result) => {
      if (!active) return;
      setSuggestion(result);
      setSelected(new Set(result.suggestions.map((item) => `${item.server}\u0000${item.tool}`)));
      if (result.suggestions.length === 0) {
        void check(flow);
      } else {
        setStage('tools');
      }
    }).catch((caught) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : t('flows.assistance.suggestFailed'));
      setStage('tools');
    });
    return () => { active = false; };
    // The opening snapshot is intentional; live edits wait for the next review.
  }, [open, nodeId, modelId]);

  const chosen = useMemo(
    () => suggestion?.suggestions.filter((item) => selected.has(`${item.server}\u0000${item.tool}`)) ?? [],
    [selected, suggestion],
  );
  const applicablePatchCount = useMemo(() => {
    if (!plausibility) return 0;
    const editableIds = new Set([flow.id, ...relatedFlows.map((candidate) => candidate.id)]);
    return plausibility.patches.filter((patch) => editableIds.has(patch.flowId)).length;
  }, [flow.id, plausibility, relatedFlows]);

  const suggestWithModel = async () => {
    if (!nodeId || !chosenModelId) return;
    setStage('suggesting');
    setError(null);
    try {
      const result = await flowService.suggestToolsForStep({
        flow: workingFlow,
        nodeId,
        modelId: chosenModelId,
        goal: workingFlow.description,
      });
      setSuggestion(result);
      setSelected(new Set(result.suggestions.map((item) => `${item.server}\u0000${item.tool}`)));
      if (result.suggestions.length === 0) {
        await check(workingFlow);
      } else {
        setStage('tools');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.suggestFailed'));
      setStage('tools');
    }
  };

  const applyTools = async () => {
    if (!nodeId || !suggestion) return;
    setStage('suggesting');
    setError(null);
    try {
      const updated = await flowService.applyToolsToStep({
        flow: workingFlow,
        nodeId,
        selections: chosen,
        proposedPrompt: suggestion.proposedPrompt,
      });
      setWorkingFlow(updated);
      onApply(updated);
      await check(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.connectFailed'));
      setStage('tools');
    }
  };

  const busy = stage === 'suggesting' || stage === 'checking';
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeRoundedIcon color="primary" />
        {stage === 'plausibility' || stage === 'checking' ? t('flows.assistance.plausibilityTitle') : t('flows.assistance.toolsTitle')}
      </DialogTitle>
      <DialogContent dividers>
        {busy && (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}>
            <CircularProgress />
            <Typography color="text.secondary">
              {stage === 'suggesting' ? t('flows.assistance.finding') : t('flows.assistance.checking')}
            </Typography>
          </Stack>
        )}
        {error && !busy && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {stage === 'tools' && !suggestion && (
          <Stack spacing={2}>
            {models.length === 0 ? (
              <Alert severity="warning">{t('flows.assistance.needModel')}</Alert>
            ) : (
              <>
                <Alert severity="info">{t('flows.assistance.chooseModel')}</Alert>
                <FormControl fullWidth size="small">
                  <InputLabel id="assistance-model-label">{t('flows.assistance.aiHelper')}</InputLabel>
                  <Select
                    labelId="assistance-model-label"
                    label={t('flows.assistance.aiHelper')}
                    value={chosenModelId}
                    onChange={(event) => setChosenModelId(String(event.target.value))}
                  >
                    {models.map((model) => (
                      <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </>
            )}
          </Stack>
        )}

        {stage === 'tools' && suggestion && (
          <Stack spacing={1.5}>
            <Alert severity="info">
              {t('flows.assistance.approvalHelp')}
            </Alert>
            {suggestion.suggestions.length === 0 ? (
              <Alert severity="success">{t('flows.assistance.noTool')}</Alert>
            ) : suggestion.suggestions.map((item) => {
              const key = `${item.server}\u0000${item.tool}`;
              return (
                <Paper key={key} variant="outlined" sx={{ p: 1.25 }}>
                  <FormControlLabel
                    control={<Checkbox checked={selected.has(key)} onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(key); else next.delete(key);
                        return next;
                      });
                    }} />}
                    label={
                      <Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip size="small" label={item.server} />
                          <Typography fontWeight={800}>{item.tool}</Typography>
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{item.reason}</Typography>
                      </Box>
                    }
                  />
                </Paper>
              );
            })}
            <Box>
              <Typography variant="subtitle2">{t('flows.assistance.promptPreview')}</Typography>
              <Paper variant="outlined" sx={{ p: 1.25, mt: 0.5, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                <Typography variant="body2" component="pre" sx={{ m: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                  {suggestion.proposedPrompt}
                </Typography>
              </Paper>
            </Box>
          </Stack>
        )}

        {stage === 'plausibility' && plausibility && (
          <Stack spacing={1.5}>
            <Stack direction="row" gap={1} flexWrap="wrap">
              {plausibility.contexts.map((context) => <Chip key={`${context.kind}-${context.sourceId ?? ''}`} label={context.label} />)}
            </Stack>
            {plausibility.issues.length === 0 ? (
              <Alert severity="success">{t('flows.assistance.plausible')}</Alert>
            ) : plausibility.issues.map((issue, index) => {
              const reviewedFlow = plausibility.repairedFlows.find((candidate) => candidate.id === issue.flowId);
              return (
                <Alert key={`${issue.code}-${issue.flowId ?? ''}-${issue.nodeId ?? ''}-${index}`} severity={issue.severity}>
                  {reviewedFlow && reviewedFlow.id !== flow.id ? `${reviewedFlow.name}: ` : ''}{localizeFlowIssue(issue, t)}
                </Alert>
              );
            })}
            {applicablePatchCount > 0 && (
              <Alert severity="info">
                {tp('flows.assistance.patch', applicablePatchCount)}
              </Alert>
            )}
            {plausibility.patches.length > applicablePatchCount && (
              <Alert severity="warning">
                {tp('flows.assistance.savedPatch', plausibility.patches.length - applicablePatchCount)}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('flows.assistance.close')}</Button>
        {stage === 'tools' && !suggestion && models.length > 0 && (
          <Button variant="contained" disabled={!chosenModelId} onClick={() => void suggestWithModel()}>
            {t('flows.assistance.suggest')}
          </Button>
        )}
        {stage === 'tools' && suggestion && suggestion.suggestions.length === 0 && (
          <Button startIcon={<FactCheckRoundedIcon />} onClick={() => void check(workingFlow)}>{t('flows.assistance.checkFlow')}</Button>
        )}
        {stage === 'tools' && suggestion && suggestion.suggestions.length > 0 && (
          <>
            <Button onClick={() => void check(workingFlow)}>{t('flows.assistance.skip')}</Button>
            <Button variant="contained" startIcon={<BuildRoundedIcon />} disabled={chosen.length === 0} onClick={() => void applyTools()}>
              {tp('flows.assistance.connect', chosen.length)}
            </Button>
          </>
        )}
        {stage === 'plausibility' && plausibility && applicablePatchCount > 0 ? (
          <Button variant="contained" startIcon={<FactCheckRoundedIcon />} onClick={() => {
            onApply(plausibility.repairedFlow);
            const repairedById = new Map(
              plausibility.repairedFlows.map((candidate) => [candidate.id, candidate]),
            );
            onApplyRelatedFlows?.(
              relatedFlows.map((candidate) => repairedById.get(candidate.id) ?? candidate),
            );
            onClose();
          }}>
            {t('flows.assistance.apply')}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

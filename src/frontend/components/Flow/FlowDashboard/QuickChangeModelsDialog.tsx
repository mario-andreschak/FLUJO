'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import type { Flow } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types/model';
import {
  collectFlowModelUsage,
  type FlowModelReplacementMap,
} from '@/utils/shared/flowModelReplacement';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface QuickModelChangeResult {
  updatedFlowCount: number;
  replacedNodeCount: number;
  failedFlowCount: number;
}

interface QuickChangeModelsDialogProps {
  open: boolean;
  flows: Flow[];
  models: Model[];
  modelsLoading?: boolean;
  onClose: () => void;
  onApply: (replacements: FlowModelReplacementMap) => Promise<QuickModelChangeResult>;
}

/** Map every model used by the selected agents to an installed replacement. */
const QuickChangeModelsDialog = ({
  open,
  flows,
  models,
  modelsLoading = false,
  onClose,
  onApply,
}: QuickChangeModelsDialogProps) => {
  const { t, tp, formatNumber } = useI18n();
  const [targetBySource, setTargetBySource] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usages = useMemo(() => collectFlowModelUsage(flows, models), [flows, models]);
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

  useEffect(() => {
    if (!open) return;
    setTargetBySource({});
    setApplying(false);
    setError(null);
  }, [open]);

  const replacements = useMemo<FlowModelReplacementMap>(() => {
    const result: FlowModelReplacementMap = {};
    for (const [sourceId, targetId] of Object.entries(targetBySource)) {
      if (!targetId || targetId === sourceId) continue;
      const target = modelById.get(targetId);
      if (target) result[sourceId] = { id: target.id, name: target.name };
    }
    return result;
  }, [modelById, targetBySource]);

  const replacementCount = Object.keys(replacements).length;

  const apply = async () => {
    if (replacementCount === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await onApply(replacements);
      if (result.updatedFlowCount === 0 && result.failedFlowCount > 0) {
        setError(t('flows.quickModels.applyFailed'));
        return;
      }
      onClose();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t('flows.quickModels.applyFailed'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onClose={applying ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{t('flows.quickModels.title')}</DialogTitle>
      <DialogContent dividers>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {t('flows.quickModels.description', { count: formatNumber(flows.length) })}
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {modelsLoading ? (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 6 }}>
            <CircularProgress size={28} />
            <Typography color="text.secondary">{t('flows.quickModels.loading')}</Typography>
          </Stack>
        ) : models.length === 0 ? (
          <Alert severity="warning">{t('flows.quickModels.noModels')}</Alert>
        ) : usages.length === 0 ? (
          <Alert severity="info">{t('flows.quickModels.noBindings')}</Alert>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="overline" color="text.secondary" fontWeight={700} sx={{ flex: 1 }}>
                {t('flows.quickModels.currentModels')}
              </Typography>
              <Typography variant="overline" color="text.secondary" fontWeight={700} sx={{ flex: 1 }}>
                {t('flows.quickModels.replacements')}
              </Typography>
            </Stack>

            {usages.map((usage, index) => (
              <React.Fragment key={usage.modelId}>
                {index > 0 && <Divider />}
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) 44px minmax(0, 1fr)' },
                    gap: 1.5,
                    alignItems: 'center',
                  }}
                >
                  <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
                    <Box
                      sx={{
                        width: 40,
                        height: 40,
                        borderRadius: 2,
                        display: 'grid',
                        placeItems: 'center',
                        bgcolor: 'action.hover',
                        color: usage.missing ? 'warning.main' : 'primary.main',
                        flex: '0 0 auto',
                      }}
                    >
                      <SmartToyOutlinedIcon />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Typography fontWeight={700} noWrap>{usage.label}</Typography>
                        {usage.missing && <Chip size="small" color="warning" label={t('flows.quickModels.missing')} />}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {t('flows.quickModels.usage', {
                          steps: tp('flows.quickModels.stepCount', usage.nodeCount),
                          agents: tp('flows.quickModels.agentCount', usage.flowCount),
                        })}
                      </Typography>
                    </Box>
                  </Stack>

                  <ArrowForwardRoundedIcon
                    color="action"
                    sx={{ justifySelf: 'center', transform: { xs: 'rotate(90deg)', sm: 'none' } }}
                  />

                  <TextField
                    select
                    fullWidth
                    size="small"
                    label={t('flows.quickModels.chooseReplacement')}
                    value={targetBySource[usage.modelId] ?? ''}
                    onChange={(event) => {
                      const targetId = event.target.value;
                      setTargetBySource((current) => ({ ...current, [usage.modelId]: targetId }));
                    }}
                  >
                    <MenuItem value=""><em>{t('flows.quickModels.leaveUnchanged')}</em></MenuItem>
                    {models
                      .filter((model) => model.id !== usage.modelId)
                      .map((model) => (
                        <MenuItem key={model.id} value={model.id}>
                          {model.displayName || model.name}
                        </MenuItem>
                      ))}
                  </TextField>
                </Box>
              </React.Fragment>
            ))}

            <Alert severity={replacementCount > 0 ? 'info' : 'warning'}>
              {replacementCount > 0
                ? tp('flows.quickModels.ready', replacementCount)
                : t('flows.quickModels.chooseAtLeastOne')}
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={applying}>{t('common.cancel')}</Button>
        <Button
          variant="contained"
          onClick={() => void apply()}
          disabled={applying || modelsLoading || replacementCount === 0}
          startIcon={applying ? <CircularProgress size={16} color="inherit" /> : <SmartToyOutlinedIcon />}
        >
          {applying ? t('flows.quickModels.applying') : t('flows.quickModels.apply')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default QuickChangeModelsDialog;

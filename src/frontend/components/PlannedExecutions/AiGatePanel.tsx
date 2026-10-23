"use client";

import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControl, InputLabel, MenuItem, Select, TextField, Typography } from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type { AutomationAiGate } from '@/shared/types/plannedExecution';
import type { Model } from '@/shared/types/model';
import type { Flow } from '@/frontend/types/flow/flow';
import { modelService } from '@/frontend/services/model';
import { useI18n } from '@/frontend/contexts/I18nContext';
import OptionCard from './OptionCard';

/** Shared by every trigger. Keeping the condition outside the trigger editor
 * preserves it when the user changes the event type. */
export default function AiGatePanel({ config, onChange, flows, loadingFlows }: {
  config: AutomationAiGate | null;
  onChange: (config: AutomationAiGate | null) => void;
  flows: Flow[];
  loadingFlows: boolean;
}) {
  const { t } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [retry, setRetry] = useState(0);
  const needsModels = config?.mode === 'llm-gate';

  useEffect(() => {
    if (!needsModels) return;
    let cancelled = false;
    setLoadingModels(true);
    setModelsError(false);
    modelService.tryLoadModels().then(list => {
      if (list === null) throw new Error('Models unavailable');
      if (!cancelled) setModels(Array.isArray(list) ? list : []);
    }).catch(() => {
      if (!cancelled) setModelsError(true);
    }).finally(() => {
      if (!cancelled) setLoadingModels(false);
    });
    return () => { cancelled = true; };
  }, [needsModels, retry]);

  const missingChecker = config?.mode === 'llm-gate'
    ? !loadingModels && !modelsError && !!config.modelId && !models.some(model => model.id === config.modelId)
    : config?.mode === 'flow-gate' && !loadingFlows && !!config.flowId && !flows.some(flow => flow.id === config.flowId);

  return (
    <Box id="automation-ai-condition" sx={{ mt: 3, minWidth: 0 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        {t('automations.gate.title')}
      </Typography>
      <Box role="radiogroup" aria-label={t('automations.gate.title')} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <OptionCard selected={!config} onClick={() => onChange(null)} icon={<PlayArrowIcon />}
          title={t('automations.gate.always')} description={t('automations.gate.alwaysHelp')} />
        <OptionCard selected={!!config} onClick={() => {
          if (!config) onChange({ mode: 'llm-gate', condition: '', modelId: '' });
        }} icon={<PsychologyIcon />} title={t('automations.tool.aiDecides')}
          description={t('automations.gate.description')} />
      </Box>
      {config && (
        <Box sx={{ mt: 1 }}>
          <TextField fullWidth required label={t('automations.gate.condition')}
            value={config.condition} onChange={e => onChange({ ...config, condition: e.target.value })}
            multiline minRows={2} margin="normal" />
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '170px minmax(0, 1fr)' } }}>
            <FormControl fullWidth>
              <InputLabel id="gate-checker-label">{t('automations.tool.checkedBy')}</InputLabel>
              <Select labelId="gate-checker-label" label={t('automations.tool.checkedBy')} value={config.mode}
                onChange={e => {
                  if (e.target.value === config.mode) return;
                  const common = { condition: config.condition, maxCallsPerDay: config.maxCallsPerDay };
                  onChange(e.target.value === 'llm-gate'
                    ? { ...common, mode: 'llm-gate', modelId: '' }
                    : { ...common, mode: 'flow-gate', flowId: '' });
                }}>
                <MenuItem value="llm-gate">{t('automations.tool.aModel')}</MenuItem>
                <MenuItem value="flow-gate">{t('automations.tool.oneFlow')}</MenuItem>
              </Select>
            </FormControl>
            {config.mode === 'llm-gate' ? (
              <FormControl fullWidth required disabled={loadingModels || modelsError}>
                <InputLabel id="gate-model-label">{t('automations.tool.modelChecker')}</InputLabel>
                <Select labelId="gate-model-label" label={t('automations.tool.modelChecker')}
                  value={models.some(m => m.id === config.modelId) ? config.modelId : ''}
                  onChange={e => onChange({ ...config, modelId: e.target.value })}>
                  {models.length === 0 && <MenuItem value="" disabled>
                    {t(loadingModels ? 'common.loading' : 'automations.tool.noModels')}
                  </MenuItem>}
                  {models.map(m => <MenuItem key={m.id} value={m.id}>{m.displayName || m.name}</MenuItem>)}
                </Select>
              </FormControl>
            ) : (
              <FormControl fullWidth required disabled={loadingFlows}>
                <InputLabel id="gate-flow-label">{t('automations.tool.flowChecker')}</InputLabel>
                <Select labelId="gate-flow-label" label={t('automations.tool.flowChecker')}
                  value={flows.some(f => f.id === config.flowId) ? config.flowId : ''}
                  onChange={e => onChange({ ...config, flowId: e.target.value })}>
                  {flows.length === 0 && <MenuItem value="" disabled>
                    {t(loadingFlows ? 'common.loading' : 'automations.tool.noFlows')}
                  </MenuItem>}
                  {flows.map(f => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
                </Select>
              </FormControl>
            )}
            <TextField label={t('automations.tool.maxChecks')} type="number" value={config.maxCallsPerDay ?? 500}
              onChange={e => onChange({ ...config, maxCallsPerDay: Number(e.target.value) })}
              slotProps={{ htmlInput: { min: 1, step: 1 } }} helperText={t('automations.tool.costGuard')} />
          </Box>
          {modelsError && config.mode === 'llm-gate' && (
            <Alert severity="error" sx={{ mt: 1 }} action={<Button color="inherit" onClick={() => setRetry(value => value + 1)}>
              {t('common.tryAgain')}
            </Button>}>{t('automations.gate.loadModelsFailed')}</Alert>
          )}
          {missingChecker && <Alert severity="warning" sx={{ mt: 1 }}>{t('automations.gate.missingChecker')}</Alert>}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t(config.mode === 'flow-gate' ? 'automations.gate.flowHelp' : 'automations.gate.modelHelp')}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {t('automations.gate.manualHelp')}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

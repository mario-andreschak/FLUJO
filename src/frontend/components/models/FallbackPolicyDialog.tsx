'use client';

import { useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, IconButton, MenuItem, Paper, Stack, TextField, Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { Model } from '@/shared/types/model';
import {
  DEFAULT_FALLBACK_TRIGGERS, MAX_FALLBACK_MODELS, validateFallbackPolicy, type FallbackTrigger,
} from '@/shared/types/model/fallbackPolicy';
import type { ModelResult } from '@/frontend/services/model';
import { useI18n } from '@/frontend/contexts/I18nContext';
import AllowanceBar from '@/frontend/components/shared/AllowanceBar';

export default function FallbackPolicyDialog({ model, models, onSave, onClose }: {
  model: Model;
  models: Model[];
  onSave: (model: Model) => Promise<ModelResult>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(model.displayName ?? '');
  const [alias, setAlias] = useState(model.name.replace(/^policy\//, ''));
  const [ids, setIds] = useState(model.fallbackPolicy?.modelIds ?? []);
  const [triggers, setTriggers] = useState<FallbackTrigger[]>(model.fallbackPolicy?.triggers ?? DEFAULT_FALLBACK_TRIGGERS);
  const [cooldown, setCooldown] = useState(model.fallbackPolicy?.cooldownSeconds ?? 60);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const available = models.filter(item => !item.fallbackPolicy && item.id !== model.id && !ids.includes(item.id));
  const move = (index: number, direction: number) => {
    const next = [...ids];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setIds(next);
  };
  const save = async () => {
    const draft: Model = {
      id: model.id, name: `policy/${alias}`, displayName: name.trim(), ApiKey: '',
      folder: model.folder, favorite: model.favorite,
      fallbackPolicy: { modelIds: ids, triggers, cooldownSeconds: cooldown },
    };
    const invalid = validateFallbackPolicy(draft, models);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(undefined);
    try {
      const result = await onSave(draft);
      if (!result.success) setError(result.error ?? t('models.saveFailed'));
    } catch {
      setError(t('models.saveFailed'));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="fallback-policy-title">
      <DialogTitle id="fallback-policy-title">{t('models.policy.title')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Typography color="text.secondary">{t('models.policy.description')}</Typography>
          <AllowanceBar modelIds={ids} />
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label={t('models.policy.name')} value={name} onChange={event => setName(event.target.value)} fullWidth disabled={saving} />
          <TextField label={t('models.policy.alias')} value={alias} onChange={event => setAlias(event.target.value)}
            placeholder="production" helperText={`policy/${alias || 'production'}`} fullWidth disabled={saving} />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('models.policy.order')}</Typography>
            <Stack spacing={1}>
              {ids.map((id, index) => {
                const member = models.find(item => item.id === id);
                return <Paper key={id} variant="outlined" sx={{ p: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip label={index + 1} size="small" color={index === 0 ? 'primary' : 'default'} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600} noWrap>{member?.displayName || member?.name || id}</Typography>
                    <Typography variant="caption" color="text.secondary">{index === 0 ? t('models.policy.primary') : t('models.policy.backup')}</Typography>
                  </Box>
                  <IconButton aria-label={t('models.policy.up')} size="small" disabled={saving || index === 0} onClick={() => move(index, -1)}><ArrowUpwardIcon fontSize="small" /></IconButton>
                  <IconButton aria-label={t('models.policy.down')} size="small" disabled={saving || index === ids.length - 1} onClick={() => move(index, 1)}><ArrowDownwardIcon fontSize="small" /></IconButton>
                  <IconButton aria-label={t('models.policy.remove')} size="small" disabled={saving} onClick={() => setIds(ids.filter(item => item !== id))}><DeleteOutlineIcon fontSize="small" /></IconButton>
                </Paper>;
              })}
              <TextField select label={t('models.policy.addModel')} value="" fullWidth disabled={saving || !available.length || ids.length >= MAX_FALLBACK_MODELS}
                onChange={event => setIds([...ids, event.target.value])}>
                {available.map(item => <MenuItem key={item.id} value={item.id}>{item.displayName || item.name}</MenuItem>)}
              </TextField>
            </Stack>
          </Box>
          <Box>
            <Typography variant="subtitle2">{t('models.policy.triggers')}</Typography>
            {DEFAULT_FALLBACK_TRIGGERS.map(trigger => <FormControlLabel key={trigger}
              label={t(`models.policy.trigger.${trigger}`)}
              control={<Checkbox checked={triggers.includes(trigger)} disabled={saving} onChange={(_, checked) =>
                setTriggers(checked ? [...triggers, trigger] : triggers.filter(item => item !== trigger))} />} />)}
          </Box>
          <TextField label={t('models.policy.cooldown')} type="number" value={cooldown}
            helperText={t('models.policy.cooldownHelp')} disabled={saving} inputProps={{ min: 0, max: 3600 }}
            onChange={event => setCooldown(Number(event.target.value))} />
          <Alert severity="info">{t('models.policy.replay')}</Alert>
          <Typography variant="caption" color="text.secondary">{t('models.policy.apiHelp')}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={saving || ids.length < 2 || !alias || !triggers.length} onClick={() => void save()}>{t('models.modal.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

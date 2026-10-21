'use client';

import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { HarnessCase } from '@/shared/types/harness';
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function CaseEditor({ cases, disabled, onChange }: {
  cases: HarnessCase[]; disabled: boolean; onChange: (cases: HarnessCase[]) => void;
}) {
  const { t } = useI18n();
  const update = (index: number, change: Partial<HarnessCase>) => onChange(cases.map((item, i) => i === index ? { ...item, ...change } : item));
  return <Stack spacing={2}>
    <Typography variant="h6" component="h3">{t('harness.examples')}</Typography>
    <Typography variant="body2" color="text.secondary">{t('harness.examplesHelp')}</Typography>
    {cases.map((example, index) => <Box key={example.id} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography sx={{ flex: 1 }}>{index + 1}</Typography>
          <TextField select label={t('harness.examples')} value={example.split} size="small" disabled={disabled}
            onChange={event => update(index, { split: event.target.value as HarnessCase['split'] })}>
            <MenuItem value="train">{t('harness.train')}</MenuItem><MenuItem value="holdout">{t('harness.holdout')}</MenuItem>
          </TextField>
          <Button disabled={disabled || cases.length <= 4} onClick={() => onChange(cases.filter((_, i) => i !== index))}>{t('harness.remove')}</Button>
        </Stack>
        <TextField fullWidth multiline minRows={2} label={t('harness.input')} value={example.input} disabled={disabled} onChange={event => update(index, { input: event.target.value })} />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField fullWidth multiline minRows={2} label={t('harness.required')} value={example.required.join('\n')} disabled={disabled}
            onChange={event => update(index, { required: event.target.value.split('\n') })} />
          <TextField fullWidth multiline minRows={2} label={t('harness.forbidden')} value={example.forbidden.join('\n')} disabled={disabled}
            onChange={event => update(index, { forbidden: event.target.value.split('\n') })} />
        </Stack>
      </Stack>
    </Box>)}
    <Button disabled={disabled || cases.length >= 12} onClick={() => onChange([...cases, {
      id: crypto.randomUUID(), split: 'train', input: '', required: [], forbidden: [],
    }])}>{t('harness.addExample')}</Button>
  </Stack>;
}

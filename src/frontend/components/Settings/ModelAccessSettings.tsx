'use client';

import { Alert, Box, FormControl, FormControlLabel, Switch, Typography } from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** Per-workspace switches for reaching a model without a saved flow. */
export default function ModelAccessSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  const access = {
    directModelCalls: settings.modelAccess?.directModelCalls !== false,
    quickChat: settings.modelAccess?.quickChat !== false,
  };
  const update = (patch: Partial<typeof access>) =>
    updateSettings({ ...settings, modelAccess: { ...access, ...patch } });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FormControl component="fieldset">
        <FormControlLabel
          control={
            <Switch
              checked={access.directModelCalls}
              onChange={(event) => update({ directModelCalls: event.target.checked })}
            />
          }
          label={t('settings.modelAccess.directLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.modelAccess.directDescription')}
        </Typography>
      </FormControl>

      <FormControl component="fieldset">
        <FormControlLabel
          control={
            <Switch
              checked={access.quickChat}
              onChange={(event) => update({ quickChat: event.target.checked })}
            />
          }
          label={t('settings.modelAccess.quickLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.modelAccess.quickDescription')}
        </Typography>
      </FormControl>

      <Alert severity="info">{t('settings.modelAccess.limit')}</Alert>
    </Box>
  );
}

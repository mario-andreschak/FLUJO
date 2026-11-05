'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  isValidRetentionDays,
  type ConversationRetentionPrecedence,
  type ConversationRetentionReport,
  type ConversationRetentionSettings as RetentionSettings,
  type ConversationRetentionStatus,
} from '@/shared/types/conversationRetention';

const keptTotal = (report: ConversationRetentionReport) =>
  Object.values(report.kept).reduce((sum, count) => sum + (count ?? 0), 0);

/** How long stored conversations are kept in this workspace. Off by default. */
export default function ConversationRetentionSettings() {
  const { settings, updateSettings } = useStorage();
  const { t, tp } = useI18n();
  const retention: RetentionSettings = settings.conversationRetention ?? {};
  const [daysText, setDaysText] = useState(retention.days ? String(retention.days) : '');
  const [status, setStatus] = useState<ConversationRetentionStatus | null>(null);
  const [dryRun, setDryRun] = useState<ConversationRetentionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/conversation-retention', { headers: { Accept: 'application/json' } });
      if (response.ok) setStatus(await response.json() as ConversationRetentionStatus);
    } catch {
      // The last-run line is a convenience. The settings still work without it.
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = (patch: Partial<RetentionSettings>) => updateSettings({
    ...settings,
    conversationRetention: { ...retention, ...patch },
  });

  const parsedDays = daysText.trim() === '' ? 0 : Number(daysText);
  const daysValid = isValidRetentionDays(parsedDays);
  const onDaysChange = (value: string) => {
    setDaysText(value);
    setDryRun(null);
    const next = value.trim() === '' ? 0 : Number(value);
    if (isValidRetentionDays(next)) void save({ days: next });
  };

  const checkHowMany = async () => {
    setChecking(true);
    setFailed(false);
    try {
      const response = await fetch('/api/conversation-retention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dry-run',
          settings: { days: daysValid ? parsedDays : 0, precedence: retention.precedence ?? 'shorter' },
        }),
      });
      if (!response.ok) throw new Error();
      const report = await response.json() as ConversationRetentionReport;
      if (report.error) throw new Error();
      setDryRun(report);
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const lastRun = status?.lastRun;
  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={(
            <Switch
              checked={retention.enabled === true}
              onChange={event => { void save({ enabled: event.target.checked }); }}
              name="conversationRetentionEnabled"
            />
          )}
          label={t('settings.conversationRetention.enabledLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.conversationRetention.enabledDescription')}
        </Typography>
      </FormControl>

      <Stack spacing={2} sx={{ mb: 2, maxWidth: 480 }}>
        <TextField
          label={t('settings.conversationRetention.daysLabel')}
          type="number"
          size="small"
          value={daysText}
          error={!daysValid}
          helperText={t('settings.conversationRetention.daysHelp')}
          slotProps={{ htmlInput: { min: 1, step: 1 } }}
          onChange={event => onDaysChange(event.target.value)}
        />
        <FormControl size="small">
          <InputLabel id="conversation-retention-precedence">{t('settings.conversationRetention.precedenceLabel')}</InputLabel>
          <Select
            labelId="conversation-retention-precedence"
            label={t('settings.conversationRetention.precedenceLabel')}
            value={retention.precedence ?? 'shorter'}
            onChange={event => {
              setDryRun(null);
              void save({ precedence: event.target.value as ConversationRetentionPrecedence });
            }}
          >
            <MenuItem value="shorter">{t('settings.conversationRetention.precedenceShorter')}</MenuItem>
            <MenuItem value="flow">{t('settings.conversationRetention.precedenceFlow')}</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>{t('settings.conversationRetention.keptNote')}</Alert>

      <Button variant="outlined" onClick={() => { void checkHowMany(); }} disabled={checking || !daysValid} sx={{ mb: 2 }}>
        {t('settings.conversationRetention.dryRunButton')}
      </Button>
      {failed && <Alert severity="error" sx={{ mb: 2 }}>{t('settings.conversationRetention.dryRunFailed')}</Alert>}
      {dryRun && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {tp('settings.conversationRetention.dryRunResult', dryRun.deleted)}
          {' '}
          {t('settings.conversationRetention.dryRunKept', { kept: keptTotal(dryRun), records: dryRun.runRecordsCleared })}
        </Alert>
      )}
      {lastRun && (
        <Typography variant="body2" color="text.secondary">
          {t('settings.conversationRetention.lastRun', {
            date: new Date(lastRun.finishedAt).toLocaleString(),
            deleted: lastRun.deleted,
            kept: keptTotal(lastRun),
            failed: lastRun.failed,
          })}
        </Typography>
      )}
    </Box>
  );
}

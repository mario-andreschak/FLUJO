'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import type {
  RuntimeEnvironmentCategory,
  RuntimeEnvironmentDefinition,
} from '@/shared/runtimeEnvironment';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface RuntimeEnvironmentResponse {
  definitions: RuntimeEnvironmentDefinition[];
  configured: Record<string, string>;
  active: Record<string, string>;
  file: string;
  restartRequired: boolean;
}

const CATEGORIES: Array<RuntimeEnvironmentCategory | 'all'> = [
  'all', 'runtime', 'performance', 'migration', 'mcpApps', 'access', 'bash', 'browser', 'integration',
];

export default function RuntimeEnvironmentSettings() {
  const { t } = useI18n();
  const [data, setData] = useState<RuntimeEnvironmentResponse>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [category, setCategory] = useState<RuntimeEnvironmentCategory | 'all'>('runtime');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string }>();

  const load = async () => {
    const response = await fetch('/api/runtime-environment', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || t('settings.runtimeEnv.loadFailed'));
    setData(body);
    setValues(body.configured);
  };

  useEffect(() => {
    void load().catch((error) => setMessage({
      severity: 'error',
      text: error instanceof Error ? error.message : t('settings.runtimeEnv.loadFailed'),
    }));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.definitions ?? []).filter((definition) =>
      (category === 'all' || definition.category === category)
      && (!needle
        || definition.name.toLowerCase().includes(needle)
        || definition.description.toLowerCase().includes(needle)),
    );
  }, [category, data?.definitions, query]);

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await fetch('/api/runtime-environment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('settings.runtimeEnv.saveFailed'));
      await load();
      setMessage({ severity: 'success', text: t('settings.runtimeEnv.saved') });
    } catch (error) {
      setMessage({
        severity: 'error',
        text: error instanceof Error ? error.message : t('settings.runtimeEnv.saveFailed'),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!data && !message) return <CircularProgress size={28} />;

  return (
    <Stack spacing={2.5}>
      <Alert severity="info">{t('settings.runtimeEnv.help')}</Alert>
      {data?.restartRequired && <Alert severity="warning">{t('settings.runtimeEnv.restartRequired')}</Alert>}
      {message && <Alert severity={message.severity}>{message.text}</Alert>}

      {data && (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {t('settings.runtimeEnv.file')}: {data.file}
        </Typography>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <FormControl size="small" sx={{ minWidth: 190 }}>
          <InputLabel>{t('settings.runtimeEnv.category')}</InputLabel>
          <Select
            value={category}
            label={t('settings.runtimeEnv.category')}
            onChange={(event) => setCategory(event.target.value as RuntimeEnvironmentCategory | 'all')}
          >
            {CATEGORIES.map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          label={t('settings.runtimeEnv.search')}
        />
      </Stack>

      <Stack spacing={1.5}>
        {visible.map((definition) => {
          const active = data?.active[definition.name];
          const configured = values[definition.name] ?? '';
          return (
            <Box key={definition.name} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography component="label" htmlFor={`runtime-env-${definition.name}`} fontFamily="monospace" fontWeight={700}>
                  {definition.name}
                </Typography>
                {active !== undefined && <Chip size="small" variant="outlined" label={t('settings.runtimeEnv.active')} />}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
                {definition.description}
              </Typography>
              <TextField
                id={`runtime-env-${definition.name}`}
                size="small"
                fullWidth
                type={definition.sensitive ? 'password' : 'text'}
                value={configured}
                placeholder={active === undefined ? t('settings.runtimeEnv.unset') : `${t('settings.runtimeEnv.active')}: ${active}`}
                onChange={(event) => setValues((current) => ({ ...current, [definition.name]: event.target.value }))}
                slotProps={{ htmlInput: { spellCheck: false } }}
              />
            </Box>
          );
        })}
      </Stack>

      <Stack direction="row" justifyContent="flex-end">
        <Button variant="contained" startIcon={saving ? <CircularProgress size={18} /> : <SaveRoundedIcon />} disabled={saving || !data} onClick={() => void save()}>
          {t('settings.runtimeEnv.save')}
        </Button>
      </Stack>
    </Stack>
  );
}

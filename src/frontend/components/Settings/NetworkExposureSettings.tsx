'use client';

import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from 'react';
import {
  Alert,
  Box,
  FormControlLabel,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ComputerRoundedIcon from '@mui/icons-material/ComputerRounded';
import LanRoundedIcon from '@mui/icons-material/LanRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { ExposureMode } from '@/shared/types/storage';

const OPTIONS: Array<{
  value: ExposureMode;
  labelKey: 'settings.network.localhost' | 'settings.network.localNetwork' | 'settings.network.public';
  descriptionKey: 'settings.network.localhostDescription' | 'settings.network.localNetworkDescription' | 'settings.network.publicDescription';
  icon: typeof ComputerRoundedIcon;
}> = [
  {
    value: 'localhost',
    labelKey: 'settings.network.localhost',
    descriptionKey: 'settings.network.localhostDescription',
    icon: ComputerRoundedIcon,
  },
  {
    value: 'network',
    labelKey: 'settings.network.localNetwork',
    descriptionKey: 'settings.network.localNetworkDescription',
    icon: LanRoundedIcon,
  },
  {
    value: 'public',
    labelKey: 'settings.network.public',
    descriptionKey: 'settings.network.publicDescription',
    icon: PublicRoundedIcon,
  },
];

interface RuntimeExposure {
  active: ExposureMode;
  installMode: 'git' | 'container' | 'npm';
}

function isExposureMode(value: unknown): value is ExposureMode {
  return value === 'localhost' || value === 'network' || value === 'public';
}

export default function NetworkExposureSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  const [runtime, setRuntime] = useState<RuntimeExposure | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/network-exposure', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`network exposure returned ${response.status}`);
        return response.json() as Promise<RuntimeExposure>;
      })
      .then(value => {
        if (isExposureMode(value.active)) setRuntime(value);
      })
      .catch(error => {
        if ((error as Error).name !== 'AbortError') setRuntime(null);
      });
    return () => controller.abort();
  }, []);

  const selected = isExposureMode(settings.network?.exposure)
    ? settings.network.exposure
    : runtime?.active ?? 'localhost';
  const selectedOption = useMemo(
    () => OPTIONS.find(option => option.value === selected) ?? OPTIONS[0],
    [selected],
  );
  const pendingRestart = Boolean(runtime && runtime.active !== selected);

  const persist = (value: ExposureMode) => {
    void updateSettings({
      ...settings,
      network: { exposure: value },
    });
  };

  const allowAll = settings.network?.allowAllMcpAppContent === true;
  const toggleAllowAll = (_event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
    void updateSettings({
      ...settings,
      network: { ...settings.network, allowAllMcpAppContent: checked },
    });
  };

  const choose = (_event: MouseEvent<HTMLElement>, value: ExposureMode | null) => {
    if (!value || value === selected) return;
    persist(value);
  };

  const SelectedIcon = selectedOption.icon;

  return (
    <Stack spacing={2.5}>
      <Typography color="text.secondary">
        {t('settings.network.help')}
      </Typography>

      <ToggleButtonGroup
        value={selected}
        exclusive
        fullWidth
        onChange={choose}
        aria-label={t('settings.network.aria')}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          gap: 1.5,
          '& .MuiToggleButtonGroup-grouped': {
            m: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: '12px !important',
          },
        }}
      >
        {OPTIONS.map(option => {
          const Icon = option.icon;
          return (
            <ToggleButton
              key={option.value}
              value={option.value}
              aria-label={t(option.labelKey)}
              onClick={() => {
                // Persist a legacy-inferred mode even when the user keeps the
                // currently selected card.
                if (!settings.network && option.value === selected) persist(option.value);
              }}
              sx={{
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                minHeight: 150,
                p: 2,
                textAlign: 'left',
                textTransform: 'none',
              }}
            >
              <Stack spacing={1}>
                <Icon color="primary" />
                <Typography fontWeight={750}>{t(option.labelKey)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(option.descriptionKey)}
                </Typography>
              </Stack>
            </ToggleButton>
          );
        })}
      </ToggleButtonGroup>

      <Box>
        <Alert
          severity={selected === 'public' ? 'error' : selected === 'network' ? 'warning' : 'info'}
          icon={<SelectedIcon fontSize="inherit" />}
        >
          {t(
            selected === 'public'
              ? 'settings.network.publicWarning'
              : selected === 'network'
                ? 'settings.network.networkWarning'
                : 'settings.network.localhostInfo',
          )}
        </Alert>
      </Box>

      {pendingRestart && (
        <Alert severity="success">{t('settings.network.restartRequired')}</Alert>
      )}

      {runtime?.installMode === 'container' && selected !== 'localhost' && (
        <Alert severity="warning">{t('settings.network.containerPorts')}</Alert>
      )}

      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={allowAll}
              onChange={toggleAllowAll}
              color="warning"
            />
          }
          label={
            <Stack spacing={0.5}>
              <Typography fontWeight={600}>
                {t('settings.network.allowAllMcpAppContent')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('settings.network.allowAllMcpAppContentDescription')}
              </Typography>
            </Stack>
          }
        />
        {allowAll && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {t('settings.network.allowAllMcpAppContentWarning')}
          </Alert>
        )}
      </Box>
    </Stack>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Alert, Box, Divider, FormControl, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { mcpService } from '@/frontend/services/mcp';

interface ServerEntry { name: string; alwaysOn?: boolean; disabled?: boolean }

/** How tool servers start: all at launch or on first use, and which stay running. */
export default function McpStartupSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [environmentValue, setEnvironmentValue] = useState<string>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    mcpService.loadServerConfigs().then((configs: unknown) => {
      if (!cancelled && Array.isArray(configs)) setServers((configs as ServerEntry[]).filter(server => !server.disabled));
    });
    fetch('/api/runtime-environment')
      .then(response => (response.ok ? response.json() : undefined))
      .then((data?: { active?: Record<string, string> }) => {
        if (!cancelled) setEnvironmentValue(data?.active?.FLUJO_MCP_LAZY_START?.trim() || undefined);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const setAlwaysOn = async (name: string, alwaysOn: boolean) => {
    setFailed(undefined);
    setServers(current => current.map(server => (server.name === name ? { ...server, alwaysOn } : server)));
    const result = await mcpService.updateServerConfig(name, { alwaysOn });
    if (!('success' in result && result.success)) {
      setServers(current => current.map(server => (server.name === name ? { ...server, alwaysOn: !alwaysOn } : server)));
      setFailed(name);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FormControl component="fieldset">
        <FormControlLabel
          control={
            <Switch
              checked={settings.mcp?.lazyStart === true}
              disabled={environmentValue !== undefined}
              onChange={(event) => updateSettings({ ...settings, mcp: { ...settings.mcp, lazyStart: event.target.checked } })}
            />
          }
          label={t('settings.mcpStartup.lazyLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.mcpStartup.lazyDescription')}
        </Typography>
      </FormControl>
      {environmentValue !== undefined && (
        <Alert severity="info">{t('settings.mcpStartup.environmentOverride', { value: environmentValue })}</Alert>
      )}

      <Divider />
      <Typography variant="subtitle2">{t('settings.mcpStartup.alwaysOnTitle')}</Typography>
      <Typography variant="body2" color="text.secondary">{t('settings.mcpStartup.alwaysOnDescription')}</Typography>
      {servers.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t('settings.mcpStartup.noServers')}</Typography>
      ) : (
        <Stack spacing={0.5}>
          {servers.map(server => (
            <FormControlLabel
              key={server.name}
              control={<Switch size="small" checked={server.alwaysOn === true} onChange={(event) => void setAlwaysOn(server.name, event.target.checked)} />}
              label={server.name}
            />
          ))}
        </Stack>
      )}
      {failed && <Alert severity="error">{t('settings.mcpStartup.saveFailed', { server: failed })}</Alert>}
    </Box>
  );
}

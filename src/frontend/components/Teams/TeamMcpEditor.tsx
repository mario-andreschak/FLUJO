'use client';

import { Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { SharedMcpDocument } from '@/frontend/services/teams';

type Configuration = SharedMcpDocument['mcp'];
type Props = { value: SharedMcpDocument; disabled: boolean; onChange: (value: SharedMcpDocument) => void; };

/** This form has no connection, install, OAuth or private server save actions. */
export default function TeamMcpEditor({ value, disabled, onChange }: Props) {
  const { t } = useI18n(); const config = value.mcp;
  const update = (fields: Partial<Configuration>) => onChange({ ...value, mcp: { ...config, ...fields } });
  const changeTransport = (transport: Configuration['transport']) => {
    const mcp: Configuration = { name: config.name, transport };
    if (transport === 'stdio') { mcp.command = ''; mcp.args = []; }
    else if (transport === 'websocket') mcp.websocketUrl = '';
    else mcp.serverUrl = config.serverUrl ?? '';
    onChange({ ...value, mcp });
  };
  const list = (field: 'args' | 'environmentKeys' | 'headerNames', limit: number, maxLength: number) => {
    const values = config[field] ?? [];
    return <Stack spacing={1}>
      <Typography>{t(`teams.mcp.${field}`)}</Typography>
      {values.map((item, index) => <Stack key={index} direction="row" spacing={1}>
        <TextField fullWidth label={`${t(`teams.mcp.${field}`)} ${index + 1}`} value={item} disabled={disabled}
          slotProps={{ htmlInput: { maxLength } }} onChange={event => update({ [field]: values.map((value, position) => position === index ? event.target.value : value) })} />
        <Button disabled={disabled} aria-label={`${t('teams.mcp.remove')} ${t(`teams.mcp.${field}`)} ${index + 1}`}
          onClick={() => update({ [field]: values.filter((_, position) => position !== index) })}>{t('teams.mcp.remove')}</Button>
      </Stack>)}
      <Button disabled={disabled || values.length >= limit} onClick={() => update({ [field]: [...values, ''] })}>{t('teams.mcp.add')} {t(`teams.mcp.${field}`)}</Button>
    </Stack>;
  };
  return <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}>
    <TextField label={t('teams.mcp.name')} value={config.name} disabled={disabled} slotProps={{ htmlInput: { maxLength: 120 } }} onChange={event => update({ name: event.target.value })} />
    <TextField select label={t('teams.mcp.transport')} value={config.transport} disabled={disabled} onChange={event => changeTransport(event.target.value as Configuration['transport'])}>
      {(['stdio', 'streamable', 'sse', 'websocket'] as const).map(transport => <MenuItem key={transport} value={transport}>{transport}</MenuItem>)}
    </TextField>
    <Typography color="text.secondary">{t('teams.mcp.transportNote')}</Typography>
    {config.transport === 'stdio' ? <>
      <TextField label={t('teams.mcp.command')} value={config.command ?? ''} disabled={disabled} slotProps={{ htmlInput: { maxLength: 2048 } }} onChange={event => update({ command: event.target.value })} />
      {list('args', 256, 8192)}{list('environmentKeys', 64, 128)}
    </> : config.transport === 'websocket' ?
      <TextField label={t('teams.mcp.endpoint')} value={config.websocketUrl ?? ''} disabled={disabled} slotProps={{ htmlInput: { maxLength: 2048 } }} onChange={event => update({ websocketUrl: event.target.value })} /> : <>
        <TextField label={t('teams.mcp.endpoint')} value={config.serverUrl ?? ''} disabled={disabled} slotProps={{ htmlInput: { maxLength: 2048 } }} onChange={event => update({ serverUrl: event.target.value })} />
        {list('headerNames', 64, 128)}
      </>}
    <Typography color="text.secondary">{t('teams.mcp.privateInputs')}</Typography>
  </Stack></Paper>;
}

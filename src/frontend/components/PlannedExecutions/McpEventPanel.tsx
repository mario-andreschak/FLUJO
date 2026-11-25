"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { McpEventTriggerConfig, mcpEventSource, type McpEventSource } from '@/shared/types/plannedExecution';
import { mcpService, type McpEventEntry } from '@/frontend/services/mcp';
import SchemaParamsForm from '@/frontend/components/shared/SchemaParamsForm';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** Accepts a bare id or a pasted chat link (`/chat?conversation=<id>`). */
export function conversationIdFromInput(value: string): string {
  const text = value.trim();
  if (!text.includes('conversation=')) return text;
  try {
    return new URL(text, 'http://localhost').searchParams.get('conversation')?.trim() ?? text;
  } catch {
    return text;
  }
}

interface McpEventPanelProps {
  config: McpEventTriggerConfig;
  onChange: (config: McpEventTriggerConfig) => void;
}

/**
 * "When a tool server reports an event": pick a server and one of its events.
 * FLUJO subscribes on save and keeps the subscription fresh.
 */
const McpEventPanel = ({ config, onChange }: McpEventPanelProps) => {
  const { t } = useI18n();
  const [servers, setServers] = useState<string[]>([]);
  const [events, setEvents] = useState<McpEventEntry[]>([]);
  const [supported, setSupported] = useState(true);
  const [channel, setChannel] = useState(true);
  const [loading, setLoading] = useState(false);
  const source = mcpEventSource(config);
  const isChannel = source === 'claude-channel';

  useEffect(() => {
    let cancelled = false;
    mcpService.loadServerConfigs().then((configs: unknown) => {
      if (cancelled || !Array.isArray(configs)) return;
      setServers((configs as Array<{ name: string; disabled?: boolean }>).filter(c => !c.disabled).map(c => c.name));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!config.serverName) {
      setEvents([]);
      setSupported(true);
      setChannel(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    mcpService.listServerEvents(config.serverName)
      .then(result => {
        if (cancelled) return;
        setEvents(result.events);
        setSupported(result.supported);
        setChannel(result.channel);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [config.serverName]);

  const selected = events.find(event => event.name === config.eventName);

  return (
    <Box sx={{ mt: 1 }}>
      <FormControl fullWidth margin="normal">
        <InputLabel id="mcp-event-source-label">{t('automations.event.sourceKind')}</InputLabel>
        <Select
          labelId="mcp-event-source-label"
          label={t('automations.event.sourceKind')}
          value={source}
          onChange={(e) => {
            const next = e.target.value as McpEventSource;
            onChange({ ...config, source: next === 'events' ? undefined : next, eventName: '', arguments: {} });
          }}
        >
          <MenuItem value="events">{t('automations.event.sourceEvents')}</MenuItem>
          <MenuItem value="claude-channel">{t('automations.event.sourceChannel')}</MenuItem>
        </Select>
      </FormControl>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 220, flex: 1 }} margin="normal">
          <InputLabel id="mcp-event-server-label">{t('automations.tool.server')}</InputLabel>
          <Select
            labelId="mcp-event-server-label"
            label={t('automations.tool.server')}
            value={servers.includes(config.serverName) ? config.serverName : ''}
            onChange={(e) => onChange({ ...config, serverName: e.target.value, eventName: '', arguments: {} })}
          >
            {servers.map(name => <MenuItem key={name} value={name}>{name}</MenuItem>)}
          </Select>
        </FormControl>
        {!isChannel && (
          <FormControl sx={{ minWidth: 220, flex: 1 }} margin="normal" disabled={!config.serverName || !supported}>
            <InputLabel id="mcp-event-name-label">{t('automations.event.event')}</InputLabel>
            <Select
              labelId="mcp-event-name-label"
              label={t('automations.event.event')}
              value={selected ? config.eventName : ''}
              onChange={(e) => onChange({ ...config, eventName: e.target.value, arguments: {} })}
            >
              {events.map(event => <MenuItem key={event.name} value={event.name}>{event.name}</MenuItem>)}
            </Select>
          </FormControl>
        )}
        {loading && <CircularProgress size={20} sx={{ alignSelf: 'center' }} />}
      </Box>

      {!isChannel && config.serverName && !loading && !supported && (
        <Alert severity="warning" sx={{ mt: 1 }}>{t('automations.event.unsupported')}</Alert>
      )}
      {isChannel && config.serverName && !loading && !channel && (
        <Alert severity="warning" sx={{ mt: 1 }}>{t('automations.event.channelUnsupported')}</Alert>
      )}
      {isChannel && (
        <Alert severity="warning" sx={{ mt: 1 }} data-testid="mcp-event-channel-no-guarantee">
          {t('automations.event.channelNoGuarantee')}
        </Alert>
      )}
      {!isChannel && selected?.description && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{selected.description}</Typography>
      )}
      {!isChannel && selected?.inputSchema && (
        <Box sx={{ my: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>{t('automations.event.filter')}</Typography>
          <SchemaParamsForm
            schema={selected.inputSchema}
            values={config.arguments || {}}
            onChange={(args) => onChange({ ...config, arguments: args })}
          />
        </Box>
      )}
      <TextField
        fullWidth
        margin="normal"
        label={t('automations.event.steerLabel')}
        placeholder={t('automations.event.steerPlaceholder')}
        helperText={t('automations.event.steerHelp')}
        value={config.steerConversationId ?? ''}
        onChange={(e) => {
          const id = conversationIdFromInput(e.target.value);
          onChange({ ...config, steerConversationId: id || undefined });
        }}
        slotProps={{ htmlInput: { 'data-testid': 'mcp-event-steer-conversation' } }}
      />
      <Alert severity="info" sx={{ mt: 2 }}>{t('automations.event.info')}</Alert>
    </Box>
  );
};

export default McpEventPanel;

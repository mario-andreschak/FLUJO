'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Chip,
  CircularProgress,
  Alert,
  Button,
  TextField,
  Stack,
} from '@mui/material';
import { mcpService } from '@/frontend/services/mcp';
import { MCPResource, MCPResourceTemplate, MCPPrompt } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';

const log = createLogger('frontend/components/mcp/MCPCapabilitiesManager');

interface MCPCapabilitiesManagerProps {
  serverName: string;
  /** Which capability to show. Defaults to both (kept for any standalone usage). */
  show?: 'resources' | 'prompts' | 'both';
}

/**
 * Browse the resources, resource templates, and prompts a connected MCP server publishes
 * (#15). This lives on the /mcp management page — the technical surface — so it uses the
 * protocol's own vocabulary. The non-technical "give this step access to…" binding lives in
 * the flow builder instead.
 */
const MCPCapabilitiesManager: React.FC<MCPCapabilitiesManagerProps> = ({ serverName, show = 'both' }) => {
  const { t, formatNumber } = useI18n();
  const showResources = show === 'both' || show === 'resources';
  const showPrompts = show === 'both' || show === 'prompts';
  const [resources, setResources] = useState<MCPResource[]>([]);
  const [resourceTemplates, setResourceTemplates] = useState<MCPResourceTemplate[]>([]);
  const [prompts, setPrompts] = useState<MCPPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Preview state: a single open preview at a time (resource read or prompt get).
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>();

  // Per-prompt argument inputs, keyed by prompt name then arg name.
  const [promptArgs, setPromptArgs] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async () => {
    if (!serverName) return;
    setIsLoading(true);
    setError(undefined);
    try {
      // Only fetch what this view shows — fetching the other capability would issue a
      // needless round-trip (and on a stale server pay a reconnect) and could surface its
      // unrelated error on this tab.
      const [res, prm] = await Promise.all([
        showResources ? mcpService.listServerResources(serverName) : Promise.resolve(null),
        showPrompts ? mcpService.listServerPrompts(serverName) : Promise.resolve(null),
      ]);
      if (res) {
        setResources(res.resources || []);
        setResourceTemplates(res.resourceTemplates || []);
      }
      if (prm) {
        setPrompts(prm.prompts || []);
      }
      setError(res?.error || prm?.error);
    } catch (e) {
      log.warn('Failed to load capabilities', e);
      setError(e instanceof Error ? e.message : t('mcp.capabilities.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [serverName, showResources, showPrompts, t]);

  useEffect(() => {
    // Reset preview when switching servers.
    setPreviewTitle(null);
    setPreviewContent('');
    setPreviewError(undefined);
    load();
  }, [load]);

  // Poll the server-status endpoint for a changing resourceListVersion (#240).
  // When the backend increments it (on a notifications/resources/list_changed event),
  // evict the frontend cache and re-fetch so the manager auto-refreshes without the
  // user clicking the Refresh button.
  useEffect(() => {
    if (!serverName || !showResources) return;
    // Start polling only after the initial load so we don't race with it.
    const intervalId = setInterval(async () => {
      try {
        const status = await mcpService.getServerStatus(serverName);
        const version = (status as { resourceListVersion?: number }).resourceListVersion ?? 0;
        const changed = mcpService.checkResourceListVersion(serverName, version);
        if (changed) {
          log.debug(`MCPCapabilitiesManager: resource list changed for ${serverName} — auto-refreshing`);
          await load();
        }
      } catch {
        // Ignore polling errors — the Refresh button is always available as a fallback.
      }
    }, 10000); // 10-second poll interval
    return () => clearInterval(intervalId);
  }, [serverName, showResources, load]);

  const handleReadResource = async (uri: string, label: string) => {
    setPreviewTitle(t('mcp.capabilities.resourceTitle', { name: label }));
    setPreviewContent('');
    setPreviewError(undefined);
    setPreviewLoading(true);
    try {
      const result = await mcpService.readResource(serverName, uri);
      if (!result.success) {
        setPreviewError(result.error || t('mcp.capabilities.readFailed'));
      } else {
        setPreviewContent(formatResourceContents(result.data, t, formatNumber));
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleGetPrompt = async (prompt: MCPPrompt) => {
    setPreviewTitle(t('mcp.capabilities.promptTitle', { name: prompt.name }));
    setPreviewContent('');
    setPreviewError(undefined);
    setPreviewLoading(true);
    try {
      const result = await mcpService.getPrompt(serverName, prompt.name, promptArgs[prompt.name]);
      if (!result.success) {
        setPreviewError(result.error || t('mcp.capabilities.promptFailed'));
      } else {
        setPreviewContent(formatPromptResult(result.data, t));
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const setPromptArg = (promptName: string, argName: string, value: string) => {
    setPromptArgs((prev) => ({
      ...prev,
      [promptName]: { ...(prev[promptName] || {}), [argName]: value },
    }));
  };

  const hasNothing =
    !isLoading &&
    !error &&
    (!showResources || (resources.length === 0 && resourceTemplates.length === 0)) &&
    (!showPrompts || prompts.length === 0);

  const heading = show === 'resources'
    ? t('mcp.capabilities.resources')
    : show === 'prompts'
      ? t('mcp.capabilities.prompts')
      : t('mcp.capabilities.both');
  const emptyText =
    show === 'resources'
      ? t('mcp.capabilities.noResources')
      : show === 'prompts'
        ? t('mcp.capabilities.noPrompts')
        : t('mcp.capabilities.none');

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h6">{heading}</Typography>
        <Button size="small" onClick={() => { mcpService.clearCapabilitiesCache(serverName); load(); }} disabled={isLoading}>
          {t('mcp.capabilities.refresh')}
        </Button>
      </Box>

      {isLoading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">{t('mcp.capabilities.loading')}</Typography>
        </Box>
      )}

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {hasNothing && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          {emptyText}
        </Typography>
      )}

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Box sx={{ flex: '1 1 360px', minWidth: 280 }}>
          {showResources && (resources.length > 0 || resourceTemplates.length > 0) && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 1 }}>{t('mcp.capabilities.resources')}</Typography>
              <List dense disablePadding>
                {resources.map((r) => (
                  <ListItemButton key={r.uri} onClick={() => handleReadResource(r.uri, r.name || r.uri)}>
                    <ListItemText
                      primary={r.name || r.uri}
                      secondary={r.description || r.uri}
                      slotProps={{ secondary: { sx: { wordBreak: 'break-all' } } }}
                    />
                    {r.mimeType && <Chip size="small" label={r.mimeType} sx={{ ml: 1 }} />}
                  </ListItemButton>
                ))}
              </List>

              {resourceTemplates.length > 0 && (
                <>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    {t('mcp.capabilities.templates')}
                  </Typography>
                  <List dense disablePadding>
                    {resourceTemplates.map((t) => (
                      <ListItemText
                        key={t.uriTemplate}
                        sx={{ pl: 2, py: 0.5 }}
                        primary={t.name || t.uriTemplate}
                        secondary={t.uriTemplate}
                        slotProps={{ secondary: { sx: { wordBreak: 'break-all' } } }}
                      />
                    ))}
                  </List>
                </>
              )}
            </>
          )}

          {showPrompts && prompts.length > 0 && (
            <>
              {show === 'both' && <Divider sx={{ my: 1 }} />}
              <Typography variant="subtitle2">{t('mcp.capabilities.prompts')}</Typography>
              <Stack spacing={1} sx={{ mt: 0.5 }}>
                {prompts.map((p) => (
                  <Box key={p.name} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.name}</Typography>
                    {p.description && (
                      <Typography variant="caption" color="text.secondary">{p.description}</Typography>
                    )}
                    {(p.arguments || []).map((arg) => (
                      <TextField
                        key={arg.name}
                        size="small"
                        fullWidth
                        margin="dense"
                        label={`${arg.name}${arg.required ? ' *' : ''}`}
                        placeholder={arg.description || ''}
                        value={promptArgs[p.name]?.[arg.name] || ''}
                        onChange={(e) => setPromptArg(p.name, arg.name, e.target.value)}
                      />
                    ))}
                    <Button size="small" sx={{ mt: 0.5 }} onClick={() => handleGetPrompt(p)}>
                      {t('mcp.capabilities.preview')}
                    </Button>
                  </Box>
                ))}
              </Stack>
            </>
          )}
        </Box>

        {previewTitle && (
          <Box sx={{ flex: '1 1 360px', minWidth: 280 }}>
            <Typography variant="subtitle2">{previewTitle}</Typography>
            {previewLoading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
                <CircularProgress size={16} />
                <Typography variant="body2">{t('mcp.capabilities.loadingPreview')}</Typography>
              </Box>
            ) : previewError ? (
              <Alert severity="error" sx={{ mt: 1 }}>{previewError}</Alert>
            ) : (
              <Box
                component="pre"
                sx={{
                  mt: 1,
                  p: 1,
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  maxHeight: 360,
                  overflow: 'auto',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {previewContent || t('mcp.capabilities.empty')}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
};

/** Render an MCP ReadResourceResult into readable text for preview. */
function formatResourceContents(
  data: unknown,
  t: Translator,
  formatNumber: (value: number) => string,
): string {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const contents = record?.contents;
  if (!Array.isArray(contents) || contents.length === 0) return t('mcp.capabilities.noContents');
  return contents
    .map((content) => {
      const entry = content && typeof content === 'object'
        ? content as Record<string, unknown>
        : {};
      if (typeof entry.text === 'string') return entry.text;
      if (typeof entry.blob === 'string') return t('mcp.capabilities.binary', {
        type: typeof entry.mimeType === 'string' ? entry.mimeType : t('mcp.capabilities.data'),
        count: formatNumber(entry.blob.length),
      });
      return JSON.stringify(content, null, 2);
    })
    .join('\n\n---\n\n');
}

/** Render an MCP GetPromptResult into readable text for preview. */
function formatPromptResult(data: unknown, t: Translator): string {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const messages = record?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return t('mcp.capabilities.noMessages');
  return messages
    .map((message) => {
      const entry = message && typeof message === 'object'
        ? message as Record<string, unknown>
        : {};
      const role = typeof entry.role === 'string' ? entry.role : 'user';
      const content = entry.content && typeof entry.content === 'object'
        ? entry.content as Record<string, unknown>
        : undefined;
      let text: string;
      if (typeof content?.text === 'string') text = content.text;
      else if (content?.type === 'resource') text = t('mcp.capabilities.embedded', {
        uri: typeof content.resource === 'object' && content.resource !== null
          && typeof (content.resource as Record<string, unknown>).uri === 'string'
          ? (content.resource as Record<string, unknown>).uri as string
          : '',
      });
      else text = JSON.stringify(content, null, 2);
      return `[${role}]\n${text}`;
    })
    .join('\n\n');
}

export default MCPCapabilitiesManager;

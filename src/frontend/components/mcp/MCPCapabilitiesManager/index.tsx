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

const log = createLogger('frontend/components/mcp/MCPCapabilitiesManager');

interface MCPCapabilitiesManagerProps {
  serverName: string;
}

/**
 * Browse the resources, resource templates, and prompts a connected MCP server publishes
 * (#15). This lives on the /mcp management page — the technical surface — so it uses the
 * protocol's own vocabulary. The non-technical "give this step access to…" binding lives in
 * the flow builder instead.
 */
const MCPCapabilitiesManager: React.FC<MCPCapabilitiesManagerProps> = ({ serverName }) => {
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
      const [res, prm] = await Promise.all([
        mcpService.listServerResources(serverName),
        mcpService.listServerPrompts(serverName),
      ]);
      setResources(res.resources || []);
      setResourceTemplates(res.resourceTemplates || []);
      setPrompts(prm.prompts || []);
      setError(res.error || prm.error);
    } catch (e) {
      log.warn('Failed to load capabilities', e);
      setError(e instanceof Error ? e.message : 'Failed to load capabilities');
    } finally {
      setIsLoading(false);
    }
  }, [serverName]);

  useEffect(() => {
    // Reset preview when switching servers.
    setPreviewTitle(null);
    setPreviewContent('');
    setPreviewError(undefined);
    load();
  }, [load]);

  const handleReadResource = async (uri: string, label: string) => {
    setPreviewTitle(`Resource: ${label}`);
    setPreviewContent('');
    setPreviewError(undefined);
    setPreviewLoading(true);
    try {
      const result = await mcpService.readResource(serverName, uri);
      if (!result.success) {
        setPreviewError(result.error || 'Failed to read resource');
      } else {
        setPreviewContent(formatResourceContents(result.data));
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleGetPrompt = async (prompt: MCPPrompt) => {
    setPreviewTitle(`Prompt: ${prompt.name}`);
    setPreviewContent('');
    setPreviewError(undefined);
    setPreviewLoading(true);
    try {
      const result = await mcpService.getPrompt(serverName, prompt.name, promptArgs[prompt.name]);
      if (!result.success) {
        setPreviewError(result.error || 'Failed to get prompt');
      } else {
        setPreviewContent(formatPromptResult(result.data));
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
    resources.length === 0 &&
    resourceTemplates.length === 0 &&
    prompts.length === 0;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h6">Resources &amp; Prompts</Typography>
        <Button size="small" onClick={() => { mcpService.clearCapabilitiesCache(serverName); load(); }} disabled={isLoading}>
          Refresh
        </Button>
      </Box>

      {isLoading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading capabilities…</Typography>
        </Box>
      )}

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {hasNothing && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          This server doesn&apos;t publish any resources or prompts.
        </Typography>
      )}

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Box sx={{ flex: '1 1 360px', minWidth: 280 }}>
          {(resources.length > 0 || resourceTemplates.length > 0) && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 1 }}>Resources</Typography>
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
                    Templates (parameterized URIs)
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

          {prompts.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography variant="subtitle2">Prompts</Typography>
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
                      Preview
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
                <Typography variant="body2">Loading…</Typography>
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
                {previewContent || '(empty)'}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
};

/** Render an MCP ReadResourceResult into readable text for preview. */
function formatResourceContents(data: any): string {
  const contents = data?.contents;
  if (!Array.isArray(contents) || contents.length === 0) return '(no contents)';
  return contents
    .map((c: any) => {
      if (typeof c.text === 'string') return c.text;
      if (typeof c.blob === 'string') return `[binary ${c.mimeType || 'data'}: ${c.blob.length} base64 chars]`;
      return JSON.stringify(c, null, 2);
    })
    .join('\n\n---\n\n');
}

/** Render an MCP GetPromptResult into readable text for preview. */
function formatPromptResult(data: any): string {
  const messages = data?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return '(no messages)';
  return messages
    .map((m: any) => {
      const role = m.role || 'user';
      const content = m.content;
      let text: string;
      if (typeof content?.text === 'string') text = content.text;
      else if (content?.type === 'resource') text = `[embedded resource: ${content.resource?.uri || ''}]`;
      else text = JSON.stringify(content, null, 2);
      return `[${role}]\n${text}`;
    })
    .join('\n\n');
}

export default MCPCapabilitiesManager;

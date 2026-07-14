"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import type { Model } from '@/shared/types/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Chat/QuickChatDialog');

/** A single server selection: whether it is on, and (when customized) the tool subset. */
interface ServerPick {
  selected: boolean;
  /** null = all tools (whole server); otherwise the explicit subset. */
  tools: Set<string> | null;
  expanded: boolean;
  /** Tool names the server exposes, loaded lazily on expand. undefined = not yet loaded. */
  available?: string[];
  loading?: boolean;
}

export interface QuickChatStartSelection {
  modelId: string;
  servers: Array<{ name: string; enabledTools?: string[] }>;
  systemPrompt?: string;
}

interface QuickChatDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the validated selection when the user starts the chat. */
  onStart: (selection: QuickChatStartSelection) => Promise<void> | void;
}

const QuickChatDialog: React.FC<QuickChatDialogProps> = ({ open, onClose, onStart }) => {
  const [models, setModels] = useState<Model[]>([]);
  const [serverNames, setServerNames] = useState<string[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [modelId, setModelId] = useState<string>('');
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [picks, setPicks] = useState<Record<string, ServerPick>>({});
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Load models + configured (non-disabled) servers when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingLists(true);
    setListError(null);
    (async () => {
      try {
        const [loadedModels, serverConfigs] = await Promise.all([
          modelService.loadModels(),
          mcpService.loadServerConfigs(),
        ]);
        if (cancelled) return;
        setModels(loadedModels);
        const names = Array.isArray(serverConfigs)
          ? serverConfigs.filter((s: any) => !s.disabled).map((s: any) => s.name as string)
          : [];
        setServerNames(names);
        // Default the model to the first available one so a user can start in two clicks.
        setModelId(prev => prev || loadedModels[0]?.id || '');
      } catch (err) {
        if (!cancelled) {
          log.warn('Failed to load models/servers for quick chat', err);
          setListError('Could not load models or servers.');
        }
      } finally {
        if (!cancelled) setLoadingLists(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Reset transient selection when the dialog is closed.
  useEffect(() => {
    if (!open) {
      setSystemPrompt('');
      setPicks({});
      setStartError(null);
      setStarting(false);
    }
  }, [open]);

  const toggleServer = useCallback((name: string) => {
    setPicks(prev => {
      const current = prev[name];
      if (current?.selected) {
        // Turning it off keeps any loaded tool list for a quick re-enable.
        return { ...prev, [name]: { ...current, selected: false } };
      }
      return { ...prev, [name]: { ...(current ?? { tools: null, expanded: false }), selected: true } };
    });
  }, []);

  const toggleExpand = useCallback(async (name: string) => {
    setPicks(prev => {
      const current = prev[name] ?? { selected: false, tools: null, expanded: false };
      return { ...prev, [name]: { ...current, expanded: !current.expanded } };
    });
    // Lazily load the server's tools the first time it is expanded.
    const existing = picks[name];
    if (!existing?.available && !existing?.loading) {
      setPicks(prev => ({ ...prev, [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), loading: true } }));
      try {
        const { tools } = await mcpService.listServerTools(name);
        const names = Array.isArray(tools) ? tools.map((t: any) => t.name).filter(Boolean) : [];
        setPicks(prev => ({
          ...prev,
          [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), available: names, loading: false },
        }));
      } catch (err) {
        log.warn(`Failed to load tools for ${name}`, err);
        setPicks(prev => ({ ...prev, [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), available: [], loading: false } }));
      }
    }
  }, [picks]);

  const toggleTool = useCallback((name: string, tool: string, available: string[]) => {
    setPicks(prev => {
      const current = prev[name] ?? { selected: true, tools: null, expanded: true };
      // Materialize the subset from "all" on first individual toggle.
      const currentSet = current.tools ?? new Set(available);
      const next = new Set(currentSet);
      if (next.has(tool)) next.delete(tool); else next.add(tool);
      // Selecting a tool implies the server is on.
      return { ...prev, [name]: { ...current, selected: true, tools: next } };
    });
  }, []);

  const canStart = Boolean(modelId) && !starting && !loadingLists;

  const handleStart = async () => {
    if (!modelId) {
      setStartError('Pick a model to chat with.');
      return;
    }
    setStarting(true);
    setStartError(null);
    const servers = serverNames
      .filter(name => picks[name]?.selected)
      .map(name => {
        const pick = picks[name];
        // A materialized subset that still equals every available tool is sent as
        // "all" (enabledTools omitted) to stay robust if the server gains tools.
        const isAll =
          !pick.tools || (pick.available && pick.tools.size === pick.available.length);
        return isAll ? { name } : { name, enabledTools: [...pick.tools!] };
      });
    try {
      await onStart({ modelId, servers, systemPrompt: systemPrompt.trim() || undefined });
    } catch (err) {
      log.warn('Quick chat failed to start', err);
      setStartError(err instanceof Error ? err.message : 'Could not start the quick chat.');
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onClose={starting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Quick Chat</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Chat with a model and, optionally, some MCP servers — no need to build and save a flow.
        </Typography>

        {listError && <Alert severity="error" sx={{ mb: 2 }}>{listError}</Alert>}

        <FormControl fullWidth size="small" sx={{ mb: 2 }} disabled={loadingLists}>
          <InputLabel id="quick-chat-model-label">Model</InputLabel>
          <Select
            labelId="quick-chat-model-label"
            label="Model"
            value={modelId}
            onChange={e => setModelId(e.target.value)}
          >
            {models.length === 0 && (
              <MenuItem value="" disabled>
                {loadingLists ? 'Loading…' : 'No models configured'}
              </MenuItem>
            )}
            {models.map(m => (
              <MenuItem key={m.id} value={m.id}>
                {m.displayName || m.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={6}
          label="System prompt (optional)"
          placeholder="e.g. You are a concise coding assistant."
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          sx={{ mb: 2 }}
        />

        <Divider sx={{ mb: 1 }} />
        <Typography variant="subtitle2" gutterBottom>
          MCP servers (optional)
        </Typography>

        {loadingLists ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : serverNames.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No connected MCP servers. You can still chat with the model alone.
          </Typography>
        ) : (
          serverNames.map(name => {
            const pick = picks[name];
            const selected = Boolean(pick?.selected);
            const available = pick?.available;
            const activeTools = pick?.tools;
            return (
              <Box key={name} sx={{ mb: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <FormControlLabel
                    sx={{ flexGrow: 1, mr: 0 }}
                    control={
                      <Checkbox size="small" checked={selected} onChange={() => toggleServer(name)} />
                    }
                    label={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body2">{name}</Typography>
                        {selected && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={
                              !activeTools
                                ? 'all tools'
                                : `${activeTools.size} tool${activeTools.size === 1 ? '' : 's'}`
                            }
                          />
                        )}
                      </Box>
                    }
                  />
                  <IconButton size="small" onClick={() => toggleExpand(name)} aria-label={`customize ${name} tools`}>
                    {pick?.expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                  </IconButton>
                </Box>
                <Collapse in={Boolean(pick?.expanded)} unmountOnExit>
                  <Box sx={{ pl: 4, pb: 1 }}>
                    {pick?.loading ? (
                      <CircularProgress size={16} />
                    ) : available && available.length > 0 ? (
                      available.map(tool => {
                        const on = activeTools ? activeTools.has(tool) : true;
                        return (
                          <FormControlLabel
                            key={tool}
                            sx={{ display: 'flex' }}
                            control={
                              <Checkbox
                                size="small"
                                checked={on}
                                onChange={() => toggleTool(name, tool, available)}
                              />
                            }
                            label={<Typography variant="caption">{tool}</Typography>}
                          />
                        );
                      })
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {available ? 'No tools reported (server may be offline).' : ''}
                      </Typography>
                    )}
                  </Box>
                </Collapse>
              </Box>
            );
          })
        )}

        {startError && <Alert severity="error" sx={{ mt: 2 }}>{startError}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={starting}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleStart}
          disabled={!canStart}
          startIcon={starting ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {starting ? 'Starting…' : 'Start chat'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default QuickChatDialog;

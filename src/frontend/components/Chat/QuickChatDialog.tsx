"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
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
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import type { Model } from '@/shared/types/model';
import { materializeFallbackPolicy } from '@/shared/types/model/fallbackPolicy';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  loadError?: boolean;
}

export interface QuickChatStartSelection {
  modelId: string;
  servers: Array<{ name: string; enabledTools?: string[] }>;
  systemPrompt?: string;
  /** Present for saved-agent conversion; omitted by the existing Quick Chat caller. */
  flowName?: string;
}

interface QuickChatDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the validated selection when the user starts the chat. */
  onStart: (selection: QuickChatStartSelection) => Promise<void> | void;
  initialModelId?: string;
  lockModelSelection?: boolean;
  initialFlowName?: string;
  flowNameLabel?: string;
  title?: string;
  helpText?: string;
  serversLabel?: string;
  noServersText?: string;
  submitLabel?: string;
  submittingLabel?: string;
  /** Saved-agent conversion only permits servers confirmed connected now. */
  connectedServersOnly?: boolean;
  /** Saved-agent authoring retains explicit app/tool selection. */
  selectApps?: boolean;
}

const QuickChatDialog: React.FC<QuickChatDialogProps> = ({
  open,
  onClose,
  onStart,
  initialModelId,
  lockModelSelection = false,
  initialFlowName,
  flowNameLabel,
  title,
  helpText,
  serversLabel,
  noServersText,
  submitLabel,
  submittingLabel,
  connectedServersOnly = false,
  selectApps = false,
}) => {
  const { t, tp } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [needsToolModel, setNeedsToolModel] = useState(false);
  const [serverNames, setServerNames] = useState<string[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const toolLoadGeneration = useRef(0);

  const [modelId, setModelId] = useState<string>('');
  const [flowName, setFlowName] = useState<string>('');
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [picks, setPicks] = useState<Record<string, ServerPick>>({});
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Ordinary chat only needs a model. Saved-agent authoring also loads apps.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingLists(true);
    setListsLoaded(false);
    setListError(null);
    (async () => {
      try {
        const [loadedModels, serverConfigs] = await Promise.all([
          modelService.tryLoadModels(),
          selectApps ? mcpService.loadServerConfigs() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        if (!Array.isArray(loadedModels) || !Array.isArray(serverConfigs)) throw new Error('Chat setup unavailable');
        const configuredNames = serverConfigs.flatMap((server) => {
          if (!server || typeof server !== 'object') return [];
          const record = server as Record<string, unknown>;
          return record.disabled !== true && typeof record.name === 'string' ? [record.name] : [];
        });
        const names = connectedServersOnly
          ? (await Promise.all(configuredNames.map(async (name) => ({
              name,
              status: await mcpService.getServerStatus(name),
            }))))
              .filter(({ status }) => status?.status === 'connected')
              .map(({ name }) => name)
          : configuredNames;
        if (cancelled) return;
        const availableModels = selectApps ? loadedModels : loadedModels.filter(model =>
          materializeFallbackPolicy(model, loadedModels).supportsTools !== false);
        setModels(availableModels);
        setNeedsToolModel(loadedModels.length > 0 && availableModels.length === 0);
        setServerNames(names);
        setListsLoaded(true);
        // Default the model to the first available one so a user can start in two clicks.
        setModelId(prev => {
          const preferred = initialModelId || prev;
          return availableModels.some(model => model.id === preferred) ? preferred : availableModels[0]?.id || '';
        });
      } catch (err) {
        if (!cancelled) {
          log.warn('Failed to load models/servers for quick chat', err);
          setListError(t('chat.quick.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoadingLists(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connectedServersOnly, initialModelId, listAttempt, open, selectApps, t]);

  // A response from a closed dialog must not replace a later session's choices.
  useEffect(() => () => { toolLoadGeneration.current += 1; }, [open]);

  // Initialize conversion defaults on open and reset transient state on close.
  useEffect(() => {
    if (open) {
      setModelId(initialModelId ?? '');
      setFlowName(initialFlowName ?? '');
      return;
    }
    setSystemPrompt('');
    setFlowName('');
    setPicks({});
    setStartError(null);
    setStarting(false);
  }, [initialFlowName, initialModelId, open]);

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

  const loadTools = useCallback(async (name: string) => {
    const generation = toolLoadGeneration.current;
    setPicks(prev => ({ ...prev, [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), loading: true, loadError: false } }));
    try {
      const { tools, error } = await mcpService.listServerTools(name);
      if (error) throw new Error('App actions unavailable');
      if (generation !== toolLoadGeneration.current) return;
      const names = tools.map((tool) => tool.name);
      setPicks(prev => ({
        ...prev,
        [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), available: names, loading: false },
      }));
    } catch (err) {
      if (generation !== toolLoadGeneration.current) return;
      log.warn(`Failed to load tools for ${name}`, err);
      setPicks(prev => ({ ...prev, [name]: { ...(prev[name] ?? { selected: false, tools: null, expanded: true }), loading: false, loadError: true } }));
    }
  }, []);

  const toggleExpand = useCallback((name: string) => {
    setPicks(prev => {
      const current = prev[name] ?? { selected: false, tools: null, expanded: false };
      return { ...prev, [name]: { ...current, expanded: !current.expanded } };
    });
    // Only a successful result is cached; a failed listing remains retryable.
    const existing = picks[name];
    if (!existing?.expanded && !existing?.available && !existing?.loading) {
      void loadTools(name);
    }
  }, [loadTools, picks]);

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

  const needsFlowName = initialFlowName !== undefined;
  const needsAi = listsLoaded && !loadingLists && !listError && models.length === 0;
  const hasSelectedModel = models.some(model => model.id === modelId);
  const canStart = hasSelectedModel
    && (!needsFlowName || Boolean(flowName.trim()))
    && !starting
    && !loadingLists
    && !listError;

  const handleStart = async () => {
    if (!modelId) {
      setStartError(t('chat.quick.pickModel'));
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
      await onStart({
        modelId,
        servers,
        systemPrompt: systemPrompt.trim() || undefined,
        ...(needsFlowName ? { flowName: flowName.trim() } : {}),
      });
    } catch (err) {
      log.warn('Quick chat failed to start', err);
      setStartError(err instanceof Error ? err.message : t('chat.quick.startFailed'));
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onClose={starting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogHeaderActions
        title={title ?? t('chat.quick.title')}
        onClose={starting ? () => undefined : onClose}
      />
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {needsAi ? t(needsToolModel ? 'chat.quick.toolModelRequired' : 'chat.quick.noModels') : (helpText ?? t('chat.quick.help'))}
        </Typography>

        {needsAi ? (
          <Button component={Link} href="/models?add=1" variant="contained" fullWidth sx={{ minHeight: 48 }}>
            {t('models.connectAi')}
          </Button>
        ) : (
          <>
            {listError && (
              <Alert severity="error" sx={{ mb: 2 }} action={
                <Button color="inherit" sx={{ minHeight: 44 }} onClick={() => setListAttempt(attempt => attempt + 1)}>
                  {t('common.tryAgain')}
                </Button>
              }>{listError}</Alert>
            )}

            <FormControl
              fullWidth
              size="small"
              sx={{ mb: 2, '& .MuiSelect-select': { minHeight: '24px', py: 1.25 } }}
              disabled={loadingLists || lockModelSelection}
            >
              <InputLabel id="quick-chat-model-label">{t('chat.quick.model')}</InputLabel>
              <Select
                labelId="quick-chat-model-label"
                label={t('chat.quick.model')}
                value={hasSelectedModel ? modelId : ''}
                onChange={e => setModelId(e.target.value)}
              >
                {models.length === 0 && (
                  <MenuItem value="" disabled>
                    {loadingLists ? t('common.loading') : t('chat.quick.noModels')}
                  </MenuItem>
                )}
                {models.map(m => (
                  <MenuItem key={m.id} value={m.id}>
                    {m.displayName || m.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {needsFlowName && (
              <TextField
                fullWidth
                size="small"
                label={flowNameLabel}
                value={flowName}
                onChange={e => setFlowName(e.target.value)}
                inputProps={{ maxLength: 160 }}
                required
                sx={{ mb: 2 }}
              />
            )}

            <TextField
              fullWidth
              size="small"
              multiline
              minRows={2}
              maxRows={6}
              label={t('chat.quick.systemPrompt')}
              placeholder={t('chat.quick.systemPlaceholder')}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              inputProps={{ maxLength: 20_000 }}
              sx={{ mb: 2 }}
            />

            {selectApps && <>
            <Divider sx={{ mb: 1 }} />
            <Typography variant="subtitle2" gutterBottom>
              {serversLabel ?? t('chat.quick.servers')}
            </Typography>

            {loadingLists ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                <CircularProgress size={22} />
              </Box>
            ) : listError ? null : serverNames.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {noServersText ?? t('chat.quick.noServers')}
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
                                    ? t('chat.quick.allTools')
                                    : tp('chat.quick.tool', activeTools.size)
                                }
                              />
                            )}
                          </Box>
                        }
                      />
                      <IconButton size="small" onClick={() => toggleExpand(name)} aria-label={t('chat.quick.customize', { server: name })}>
                        {pick?.expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                      </IconButton>
                    </Box>
                    <Collapse in={Boolean(pick?.expanded)} unmountOnExit>
                      <Box sx={{ pl: 4, pb: 1 }}>
                        {pick?.loading ? (
                          <CircularProgress size={16} />
                        ) : pick?.loadError ? (
                          <Alert severity="error" action={
                            <Button color="inherit" sx={{ minHeight: 44 }} onClick={() => void loadTools(name)}>
                              {t('common.tryAgain')}
                            </Button>
                          }>{t('chat.quick.toolsLoadFailed')}</Alert>
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
                            {available ? t('chat.quick.noTools') : ''}
                          </Typography>
                        )}
                      </Box>
                    </Collapse>
                  </Box>
                );
              })
            )}
            </>}

            {startError && <Alert severity="error" sx={{ mt: 2 }}>{startError}</Alert>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={starting} sx={{ minHeight: 44 }}>{t('common.cancel')}</Button>
        {!needsAi && <Button
          variant="contained"
          onClick={handleStart}
          disabled={!canStart}
          sx={{ minHeight: 44 }}
          startIcon={starting ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {starting
            ? (submittingLabel ?? t('chat.quick.starting'))
            : (submitLabel ?? t('chat.quick.start'))}
        </Button>}
      </DialogActions>
    </Dialog>
  );
};

export default QuickChatDialog;

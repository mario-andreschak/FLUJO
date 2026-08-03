"use client";

/**
 * Chat-shaped Flow Generator.
 *
 * Production mode is deliberately a UI layer over the proven deterministic
 * endpoints. An explicit Settings > Experimental toggle swaps in the editable,
 * multi-stage system Flow for the whole conversation.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { v4 as uuidv4 } from 'uuid';
import type { Flow } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types/model';
import type { ChatMessage } from '@/frontend/components/Chat';
import ChatInput from '@/frontend/components/Chat/ChatInput';
import ChatMessages from '@/frontend/components/Chat/ChatMessages';
import { chatService } from '@/frontend/services/chat';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { startVisualGeneration } from '@/frontend/services/flow/visualGeneration';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';
import { MAX_VISUAL_GENERATION_DEPTH } from '@/shared/types/flow/visualGeneration';
import VisualGenerationCanvas, {
  initialVisualGenerationState,
  visualGenerationReducer,
} from './VisualGenerationCanvas';

const log = createLogger('frontend/components/Flow/FlowManager/GenerateFlowDialog');
const DEFAULT_SUBFLOW_DEPTH = MAX_VISUAL_GENERATION_DEPTH;

interface InstalledServerInfo {
  name: string;
  tools: string[];
  alreadyExisted?: boolean;
  command?: string;
  args?: string[];
  verificationStatus?: string;
}

export interface GeneratedFlowInfo {
  flow: Flow;
  flows: Flow[];
  rootFlowId: string;
  errorCount: number;
  warningCount: number;
  attempts: number;
  installedServers: InstalledServerInfo[];
}

interface GenerateFlowDialogProps {
  open: boolean;
  onClose: () => void;
  onGenerated: (result: GeneratedFlowInfo) => void;
}

type DraftPayload = GeneratedFlowInfo;

function message(role: 'user' | 'assistant', content: string): Record<string, any> {
  return {
    id: uuidv4(),
    role,
    content,
    timestamp: Date.now(),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Find the newest complete generated-draft tool result in a Flow conversation. */
export function extractFlowDraft(messages: Array<Record<string, any>>): {
  flow: Flow;
  flows: Flow[];
  rootFlowId: string;
  validation?: { errorCount?: number; warningCount?: number };
} | null {
  const inspect = (input: unknown, depth = 0): ReturnType<typeof extractFlowDraft> => {
    if (depth > 6) return null;
    const parsed = parseJson(input);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, any>;
    if (record.flow && Array.isArray(record.flows) && typeof record.rootFlowId === 'string') {
      return record as ReturnType<typeof extractFlowDraft>;
    }
    if (Array.isArray(record.content)) {
      for (let index = record.content.length - 1; index >= 0; index--) {
        const found = inspect(record.content[index], depth + 1);
        if (found) return found;
      }
    }
    for (const key of ['text', 'data', 'result']) {
      if (key in record) {
        const found = inspect(record[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (let index = messages.length - 1; index >= 0; index--) {
    const found = inspect(messages[index]?.content);
    if (found) return found;
  }
  return null;
}

function displayMessages(messages: Array<Record<string, any>>): ChatMessage[] {
  return messages
    .filter((entry) => (
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' &&
      entry.content.trim()
    ))
    .map((entry, index) => ({
      id: typeof entry.id === 'string' ? entry.id : `flow-generator-${index}`,
      role: entry.role,
      content: entry.content,
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now() + index,
      processNodeId: entry.processNodeId,
    })) as ChatMessage[];
}

/** Recover successful experimental MCP installs for the normal post-draft summary. */
function extractInstalledServers(
  messages: Array<Record<string, any>>,
): InstalledServerInfo[] {
  const found = new Map<string, InstalledServerInfo>();
  const inspect = (input: unknown, depth = 0): void => {
    if (depth > 6) return;
    const parsed = parseJson(input);
    if (!parsed || typeof parsed !== 'object') return;
    const record = parsed as Record<string, any>;
    if (
      record.installed === true &&
      typeof record.serverName === 'string' &&
      Array.isArray(record.tools)
    ) {
      found.set(record.serverName, {
        name: record.serverName,
        tools: record.tools
          .map((tool: unknown) => (
            typeof tool === 'string'
              ? tool
              : tool && typeof tool === 'object'
                ? String((tool as Record<string, unknown>).name ?? '')
                : ''
          ))
          .filter(Boolean),
        alreadyExisted: record.alreadyExisted === true,
        ...(typeof record.plan?.command === 'string'
          ? { command: record.plan.command }
          : {}),
        ...(Array.isArray(record.plan?.args)
          ? { args: record.plan.args.map(String) }
          : {}),
        ...(typeof record.plan?.verificationStatus === 'string'
          ? { verificationStatus: record.plan.verificationStatus }
          : {}),
      });
    }
    for (const value of Object.values(record)) inspect(value, depth + 1);
  };
  for (const entry of messages) inspect(entry.content);
  return [...found.values()];
}

function draftSummary(
  draft: DraftPayload,
  revised: boolean,
  t: Translator,
  tp: ReturnType<typeof useI18n>['tp'],
): string {
  const action = revised
    ? t('flows.generator.updated', { name: draft.flow.name })
    : t('flows.generator.readyNamed', { name: draft.flow.name });
  const helperCount = Math.max(0, draft.flows.length - 1);
  const helperNote = helperCount ? tp('flows.generator.helper', helperCount) : '';
  const reviewCount = draft.errorCount + draft.warningCount;
  const reviewNote = reviewCount
    ? tp('flows.generator.review', reviewCount)
    : t('flows.generator.readyReview');
  return [action, helperNote, reviewNote].filter(Boolean).join(' ');
}

const GenerateFlowDialog = ({ open, onClose, onGenerated }: GenerateFlowDialogProps) => {
  const { settings, settingsHydrated } = useStorage();
  const { t, tp } = useI18n();
  const flowBasedExperimental = (
    settingsHydrated &&
    settings?.experimental?.enabled === true &&
    settings.experimental.flowBasedGenerator === true
  );
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [wireMessages, setWireMessages] = useState<Array<Record<string, any>>>([]);
  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [allowInstall, setAllowInstall] = useState(false);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_SUBFLOW_DEPTH);
  const [isWorking, setIsWorking] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visualState, dispatchVisual] = useReducer(
    visualGenerationReducer,
    initialVisualGenerationState,
  );
  const generationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    modelService.loadModels()
      .then((loaded) => {
        if (cancelled) return;
        setModels(loaded);
        setModelId((current) => loaded.some((model) => model.id === current)
          ? current
          : loaded[0]?.id ?? '');
      })
      .catch((cause) => {
        log.warn('Failed to load generator models', cause);
        if (!cancelled) setError(t('flows.generator.modelsFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  useEffect(() => {
    if (!open) return;
    setConversationId(null);
    setWireMessages([]);
    setDraft(null);
    setAllowInstall(false);
    setMaxDepth(DEFAULT_SUBFLOW_DEPTH);
    dispatchVisual({ type: 'reset' });
    setError(null);
  }, [flowBasedExperimental, open]);

  const visibleMessages = useMemo(() => displayMessages(wireMessages), [wireMessages]);

  const startFlowSession = useCallback(async (): Promise<string> => {
    if (conversationId) return conversationId;
    const id = uuidv4();
    const { flow } = await chatService.synthesizeFlowGenerator({
      conversationId: id,
      modelId,
      allowInstall,
    });
    const now = Date.now();
    await chatService.createConversation({
      id,
      title: t('flows.generator.conversationTitle'),
      flowId: flow.id,
      flowSnapshot: flow,
      createdAt: now,
      updatedAt: now,
    });
    setConversationId(id);
    return id;
  }, [allowInstall, conversationId, modelId, t]);

  const handleSend = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isWorking || !modelId) return;

    const userMessage = message('user', trimmed);
    const nextMessages = [...wireMessages, userMessage];
    setWireMessages(nextMessages);
    setError(null);
    setIsWorking(true);

    try {
      if (flowBasedExperimental) {
        const id = await startFlowSession();
        const response = await chatService.completeFlowGeneratorTurn({
          conversationId: id,
          messages: nextMessages,
        });
        const canonical = Array.isArray(response?.messages)
          ? response.messages
          : nextMessages;
        setWireMessages(canonical);
        const proposed = extractFlowDraft(canonical);
        if (!proposed) {
          setError(t('flows.generator.experimentalNoDraft'));
          return;
        }
        const generatedByFlow: DraftPayload = {
          flow: proposed.flow,
          flows: proposed.flows,
          rootFlowId: proposed.rootFlowId,
          errorCount: proposed.validation?.errorCount ?? 0,
          warningCount: proposed.validation?.warningCount ?? 0,
          attempts: canonical.filter((entry: Record<string, any>) => entry.role === 'user').length,
          installedServers: extractInstalledServers(canonical),
        };
        setDraft(generatedByFlow);
        log.info('Experimental Generation Flow returned a draft', {
          flowId: generatedByFlow.rootFlowId,
          flowCount: generatedByFlow.flows.length,
          errors: generatedByFlow.errorCount,
          warnings: generatedByFlow.warningCount,
        });
        return;
      }

      if (!draft) {
        const controller = new AbortController();
        generationAbortRef.current = controller;
        dispatchVisual({
          type: 'session-started',
          sessionId: 'starting',
          maxDepth,
          message: t('flows.generator.visualStarting'),
        });
        const result = await startVisualGeneration({
          description: trimmed,
          modelId,
          maxDepth,
          allowInstall,
        }, async (event) => {
          dispatchVisual(event);
          const animate = event.type === 'agent-created'
            || event.type === 'step-added'
            || event.type === 'suggestion-decision';
          if (animate && process.env.NODE_ENV !== 'test') {
            await new Promise((resolve) => window.setTimeout(resolve, 140));
          }
        }, controller.signal);
        const generated: DraftPayload = {
          flow: result.flow,
          flows: result.flows,
          rootFlowId: result.rootFlowId,
          errorCount: result.validation.errorCount,
          warningCount: result.validation.warningCount,
          attempts: result.attempts,
          installedServers: result.installedServers,
        };
        log.info('Draft flow generated', {
          flowId: generated.rootFlowId,
          flowCount: generated.flows.length,
          attempts: generated.attempts,
          errors: generated.errorCount,
          warnings: generated.warningCount,
          installedServers: generated.installedServers.length,
        });
        setDraft(generated);
        setWireMessages([...nextMessages, message('assistant', draftSummary(generated, false, t, tp))]);
        return;
      }

      // Chat follow-ups use the existing AI-improve implementation. Unsaved
      // descendants are supplied as compile-time references and remain in the bundle.
      const relatedFlows = draft.flows.filter((flow) => flow.id !== draft.rootFlowId);
      const result = await flowService.improveFlow(draft.flow, trimmed, modelId, {
        allowInstall,
        relatedFlows,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      const revised: DraftPayload = {
        flow: result.flow,
        flows: result.flows.map((entry) => entry.flow),
        rootFlowId: result.rootFlowId,
        errorCount: result.validation.errorCount,
        warningCount: result.validation.warningCount,
        attempts: draft.attempts + result.attempts,
        installedServers: [...draft.installedServers, ...result.installedServers],
      };
      log.info('Draft flow improved', {
        flowId: revised.rootFlowId,
        flowCount: revised.flows.length,
        attempts: revised.attempts,
        errors: revised.errorCount,
        warnings: revised.warningCount,
        installedServers: revised.installedServers.length,
      });
      setDraft(revised);
      setWireMessages([...nextMessages, message('assistant', draftSummary(revised, true, t, tp))]);
    } catch (cause) {
      if ((cause as { name?: string } | null)?.name === 'AbortError') {
        setError(t('flows.generator.cancelled'));
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      generationAbortRef.current = null;
      setIsWorking(false);
    }
  }, [
    allowInstall,
    draft,
    flowBasedExperimental,
    isWorking,
    maxDepth,
    modelId,
    startFlowSession,
    t,
    tp,
    wireMessages,
  ]);

  const handleOpenDraft = useCallback(() => {
    if (draft) onGenerated(draft);
  }, [draft, onGenerated]);

  const handleRestoreExperimentalFlow = useCallback(async () => {
    if (isWorking || isRestoring) return;
    setIsRestoring(true);
    setError(null);
    try {
      await chatService.restoreFlowGenerator();
      setConversationId(null);
      setWireMessages([]);
      setDraft(null);
      dispatchVisual({ type: 'reset' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsRestoring(false);
    }
  }, [isRestoring, isWorking]);

  const handleClose = useCallback(() => {
    if (isWorking || isRestoring) return;
    setConversationId(null);
    setWireMessages([]);
    setDraft(null);
    setAllowInstall(false);
    setMaxDepth(DEFAULT_SUBFLOW_DEPTH);
    dispatchVisual({ type: 'reset' });
    setError(null);
    onClose();
  }, [isRestoring, isWorking, onClose]);

  const handleCancelGeneration = useCallback(() => {
    generationAbortRef.current?.abort();
  }, []);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth={!flowBasedExperimental && visualState.started ? 'xl' : 'md'}
      fullWidth
      slotProps={{ paper: { sx: { overflow: 'hidden', transition: 'max-width 240ms ease, width 240ms ease' } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          {t('flows.generator.title')}
          {flowBasedExperimental && (
            <Chip
              label={t('flows.generator.experimentalChip')}
              size="small"
              color="warning"
              variant="outlined"
              sx={{ ml: 1 }}
            />
          )}
          <Typography variant="body2" color="text.secondary">
            {flowBasedExperimental
              ? t('flows.generator.experimentalDescription')
              : t('flows.generator.description')}
          </Typography>
        </Box>
        {flowBasedExperimental && (
          <Tooltip title={t('flows.generator.restore')}>
            <span>
              <IconButton
                aria-label={t('flows.generator.restore')}
                onClick={() => { void handleRestoreExperimentalFlow(); }}
                disabled={isWorking || isRestoring}
              >
                <RestartAltIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, overflowX: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          {error && (
            <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {flowBasedExperimental && (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {t('flows.generator.experimentalWarning')}
            </Alert>
          )}
          <Box
            component="details"
            sx={{
              mt: error || flowBasedExperimental ? 1.5 : 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2.5,
              '&[open]': { p: 1.5 },
              '&[open] > summary': { mb: 1.5 },
            }}
          >
            <Box
              component="summary"
              sx={{
                px: 1.5,
                py: 1.1,
                cursor: 'pointer',
                color: 'text.secondary',
                fontSize: '0.86rem',
                fontWeight: 700,
              }}
            >
              {t('flows.generator.advanced')}
            </Box>
            <FormControl
              size="small"
              fullWidth
              disabled={isWorking || (flowBasedExperimental && !!conversationId)}
            >
              <InputLabel id="flow-generator-model-label">{t('flows.generator.model')}</InputLabel>
              <Select
                labelId="flow-generator-model-label"
                label={t('flows.generator.model')}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {models.map((model) => (
                  <MenuItem key={model.id} value={model.id}>
                    {model.displayName?.trim() || model.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  checked={allowInstall}
                  onChange={(event) => setAllowInstall(event.target.checked)}
                  disabled={isWorking || (flowBasedExperimental && !!conversationId)}
                />
              }
              label={t('flows.generator.allowTools')}
            />
            <Typography variant="caption" color="text.secondary" display="block">
              {t('flows.generator.allowToolsHelp')}
            </Typography>
            {!flowBasedExperimental && (
              <Box sx={{ mt: 2, px: 0.5 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" fontWeight={750}>
                    {t('flows.generator.maxDepth')}
                  </Typography>
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={t('flows.generator.levelCount', { count: maxDepth })}
                  />
                </Stack>
                <Slider
                  aria-label={t('flows.generator.maxDepth')}
                  value={maxDepth}
                  min={1}
                  max={MAX_VISUAL_GENERATION_DEPTH}
                  step={1}
                  marks
                  valueLabelDisplay="auto"
                  disabled={isWorking}
                  onChange={(_event, value) => setMaxDepth(Array.isArray(value) ? value[0] : value)}
                  sx={{ mt: 0.5 }}
                />
                <Typography variant="caption" color="text.secondary">
                  {t('flows.generator.maxDepthHelp')}
                </Typography>
              </Box>
            )}
            {allowInstall && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t('flows.generator.installWarning')}
              </Alert>
            )}
          </Box>
        </Box>

        {!flowBasedExperimental && visualState.started ? (
          <VisualGenerationCanvas
            state={visualState}
            working={isWorking}
            onSelectAgent={(agentId) => dispatchVisual({ type: 'focus', agentId })}
          />
        ) : (
          <Box sx={{ minHeight: 360, maxHeight: '55vh', overflowY: 'auto', p: 2 }}>
            {visibleMessages.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
              <Typography variant="h6">{t('flows.generator.question')}</Typography>
              <Typography variant="body2">
                {t('flows.generator.example')}
              </Typography>
            </Box>
            ) : (
              <ChatMessages
                messages={visibleMessages}
                conversationId="new-flow-generator"
                onToggleDisabled={() => undefined}
                onSplitConversation={() => undefined}
              />
            )}
          </Box>
        )}

        {draft && (
          <Alert severity={draft.errorCount ? 'warning' : 'success'} sx={{ mx: 2, mb: 1 }}>
            {draft.errorCount
              ? tp('flows.generator.draftAttention', draft.errorCount)
              : t('flows.generator.draftReady')}
          </Alert>
        )}

        <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <ChatInput
            onSendMessage={(content) => { void handleSend(content); }}
            disabled={isWorking || !modelId}
            placeholder={t('flows.generator.placeholder')}
          />
          {isWorking && (
            <Typography variant="caption" color="text.secondary">
              {draft
                ? t('flows.generator.applying')
                : flowBasedExperimental
                  ? t('flows.generator.runningExperimental')
                  : t('flows.generator.building')}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {isWorking && !flowBasedExperimental && (
          <Button color="warning" onClick={handleCancelGeneration}>
            {t('flows.generator.cancel')}
          </Button>
        )}
        <Button onClick={handleClose} disabled={isWorking || isRestoring}>{t('flows.generator.close')}</Button>
        <Button
          variant="contained"
          onClick={handleOpenDraft}
          disabled={!draft || isWorking}
          startIcon={<AutoAwesomeIcon />}
        >
          {t('flows.generator.continue')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default GenerateFlowDialog;

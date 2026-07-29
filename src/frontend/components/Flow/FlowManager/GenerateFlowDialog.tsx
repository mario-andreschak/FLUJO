"use client";

/**
 * Conversation-backed Flow Generator (issue #338).
 *
 * The modal runs the editable, vendored Flow Generator as a conversation
 * snapshot. Its draft_flow tool returns an unsaved bundle that is handed to
 * the existing Flow Builder review path.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import type { Flow } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types/model';
import type { ChatMessage } from '@/frontend/components/Chat';
import ChatInput from '@/frontend/components/Chat/ChatInput';
import ChatMessages from '@/frontend/components/Chat/ChatMessages';
import { chatService } from '@/frontend/services/chat';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/GenerateFlowDialog');

export interface GeneratedFlowInfo {
  flow: Flow;
  flows: Flow[];
  rootFlowId: string;
  errorCount: number;
  warningCount: number;
  attempts: number;
  installedServers: Array<{
    name: string;
    tools: string[];
    alreadyExisted?: boolean;
    command?: string;
    args?: string[];
    verificationStatus?: string;
  }>;
}

interface GenerateFlowDialogProps {
  open: boolean;
  onClose: () => void;
  onGenerated: (result: GeneratedFlowInfo) => void;
}

interface DraftPayload {
  flow: Flow;
  flows: Flow[];
  rootFlowId: string;
  validation?: { errorCount?: number; warningCount?: number };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Tool-result adapters may wrap MCP text once or twice. Walk only the known
 * content/text shapes and return the newest complete draft_flow payload.
 */
export function extractFlowDraft(messages: Array<Record<string, any>>): DraftPayload | null {
  const inspect = (input: unknown, depth = 0): DraftPayload | null => {
    if (depth > 5) return null;
    const parsed = parseJson(input);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, any>;
    if (
      record.flow &&
      Array.isArray(record.flows) &&
      typeof record.rootFlowId === 'string'
    ) {
      return record as DraftPayload;
    }
    if (Array.isArray(record.content)) {
      for (let index = record.content.length - 1; index >= 0; index--) {
        const found = inspect(record.content[index], depth + 1);
        if (found) return found;
      }
    }
    if ('text' in record) return inspect(record.text, depth + 1);
    if ('data' in record) return inspect(record.data, depth + 1);
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
    .filter((message) => (
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
    ))
    .map((message, index) => ({
      id: typeof message.id === 'string' ? message.id : `generator-message-${index}`,
      role: message.role,
      content: message.content,
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now() + index,
      processNodeId: message.processNodeId,
    })) as ChatMessage[];
}

const GenerateFlowDialog = ({ open, onClose, onGenerated }: GenerateFlowDialogProps) => {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [wireMessages, setWireMessages] = useState<Array<Record<string, any>>>([]);
  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) setError('Could not load your models. Configure a model first.');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const visibleMessages = useMemo(() => displayMessages(wireMessages), [wireMessages]);

  const startSession = useCallback(async (): Promise<string> => {
    if (conversationId) return conversationId;
    if (!modelId) throw new Error('Choose a generator model first.');
    const id = uuidv4();
    const { flow } = await chatService.synthesizeFlowGenerator({
      conversationId: id,
      modelId,
    });
    const now = Date.now();
    await chatService.createConversation({
      id,
      title: 'Flow generation',
      flowId: flow.id,
      flowSnapshot: flow,
      createdAt: now,
      updatedAt: now,
    });
    setConversationId(id);
    return id;
  }, [conversationId, modelId]);

  const handleSend = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isWorking) return;
    setError(null);
    setIsWorking(true);
    const userMessage = {
      id: uuidv4(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };
    const nextMessages = [...wireMessages, userMessage];
    setWireMessages(nextMessages);
    try {
      const id = await startSession();
      const response = await chatService.completeFlowGeneratorTurn({
        conversationId: id,
        messages: nextMessages,
      });
      const canonical = Array.isArray(response?.messages)
        ? response.messages
        : nextMessages;
      setWireMessages(canonical);
      const proposed = extractFlowDraft(canonical);
      if (proposed) setDraft(proposed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsWorking(false);
    }
  }, [isWorking, startSession, wireMessages]);

  const handleOpenDraft = useCallback(() => {
    if (!draft) return;
    onGenerated({
      flow: draft.flow,
      flows: draft.flows,
      rootFlowId: draft.rootFlowId,
      errorCount: draft.validation?.errorCount ?? 0,
      warningCount: draft.validation?.warningCount ?? 0,
      attempts: wireMessages.filter((message) => message.role === 'user').length,
      installedServers: [],
    });
  }, [draft, onGenerated, wireMessages]);

  const handleRestore = useCallback(async () => {
    setIsRestoring(true);
    setError(null);
    try {
      await chatService.restoreFlowGenerator();
      setConversationId(null);
      setWireMessages([]);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsRestoring(false);
    }
  }, []);

  const handleClose = useCallback(() => {
    if (isWorking || isRestoring) return;
    setConversationId(null);
    setWireMessages([]);
    setDraft(null);
    setError(null);
    onClose();
  }, [isRestoring, isWorking, onClose]);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          Generate a flow
          <Typography variant="body2" color="text.secondary">
            Chat with your editable Flow Generator. Drafts stay unsaved until you review them.
          </Typography>
        </Box>
        <Tooltip title="Restore the bundled Flow Generator">
          <span>
            <IconButton onClick={handleRestore} disabled={isWorking || isRestoring}>
              <RestartAltIcon />
            </IconButton>
          </span>
        </Tooltip>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
          <FormControl size="small" fullWidth disabled={isWorking || !!conversationId}>
            <InputLabel id="flow-generator-model-label">Generator model</InputLabel>
            <Select
              labelId="flow-generator-model-label"
              label="Generator model"
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
        </Box>

        <Box sx={{ minHeight: 360, maxHeight: '55vh', overflowY: 'auto', p: 2 }}>
          {visibleMessages.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
              <Typography variant="h6">What should the flow accomplish?</Typography>
              <Typography variant="body2">
                Include the desired result and any external tools it must use.
              </Typography>
            </Box>
          ) : (
            <ChatMessages
              messages={visibleMessages}
              conversationId={conversationId ?? 'new-flow-generator'}
              onToggleDisabled={() => undefined}
              onSplitConversation={() => undefined}
            />
          )}
        </Box>

        {draft && (
          <Alert severity={draft.validation?.errorCount ? 'warning' : 'success'} sx={{ mx: 2, mb: 1 }}>
            Draft ready: {draft.flow.name} · {draft.flow.nodes.length} nodes ·{' '}
            {draft.validation?.errorCount ?? 0} errors · {draft.validation?.warningCount ?? 0} warnings
          </Alert>
        )}

        <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <ChatInput
            onSendMessage={(content) => { void handleSend(content); }}
            disabled={isWorking || !modelId}
          />
          {isWorking && (
            <Typography variant="caption" color="text.secondary">
              The generator is checking available building blocks and preparing a draft…
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isWorking || isRestoring}>Close</Button>
        <Button
          variant="contained"
          onClick={handleOpenDraft}
          disabled={!draft || isWorking}
          startIcon={<AutoAwesomeIcon />}
        >
          Open draft in builder
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default GenerateFlowDialog;

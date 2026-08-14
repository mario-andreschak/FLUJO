'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  ClickAwayListener,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Popper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import { ChatMarkdownContent } from '@/frontend/components/Chat/ChatMarkdown';
import type { ChatMessage, Conversation } from '@/frontend/components/Chat';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { chatService } from '@/frontend/services/chat';
import type { ConversationChainNode } from '@/shared/types/conversationChain';
import { formatChainToolName } from './presentation';

export interface InlineTranscriptStep {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: number;
  toolName?: string;
  toolKind?: 'call' | 'result';
}

type ToolCallLike = {
  id?: string;
  function?: { name?: unknown };
};

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const value = part as { text?: unknown; content?: unknown };
      if (typeof value.text === 'string') return value.text;
      return typeof value.content === 'string' ? value.content : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Reduce the full conversation response to a quiet read-only transcript.
 * Tool calls become compact activity steps; tool results remain available in
 * collapsed details instead of flooding the little viewer with raw payloads.
 */
export function buildInlineTranscript(messages: ChatMessage[]): InlineTranscriptStep[] {
  if (!Array.isArray(messages)) return [];

  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as ToolCallLike[]) {
      const name = call.function?.name;
      if (call.id && typeof name === 'string' && name.trim()) toolNames.set(call.id, name.trim());
    }
  }

  const steps: InlineTranscriptStep[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.disabled) return;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') return;

    const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : 0;
    const baseId = message.id || `message-${messageIndex}`;
    const text = messageText(message.content);

    if (message.role === 'user' || message.role === 'assistant') {
      if (text) {
        steps.push({ id: baseId, role: message.role, text, timestamp });
      }
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        (message.tool_calls as ToolCallLike[]).forEach((call, callIndex) => {
          const rawName = call.function?.name;
          const toolName = typeof rawName === 'string' ? rawName.trim() : '';
          if (!toolName) return;
          steps.push({
            id: `${baseId}-tool-${call.id ?? callIndex}`,
            role: 'tool',
            text: toolName,
            timestamp,
            toolName,
            toolKind: 'call',
          });
        });
      }
      return;
    }

    const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    const rawMessageToolName = (message as ChatMessage & { name?: unknown }).name;
    const messageToolName = typeof rawMessageToolName === 'string' ? rawMessageToolName.trim() : '';
    const toolName = messageToolName || (callId ? toolNames.get(callId) : undefined);
    if (!text && !toolName) return;
    steps.push({
      id: baseId,
      role: 'tool',
      text: text || toolName || '',
      timestamp,
      ...(toolName ? { toolName } : {}),
      toolKind: 'result',
    });
  });

  return steps;
}

interface TranscriptMessageProps {
  step: InlineTranscriptStep;
}

function TranscriptMessage({ step }: TranscriptMessageProps) {
  const { t, formatDate } = useI18n();
  const theme = useTheme();
  const roleLabel = t(
    step.role === 'user'
      ? 'chainChat.roleUser'
      : step.role === 'assistant'
        ? 'chainChat.roleAssistant'
        : 'chainChat.roleTool',
  );
  const time = step.timestamp > 0
    ? formatDate(step.timestamp, { hour: '2-digit', minute: '2-digit' })
    : null;

  if (step.role === 'tool') {
    const isCall = step.toolKind === 'call';
    if (isCall) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 0.35 }}>
          <Chip
            size="small"
            icon={<BuildRoundedIcon sx={{ fontSize: '0.9rem !important' }} />}
            label={`${t('chainChat.toolCall')} · ${formatChainToolName(step.toolName ?? step.text)}`}
            sx={{
              maxWidth: '92%',
              height: 26,
              border: `1px solid ${alpha(theme.palette.info.main, 0.3)}`,
              color: theme.palette.mode === 'dark' ? theme.palette.info.light : theme.palette.info.dark,
              bgcolor: alpha(theme.palette.info.main, 0.1),
              '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
            }}
          />
        </Box>
      );
    }

    return (
      <Box
        component="details"
        sx={{
          alignSelf: 'center',
          width: '92%',
          border: '1px solid',
          borderColor: alpha(theme.palette.info.main, 0.22),
          borderRadius: 2.25,
          bgcolor: alpha(theme.palette.info.main, 0.055),
          overflow: 'hidden',
          '&[open] > summary': { borderBottom: '1px solid', borderColor: 'divider' },
        }}
      >
        <Box
          component="summary"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.8,
            px: 1.25,
            py: 0.9,
            cursor: 'pointer',
            color: 'text.secondary',
            fontSize: '0.72rem',
            fontWeight: 700,
            listStyle: 'none',
            '&::-webkit-details-marker': { display: 'none' },
          }}
        >
          <BuildRoundedIcon sx={{ fontSize: '0.95rem', color: 'info.main' }} />
          <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {formatChainToolName(step.toolName) || roleLabel} · {t('chainChat.toolResult')}
          </Box>
          {time && <Box component="span" sx={{ fontWeight: 500, opacity: 0.72 }}>{time}</Box>}
        </Box>
        <Typography
          component="pre"
          sx={{
            m: 0,
            p: 1.25,
            maxHeight: 220,
            overflow: 'auto',
            color: 'text.secondary',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '0.7rem',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {step.text}
        </Typography>
      </Box>
    );
  }

  const isUser = step.role === 'user';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <Stack direction="row" spacing={0.7} alignItems="center" sx={{ mb: 0.45, px: 0.45 }}>
        {isUser
          ? <PersonRoundedIcon sx={{ fontSize: '0.8rem', color: 'primary.main' }} />
          : <AutoAwesomeRoundedIcon sx={{ fontSize: '0.8rem', color: 'secondary.main' }} />}
        <Typography sx={{ color: 'text.secondary', fontSize: '0.66rem', fontWeight: 720 }}>
          {roleLabel}{time ? ` · ${time}` : ''}
        </Typography>
      </Stack>
      <Paper
        variant="outlined"
        sx={{
          maxWidth: '88%',
          px: 1.35,
          py: 1.05,
          borderRadius: isUser ? '16px 16px 5px 16px' : '16px 16px 16px 5px',
          borderColor: isUser
            ? alpha(theme.palette.primary.main, 0.3)
            : alpha(theme.palette.secondary.main, 0.2),
          bgcolor: isUser
            ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.085)
            : alpha(theme.palette.background.paper, 0.74),
          boxShadow: 'none',
          '& .MuiTypography-body1': {
            m: 0,
            color: 'text.primary',
            fontSize: '0.78rem',
            lineHeight: 1.58,
          },
          '& pre': { fontSize: '0.72rem' },
        }}
      >
        <ChatMarkdownContent>{step.text}</ChatMarkdownContent>
      </Paper>
    </Box>
  );
}

export interface ChainTranscriptPopoverProps {
  node: ConversationChainNode | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  reducedMotion?: boolean;
  compact?: boolean;
}

export default function ChainTranscriptPopover({
  node,
  anchorEl,
  onClose,
  onOpenConversation,
  reducedMotion = false,
  compact = false,
}: ChainTranscriptPopoverProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const cacheRef = useRef(new Map<string, { conversation: Conversation; nodeUpdatedAt: number }>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [retryToken, setRetryToken] = useState(0);
  const open = Boolean(anchorEl && node);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !node) return;
    const cached = cacheRef.current.get(node.id);
    if (cached && !node.active && cached.nodeUpdatedAt >= node.updatedAt) {
      setConversation(cached.conversation);
      setLoadedNodeId(node.id);
      setState('ready');
      return;
    }

    let current = true;
    setConversation(null);
    setLoadedNodeId(node.id);
    setState('loading');
    chatService
      .getConversation(node.id)
      .then((loaded) => {
        if (!current) return;
        cacheRef.current.set(node.id, { conversation: loaded, nodeUpdatedAt: node.updatedAt });
        setConversation(loaded);
        setLoadedNodeId(node.id);
        setState('ready');
      })
      .catch(() => {
        if (!current) return;
        setState('error');
      });
    return () => {
      current = false;
    };
  }, [node?.active, node?.id, node?.updatedAt, open, retryToken]);

  const displayState = !open
    ? 'idle'
    : loadedNodeId === node?.id
      ? state
      : 'loading';

  const steps = useMemo(
    () => buildInlineTranscript(loadedNodeId === node?.id ? conversation?.messages ?? [] : []),
    [conversation?.messages, loadedNodeId, node?.id],
  );

  useEffect(() => {
    if (displayState !== 'ready') return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayState, node?.id, steps.length]);

  const title = node?.title?.trim() || t('chainChat.untitled');

  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement={compact ? 'bottom-start' : 'right-start'}
      modifiers={[
        { name: 'offset', options: { offset: compact ? [0, 10] : [12, 0] } },
        { name: 'flip', options: { padding: 16 } },
        { name: 'preventOverflow', options: { padding: 16 } },
      ]}
      sx={{ zIndex: theme.zIndex.modal + 1 }}
    >
      <ClickAwayListener onClickAway={onClose}>
        <Paper
          elevation={0}
          sx={{
            width: 'min(400px, calc(100vw - 32px))',
            overflow: 'hidden',
            border: '1px solid',
            borderColor: alpha(theme.palette.primary.main, 0.2),
            borderRadius: 3.25,
            background: `linear-gradient(180deg, ${alpha(theme.palette.background.paper, 0.985)}, ${alpha(theme.palette.background.default, 0.965)})`,
            backdropFilter: 'blur(18px) saturate(125%)',
            boxShadow: `0 20px 60px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.46 : 0.18)}, 0 0 28px ${alpha(theme.palette.primary.main, 0.07)}`,
            transformOrigin: compact ? 'top left' : 'left top',
            animation: reducedMotion ? 'none' : 'chainTranscriptEnter 180ms cubic-bezier(.2,.75,.25,1)',
            '@keyframes chainTranscriptEnter': {
              from: { opacity: 0, transform: 'translateY(4px) scale(.985)' },
              to: { opacity: 1, transform: 'translateY(0) scale(1)' },
            },
          }}
        >
          <Box
        id={node ? `chain-transcript-${node.id.replace(/[^A-Za-z0-9_-]/g, '-')}` : undefined}
        role="dialog"
        aria-label={t('chainChat.transcriptLabel', { title })}
        sx={{ display: 'flex', maxHeight: 'min(62vh, 540px)', minHeight: 0, flexDirection: 'column' }}
      >
        <Stack direction="row" spacing={1.1} alignItems="center" sx={{ px: 1.6, py: 1.35 }}>
          <Box
            aria-hidden="true"
            sx={{
              display: 'grid',
              width: 32,
              height: 32,
              placeItems: 'center',
              borderRadius: 2,
              color: 'primary.main',
              bgcolor: alpha(theme.palette.primary.main, 0.1),
            }}
          >
            <AutoAwesomeRoundedIcon sx={{ fontSize: '1rem' }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: '0.82rem', fontWeight: 760 }} title={title}>
              {title}
            </Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: '0.66rem' }}>
              {displayState === 'ready'
                ? t('chainChat.messageCount', { count: steps.length })
                : t('chainChat.inlineConversation')}
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label={t('chainChat.closeTranscript')}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
        <Divider />

        <Box
          ref={scrollRef}
          sx={{
            minHeight: 0,
            maxHeight: 'min(44vh, 390px)',
            flex: '0 1 auto',
            overflowY: 'auto',
            px: 1.6,
            py: 1.45,
            scrollbarWidth: 'thin',
          }}
        >
          {displayState === 'loading' && (
            <Stack alignItems="center" justifyContent="center" spacing={1.2} sx={{ minHeight: 180 }}>
              <CircularProgress size={22} thickness={4} />
              <Typography variant="caption" color="text.secondary">
                {t('chainChat.loadingConversation')}
              </Typography>
            </Stack>
          )}
          {displayState === 'error' && (
            <Alert
              severity="error"
              variant="outlined"
              action={
                <Button color="inherit" size="small" onClick={() => setRetryToken((token) => token + 1)}>
                  {t('chainChat.retry')}
                </Button>
              }
            >
              {t('chainChat.conversationError')}
            </Alert>
          )}
          {displayState === 'ready' && steps.length === 0 && (
            <Stack alignItems="center" justifyContent="center" spacing={0.5} sx={{ minHeight: 180, textAlign: 'center' }}>
              <Typography sx={{ fontSize: '0.8rem', fontWeight: 700 }}>{t('chainChat.noMessages')}</Typography>
              <Typography variant="caption" color="text.secondary">{t('chainChat.noMessagesBody')}</Typography>
            </Stack>
          )}
          {displayState === 'ready' && steps.length > 0 && (
            <Stack spacing={1.25}>
              {steps.map((step) => <TranscriptMessage key={step.id} step={step} />)}
            </Stack>
          )}
        </Box>

        <Divider />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1.35, py: 1 }}>
          <Button
            size="small"
            endIcon={<OpenInNewRoundedIcon />}
            onClick={() => {
              if (!node) return;
              onClose();
              onOpenConversation(node.id);
            }}
          >
            {t('chainChat.openFullChat')}
          </Button>
        </Box>
          </Box>
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}

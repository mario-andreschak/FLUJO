'use client';

/**
 * One conversation "bubble" on the chain-chat canvas (issue #405).
 *
 * View-only: it renders title, status and a bounded plain-text preview of the
 * conversation's latest displayable message, and its whole surface is a single
 * button that opens the matching chat. Message text is rendered as TEXT via
 * MUI Typography — never as HTML — because it is untrusted model/user content.
 */

import React, { memo, useCallback } from 'react';
import { Box, ButtonBase, Chip, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import type { ConversationChainNode, ConversationChainNodeStatus } from '@/shared/types/conversationChain';

export interface ChainBubbleData extends Record<string, unknown> {
  conversation: ConversationChainNode;
  detached: boolean;
  reducedMotion: boolean;
  /** Entrance-animation ordering only; never affects the accessible name. */
  index: number;
  onOpen: (conversationId: string) => void;
}

type StatusTone = 'primary' | 'warning' | 'secondary' | 'success' | 'error' | 'default';

const STATUS_LABELS: Record<ConversationChainNodeStatus, TranslationKey> = {
  running: 'chainChat.statusRunning',
  awaiting_tool_approval: 'chainChat.statusAwaitingToolApproval',
  paused_debug: 'chainChat.statusPausedDebug',
  completed: 'chainChat.statusCompleted',
  error: 'chainChat.statusError',
  capped: 'chainChat.statusCapped',
};

const STATUS_TONES: Record<ConversationChainNodeStatus, StatusTone> = {
  running: 'primary',
  awaiting_tool_approval: 'warning',
  paused_debug: 'secondary',
  completed: 'success',
  error: 'error',
  capped: 'warning',
};

function ChainNodeBubbleComponent({ data }: NodeProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const { conversation, detached, reducedMotion, index, onOpen } = data as unknown as ChainBubbleData;

  const title = conversation.title?.trim() || t('chainChat.untitled');
  const statusKey = conversation.status ? STATUS_LABELS[conversation.status] : 'chainChat.statusUnknown';
  const statusLabel = t(statusKey);
  const tone: StatusTone = conversation.status ? STATUS_TONES[conversation.status] : 'default';
  const accent = tone === 'default' ? theme.palette.text.disabled : theme.palette[tone].main;

  const preview = conversation.lastMessage;
  const previewText = preview
    ? preview.text
    : conversation.previewUnavailable
      ? t('chainChat.previewUnavailable')
      : t('chainChat.noMessages');
  const roleLabel = preview
    ? t(preview.role === 'user' ? 'chainChat.roleUser' : 'chainChat.roleAssistant')
    : null;

  const open = useCallback(() => onOpen(conversation.id), [onOpen, conversation.id]);

  // A <button> already activates on Enter/Space, but React Flow's canvas
  // intercepts some key events, so the contract is made explicit here.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      event.stopPropagation();
      open();
    },
    [open]
  );

  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0 }} />
      <ButtonBase
        className="nodrag nopan"
        focusRipple
        onClick={open}
        onKeyDown={handleKeyDown}
        aria-label={t('chainChat.openConversation', { title })}
        data-testid={`chain-node-${conversation.id}`}
        data-active={conversation.active ? 'true' : 'false'}
        sx={{
          width: 288,
          minHeight: 136,
          p: 1.75,
          textAlign: 'left',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          flexDirection: 'column',
          borderRadius: 3,
          border: '1px solid',
          borderColor: alpha(accent, conversation.active ? 0.55 : 0.24),
          bgcolor: alpha(theme.palette.background.paper, 0.92),
          boxShadow: conversation.active
            ? `0 10px 30px ${alpha(accent, 0.22)}`
            : `0 6px 18px ${alpha(theme.palette.common.black, 0.16)}`,
          backdropFilter: 'blur(6px)',
          opacity: conversation.active ? 1 : 0.82,
          transition: reducedMotion ? 'none' : 'transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
          animation: reducedMotion ? 'none' : 'chainBubbleIn 320ms ease both',
          animationDelay: reducedMotion ? undefined : `${Math.min(index, 20) * 40}ms`,
          '@keyframes chainBubbleIn': {
            from: { opacity: 0, transform: 'translateY(10px) scale(0.97)' },
            to: { opacity: conversation.active ? 1 : 0.82, transform: 'none' },
          },
          '&:hover': reducedMotion ? {} : { transform: 'translateY(-2px)', borderColor: alpha(accent, 0.7) },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 2,
          },
        }}
      >
        <Stack spacing={1} sx={{ width: '100%' }}>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%' }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 9,
                height: 9,
                flex: '0 0 auto',
                borderRadius: '50%',
                bgcolor: accent,
                boxShadow: conversation.active ? `0 0 10px ${alpha(accent, 0.85)}` : 'none',
                animation:
                  conversation.active && !reducedMotion ? 'chainPulse 2.4s ease-in-out infinite' : 'none',
                '@keyframes chainPulse': {
                  '0%, 100%': { opacity: 1 },
                  '50%': { opacity: 0.35 },
                },
              }}
            />
            <Typography
              variant="subtitle2"
              noWrap
              sx={{ flex: 1, minWidth: 0, fontWeight: 700 }}
              title={title}
            >
              {title}
            </Typography>
          </Stack>

          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              label={statusLabel}
              color={tone === 'default' ? 'default' : tone}
              variant={conversation.active ? 'filled' : 'outlined'}
              sx={{ height: 20, fontSize: '0.68rem' }}
            />
            {detached && (
              <Chip
                size="small"
                variant="outlined"
                label={t('chainChat.detachedChip')}
                sx={{ height: 20, fontSize: '0.68rem' }}
              />
            )}
          </Stack>

          <Typography
            variant="body2"
            color={preview ? 'text.secondary' : 'text.disabled'}
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
              fontStyle: preview ? 'normal' : 'italic',
            }}
          >
            {roleLabel ? `${roleLabel}: ${previewText}` : previewText}
          </Typography>
        </Stack>
      </ButtonBase>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0 }} />
    </>
  );
}

export const ChainNodeBubble = memo(ChainNodeBubbleComponent);

export default ChainNodeBubble;

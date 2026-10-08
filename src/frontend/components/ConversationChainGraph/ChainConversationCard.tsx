'use client';

import React, { memo, useEffect, useState } from 'react';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import SubdirectoryArrowRightRoundedIcon from '@mui/icons-material/SubdirectoryArrowRightRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import type {
  ConversationChainNode,
  ConversationChainNodeStatus,
} from '@/shared/types/conversationChain';
import { formatChainToolName } from './presentation';

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

const COMPLETED_PREVIEW_GRACE_MS = 10_000;

export interface ChainConversationCardProps {
  conversation: ConversationChainNode;
  isRoot: boolean;
  detached: boolean;
  compact?: boolean;
  reducedMotion?: boolean;
  entranceIndex: number;
  previewOpen: boolean;
  onOpenConversation: (conversationId: string) => void;
  onOpenPreview: (anchor: HTMLElement, conversation: ConversationChainNode) => void;
}

function ChainConversationCardComponent({
  conversation,
  isRoot,
  detached,
  compact = false,
  reducedMotion = false,
  entranceIndex,
  previewOpen,
  onOpenConversation,
  onOpenPreview,
}: ChainConversationCardProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const title = conversation.title?.trim() || t('chainChat.untitled');
  const identityTitle = conversation.flowName?.trim()
    || (isRoot ? t('chainChat.rootConversation') : title);
  const statusKey = conversation.status ? STATUS_LABELS[conversation.status] : 'chainChat.statusUnknown';
  const statusLabel = t(statusKey);
  const tone: StatusTone = conversation.status ? STATUS_TONES[conversation.status] : 'default';
  const statusColor = tone === 'default' ? theme.palette.text.disabled : theme.palette[tone].main;
  const preview = conversation.lastMessage;
  const previewText = preview
    ? preview.role === 'tool'
      ? preview.toolKind === 'result'
        ? `${preview.text} · ${t('chainChat.toolActivity')}`
        : preview.text
      : preview.text
    : conversation.previewUnavailable
      ? t('chainChat.previewUnavailable')
      : t('chainChat.noMessages');
  const previewRole = preview?.role;
  const roleLabel = previewRole
    ? (previewRole === 'tool'
        ? t(preview.toolKind === 'call' ? 'chainChat.toolCall' : 'chainChat.toolResult')
        : t(previewRole === 'user' ? 'chainChat.roleUser' : 'chainChat.roleAssistant'))
      + (previewRole === 'tool' && preview?.toolName ? ` · ${formatChainToolName(preview.toolName)}` : '')
    : t('chainChat.latestMessage');
  const roleColor = previewRole === 'tool'
    ? theme.palette.info.main
    : previewRole === 'user'
      ? theme.palette.primary.main
      : theme.palette.secondary.main;
  const RoleIcon = previewRole === 'tool'
    ? BuildRoundedIcon
    : previewRole === 'user'
      ? PersonRoundedIcon
      : AutoAwesomeRoundedIcon;
  const [completedPreviewHidden, setCompletedPreviewHidden] = useState(() => (
    conversation.status === 'completed'
    && conversation.updatedAt > 0
    && Date.now() >= conversation.updatedAt + COMPLETED_PREVIEW_GRACE_MS
  ));

  useEffect(() => {
    if (conversation.status !== 'completed') {
      setCompletedPreviewHidden(false);
      return;
    }
    const remaining = Math.max(
      0,
      conversation.updatedAt + COMPLETED_PREVIEW_GRACE_MS - Date.now(),
    );
    if (remaining === 0) {
      setCompletedPreviewHidden(true);
      return;
    }
    setCompletedPreviewHidden(false);
    const timer = window.setTimeout(() => setCompletedPreviewHidden(true), remaining);
    return () => window.clearTimeout(timer);
  }, [conversation.status, conversation.updatedAt]);

  return (
    <Stack
      className="chain-node-composite"
      data-completed-preview-hidden={completedPreviewHidden ? 'true' : 'false'}
      direction={compact ? 'column' : 'row'}
      spacing={compact ? 1 : 1.4}
      alignItems="center"
      sx={{
        position: 'relative',
        zIndex: 2,
        width: compact ? 286 : 376,
        opacity: 1,
        animation: reducedMotion ? 'none' : 'chainNodeArrive 420ms cubic-bezier(.2,.75,.25,1) both',
        animationDelay: reducedMotion ? undefined : `${Math.min(entranceIndex, 20) * 45}ms`,
        '@keyframes chainNodeArrive': {
          from: { opacity: 0, transform: 'translateY(-7px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        transition: reducedMotion ? 'none' : 'opacity 180ms ease',
        // The tree axis runs through the identity node. The message remains a
        // true adjacent sidecar without pulling connectors between the two.
        left: compact ? 0 : 114,
        ...(completedPreviewHidden ? {
          '& .chain-message-preview': {
            opacity: 0,
            pointerEvents: 'none',
            transform: compact ? 'translateY(-5px) scale(.98)' : 'translateX(-7px) scale(.98)',
          },
          '&:hover .chain-message-preview, &:focus-within .chain-message-preview': {
            opacity: 1,
            pointerEvents: 'auto',
            transform: 'none',
          },
        } : {}),
      }}
    >
      <ButtonBase
        className="chain-identity"
        onClick={() => onOpenConversation(conversation.id)}
        aria-label={t('chainChat.openConversation', { title })}
        data-testid={`chain-node-${conversation.id}`}
        data-active={conversation.active ? 'true' : 'false'}
        sx={{
          position: 'relative',
          width: compact ? 214 : 148,
          minHeight: 82,
          flex: '0 0 auto',
          px: 1.35,
          py: 1.15,
          overflow: 'visible',
          textAlign: 'left',
          border: `${isRoot ? 1.5 : 1}px solid`,
          borderColor: isRoot
            ? alpha(theme.palette.primary.main, 0.55)
            : alpha(statusColor, conversation.active ? 0.46 : 0.24),
          borderRadius: isRoot ? 99 : 3.25,
          background: isRoot
            ? `linear-gradient(145deg, ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.115)}, ${alpha(theme.palette.background.paper, 0.94)} 58%, ${alpha(theme.palette.secondary.main, 0.08)})`
            : `linear-gradient(145deg, ${alpha(theme.palette.background.paper, 0.96)}, ${alpha(statusColor, 0.04)})`,
          boxShadow: isRoot
            ? `0 12px 34px ${alpha(theme.palette.primary.main, 0.17)}, inset 0 1px 0 ${alpha(theme.palette.common.white, 0.08)}`
            : `0 8px 24px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.2 : 0.075)}`,
          transition: reducedMotion ? 'none' : 'transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
          '&::after': conversation.active
            ? {
                content: '""',
                position: 'absolute',
                inset: -5,
                zIndex: -1,
                border: `1px solid ${alpha(statusColor, 0.42)}`,
                borderRadius: 'inherit',
                opacity: 0.4,
                animation: reducedMotion ? 'none' : 'chainNodeBreathe 3.2s ease-in-out infinite',
              }
            : undefined,
          '@keyframes chainNodeBreathe': {
            '0%, 100%': { opacity: 0.2, transform: 'scale(0.99)' },
            '50%': { opacity: 0.68, transform: 'scale(1.025)' },
          },
          '&:hover': reducedMotion
            ? { borderColor: alpha(statusColor, 0.62) }
            : {
                transform: 'translateY(-2px)',
                borderColor: alpha(statusColor, 0.66),
                boxShadow: `0 12px 32px ${alpha(statusColor, 0.15)}`,
              },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 3,
          },
        }}
      >
        <Stack direction="row" spacing={1.05} alignItems="center" sx={{ width: '100%' }}>
          <Box
            aria-hidden="true"
            sx={{
              position: 'relative',
              display: 'grid',
              width: 36,
              height: 36,
              flex: '0 0 auto',
              placeItems: 'center',
              borderRadius: isRoot ? '50%' : 2.5,
              color: isRoot ? 'primary.contrastText' : statusColor,
              background: isRoot
                ? `linear-gradient(145deg, ${theme.palette.primary.light}, ${theme.palette.primary.main} 54%, ${theme.palette.secondary.main})`
                : alpha(statusColor, 0.1),
              boxShadow: isRoot ? `0 7px 20px ${alpha(theme.palette.primary.main, 0.28)}` : 'none',
            }}
          >
            {isRoot ? <HubRoundedIcon sx={{ fontSize: '1.15rem' }} /> : <SubdirectoryArrowRightRoundedIcon sx={{ fontSize: '1.05rem' }} />}
            <Box
              sx={{
                position: 'absolute',
                right: -1,
                bottom: -1,
                width: 9,
                height: 9,
                border: `2px solid ${theme.palette.background.paper}`,
                borderRadius: '50%',
                bgcolor: statusColor,
              }}
            />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              component="span"
              sx={{
                display: 'block',
                mb: 0.25,
                color: isRoot ? 'primary.main' : 'text.secondary',
                fontSize: '0.59rem',
                fontWeight: 780,
                letterSpacing: '0.11em',
                textTransform: 'uppercase',
              }}
            >
              {t(isRoot ? 'chainChat.rootNode' : detached ? 'chainChat.detachedChip' : 'chainChat.subflowNode')}
            </Typography>
            <Typography
              component="span"
              title={identityTitle}
              sx={{
                display: '-webkit-box',
                overflow: 'hidden',
                color: 'text.primary',
                fontSize: '0.78rem',
                fontWeight: 760,
                lineHeight: 1.25,
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
              }}
            >
              {identityTitle}
            </Typography>
            <Stack direction="row" spacing={0.55} alignItems="center" sx={{ mt: 0.55 }}>
              <Typography component="span" sx={{ color: 'text.secondary', fontSize: '0.61rem', lineHeight: 1 }}>
                {statusLabel}
              </Typography>
              {conversation.messageCount !== undefined && (
                <Stack
                  component="span"
                  direction="row"
                  spacing={0.25}
                  alignItems="center"
                  title={t('chainChat.messageCount', { count: conversation.messageCount })}
                  aria-label={t('chainChat.messageCount', { count: conversation.messageCount })}
                  sx={{ ml: 'auto !important', color: 'text.secondary' }}
                >
                  <ChatBubbleOutlineRoundedIcon sx={{ fontSize: '0.7rem' }} />
                  <Typography component="span" sx={{ fontSize: '0.59rem', fontWeight: 730, lineHeight: 1 }}>
                    {conversation.messageCount}
                  </Typography>
                </Stack>
              )}
              <OpenInNewRoundedIcon
                sx={{
                  ml: conversation.messageCount === undefined ? 'auto !important' : '0 !important',
                  color: 'text.disabled',
                  fontSize: '0.72rem',
                }}
              />
            </Stack>
          </Box>
        </Stack>
      </ButtonBase>

      <ButtonBase
        className="chain-message-preview"
        onClick={(event) => onOpenPreview(event.currentTarget, conversation)}
        aria-label={t('chainChat.expandConversation', { title })}
        aria-haspopup="dialog"
        aria-expanded={previewOpen}
        aria-controls={previewOpen ? `chain-transcript-${conversation.id.replace(/[^A-Za-z0-9_-]/g, '-')}` : undefined}
        data-testid={`chain-message-${conversation.id}`}
        sx={{
          position: 'relative',
          display: 'flex',
          width: compact ? 270 : 216,
          minHeight: 82,
          flex: '0 0 auto',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          px: 1.35,
          py: 1.05,
          overflow: 'visible',
          textAlign: 'left',
          border: '1px solid',
          borderColor: previewOpen
            ? alpha(roleColor, 0.55)
            : alpha(roleColor, previewRole ? 0.24 : 0.14),
          borderRadius: previewRole === 'user'
            ? '18px 18px 7px 18px'
            : previewRole === 'tool'
              ? 3.5
              : '18px 18px 18px 7px',
          bgcolor: previewRole === 'tool'
            ? alpha(theme.palette.info.main, 0.075)
            : previewRole === 'user'
              ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.13 : 0.065)
              : alpha(theme.palette.background.paper, 0.78),
          boxShadow: previewOpen
            ? `0 12px 34px ${alpha(roleColor, 0.17)}`
            : `0 7px 22px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.14 : 0.055)}`,
          backdropFilter: 'blur(12px)',
          transition: reducedMotion ? 'none' : 'opacity 180ms ease, transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
          '&::before': compact
            ? {
                content: '""',
                position: 'absolute',
                top: -6,
                left: '50%',
                width: 11,
                height: 11,
                borderTop: '1px solid',
                borderLeft: '1px solid',
                borderColor: 'inherit',
                bgcolor: 'inherit',
                transform: 'translateX(-50%) rotate(45deg)',
              }
            : {
                content: '""',
                position: 'absolute',
                top: 24,
                left: -6,
                width: 11,
                height: 11,
                borderBottom: '1px solid',
                borderLeft: '1px solid',
                borderColor: 'inherit',
                bgcolor: 'inherit',
                transform: 'rotate(45deg)',
              },
          '&:hover': reducedMotion
            ? { borderColor: alpha(roleColor, 0.48) }
            : { transform: 'translateY(-2px)', borderColor: alpha(roleColor, 0.48) },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 3,
          },
        }}
      >
        <Stack spacing={0.55} sx={{ width: '100%', minWidth: 0 }}>
          <Stack direction="row" spacing={0.65} alignItems="center">
            <RoleIcon aria-hidden="true" sx={{ color: roleColor, fontSize: '0.84rem' }} />
            <Typography
              component="span"
              sx={{
                flex: 1,
                color: roleColor,
                fontSize: '0.61rem',
                fontWeight: 780,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {roleLabel}
            </Typography>
            <Typography component="span" sx={{ color: 'text.disabled', fontSize: '0.58rem' }}>
              {t('chainChat.expandHint')}
            </Typography>
            <ExpandMoreRoundedIcon
              sx={{
                color: 'text.disabled',
                fontSize: '0.95rem',
                transform: previewOpen ? 'rotate(180deg)' : 'none',
                transition: reducedMotion ? 'none' : 'transform 180ms ease',
              }}
            />
          </Stack>
          <Typography
            component="span"
            sx={{
              display: '-webkit-box',
              overflow: 'hidden',
              color: preview ? 'text.primary' : 'text.disabled',
              fontSize: previewRole === 'tool' ? '0.71rem' : '0.73rem',
              fontStyle: preview ? 'normal' : 'italic',
              lineHeight: 1.42,
              wordBreak: 'break-word',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
            }}
          >
            {previewText}
          </Typography>
        </Stack>
      </ButtonBase>
    </Stack>
  );
}

export default memo(ChainConversationCardComponent);

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Chip, IconButton, Tooltip, Typography } from '@mui/material';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import PauseRoundedIcon from '@mui/icons-material/PauseRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useInterval } from '@/frontend/hooks/timing';
import { chatService } from '@/frontend/services/chat';
import type { ChatGoal, ChatGoalAction } from '@/shared/types/chatGoal';
import { chatGoalStateText, shortGoalText } from './chatGoalText';

/** How often an active goal is read again while the chat is on screen. */
const ACTIVE_REFRESH_MS = 4_000;

interface ChatGoalBarProps {
  conversationId: string;
  /** Changes when the chat moved on (a reply started or ended, a command ran), so the goal is read again. */
  refreshKey: string;
  /** The goal started a new turn or changed state, so the chat can show the new turn. */
  onProgress?: () => void;
}

function progressMark(goal: ChatGoal | null): string {
  return goal ? `${goal.id}:${goal.state}:${goal.rounds}` : '';
}

/**
 * The goal of a chat with an agent (#1225), above the message box: what it is,
 * where it stands, and buttons to pause, resume or clear it.
 */
const ChatGoalBar: React.FC<ChatGoalBarProps> = ({ conversationId, refreshKey, onProgress }) => {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{ conversationId: string; goal: ChatGoal | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const markRef = useRef<{ conversationId: string; mark: string } | null>(null);
  const goal = loaded?.conversationId === conversationId ? loaded.goal : null;

  const showGoal = useCallback((request: number, next: ChatGoal | null) => {
    if (request !== requestRef.current) return;
    setLoaded({ conversationId, goal: next });
    const mark = progressMark(next);
    const previous = markRef.current;
    if (previous?.conversationId === conversationId && previous.mark !== mark) onProgress?.();
    markRef.current = { conversationId, mark };
  }, [conversationId, onProgress]);

  /** Read the goal; a failed read keeps the goal as last shown until the next refresh. */
  const load = useCallback(() => {
    const request = ++requestRef.current;
    return chatService.getChatGoal(conversationId).then((next) => showGoal(request, next), () => undefined);
  }, [conversationId, showGoal]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, goal?.state === 'active' ? ACTIVE_REFRESH_MS : null);

  const act = async (action: ChatGoalAction | 'clear') => {
    setBusy(true);
    setFailure(null);
    try {
      if (action === 'clear') await chatService.clearChatGoal(conversationId);
      else await chatService.updateChatGoal(conversationId, action);
      await load();
    } catch (error) {
      setFailure(t('chat.slash.failed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  if (!goal) return null;
  const achieved = goal.state === 'achieved';
  const paused = goal.state === 'paused';
  const state = chatGoalStateText(goal, t);
  const details = [goal.text, goal.pause?.detail, goal.lastNote && t('chat.goal.lastNote', { note: goal.lastNote })]
    .filter(Boolean).join('\n\n');

  return (
    <Box
      role="region"
      aria-label={t('chat.goal.region')}
      data-testid="chat-goal"
      sx={{ mb: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, minWidth: 0 }}
    >
      <Tooltip title={<Box component="span" sx={{ whiteSpace: 'pre-line' }}>{details}</Box>}>
        <Chip
          size="small"
          variant="outlined"
          color={achieved ? 'success' : paused ? 'warning' : 'primary'}
          icon={achieved ? <CheckCircleOutlineRoundedIcon /> : <FlagOutlinedIcon />}
          label={t('chat.goal.label', { text: shortGoalText(goal.text, 80) })}
          sx={{ maxWidth: '100%' }}
        />
      </Tooltip>
      <Typography variant="caption" color="text.secondary" role="status" sx={{ overflowWrap: 'anywhere' }}>
        {goal.pause?.detail ? `${state}: ${shortGoalText(goal.pause.detail, 120)}` : state}
      </Typography>
      {goal.state === 'active' && (
        <Tooltip title={t('chat.goal.pause')}>
          <span>
            <IconButton size="small" aria-label={t('chat.goal.pause')} disabled={busy} onClick={() => void act('pause')}>
              <PauseRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {paused && (
        <Tooltip title={t('chat.goal.resume')}>
          <span>
            <IconButton size="small" aria-label={t('chat.goal.resume')} disabled={busy} onClick={() => void act('resume')}>
              <PlayArrowRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title={t('chat.goal.clear')}>
        <span>
          <IconButton size="small" aria-label={t('chat.goal.clear')} disabled={busy} onClick={() => void act('clear')}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {failure && (
        <Typography variant="caption" color="error" role="alert">{failure}</Typography>
      )}
    </Box>
  );
};

export default ChatGoalBar;

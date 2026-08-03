"use client";

import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import BugReportIcon from '@mui/icons-material/BugReport';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { LiveLane, LiveLanes, laneList } from '@/utils/shared/liveLanes';
import { getWorkingMessage, WORKING_MESSAGE_INTERVAL_MS } from './workingMessages';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** Live execution stats, driven by the SSE event stream while a run is active. */
export interface LiveRunStats {
  totalTokens: number;
  activeNode: string | null;
  startedAt: number;
  lastEventAt: number;
}

interface LiveRunIndicatorProps {
  liveStats: LiveRunStats | null;
  onStop: () => void;
  stopDisabled?: boolean;
  /** The run is parked at a tool-approval prompt: swap the spinner (which would
   *  falsely suggest activity next to the Approve/Reject buttons) for a static
   *  pause icon, and drop the elapsed/stall caption — but keep Stop reachable,
   *  since the run is still alive and holding the conversation. */
  awaitingApproval?: boolean;
  /** Per-child progress rows for a Subflow job queue (issue #157).
   *  Empty/absent → the exact pre-queue rendering. */
  lanes?: LiveLanes;
  /** Open a lane's persisted sidebar conversation (rows are clickable only
   *  when the lane carries a laneConversationId). */
  onOpenLane?: (conversationId: string) => void;
  /** Attach the debugger to this in-flight run: arms a one-shot breakpoint so
   *  execution pauses before the next node and opens the debugger panel. Only
   *  provided for a foreground (tracked) run — absent → no button. */
  onAttachDebugger?: () => void;
  /** Docked, single-row treatment used above the phone composer. */
  compact?: boolean;
}

/** One compact progress row per child job: status icon, brief/label, current
 *  activity — clickable through to the lane's own conversation when it is
 *  persisted. The header above stays the parent's (activeNode is never
 *  touched by lane events), so dispatch, join and the post-join synthesis
 *  step all remain visible while the rows tell the per-worker story. */
const LaneRow: React.FC<{ lane: LiveLane; onOpenLane?: (conversationId: string) => void }> = ({ lane, onOpenLane }) => {
  const { t } = useI18n();
  const clickable = !!lane.laneConversationId && !!onOpenLane;
  const pending = lane.status === 'pending';
  return (
    <Box
      onClick={clickable ? () => onOpenLane!(lane.laneConversationId!) : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        ...(clickable && {
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover', textDecoration: 'underline' },
        }),
      }}
    >
      {lane.status === 'running' && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}
      {lane.status === 'completed' && <CheckCircleIcon sx={{ fontSize: 16, flexShrink: 0 }} color="success" />}
      {lane.status === 'error' && <CancelIcon sx={{ fontSize: 16, flexShrink: 0 }} color="error" />}
      {pending && <RadioButtonUncheckedIcon sx={{ fontSize: 16, flexShrink: 0 }} color="disabled" />}
      <Typography
        variant="caption"
        color={pending ? 'text.disabled' : 'textSecondary'}
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {lane.label}
        {pending && ` — ${t('chat.live.queued')}`}
        {lane.status === 'running' && lane.activity && (
          <Typography component="span" variant="caption" color="text.disabled">
            {' · '}{lane.activity}
          </Typography>
        )}
      </Typography>
    </Box>
  );
};

/** Summary caption for the child block; switches to the warning-colored
 *  partial-failure marker once every job is terminal and some failed. */
/**
 * The "Running… N tokens · Ns elapsed" indicator with its own 1-second tick.
 *
 * The tick lives HERE, not in the Chat container: when it sat in Chat, every
 * second re-rendered the entire component tree — including every message
 * bubble with its markdown parse — for the whole duration of a run. Mounted
 * only while the viewed conversation is running, so the interval's lifecycle
 * is simply this component's lifecycle.
 */
const LiveRunIndicator: React.FC<LiveRunIndicatorProps> = ({ liveStats, onStop, stopDisabled, awaitingApproval, lanes, onOpenLane, onAttachDebugger, compact = false }) => {
  const { locale, t, tp, formatNumber, formatList } = useI18n();
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [mountedAt] = useState<number>(() => Date.now());
  // Once armed, the pause fires at the next node and this component unmounts
  // (the debugger panel takes over), so the transient "Attaching…" state clears
  // itself. Guards against re-arming with repeated clicks in the meantime.
  const [attaching, setAttaching] = useState(false);
  const [compactExpanded, setCompactExpanded] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = liveStats ? Math.max(0, Math.round((nowTick - liveStats.startedAt) / 1000)) : 0;
  const sinceLast = liveStats ? Math.round((nowTick - liveStats.lastEventAt) / 1000) : 0;
  const stuck = !awaitingApproval && !!liveStats && sinceLast >= 60;
  const messageStartedAt = liveStats?.startedAt ?? mountedAt;
  const messageSequence = Math.floor(
    Math.max(0, nowTick - messageStartedAt) / WORKING_MESSAGE_INTERVAL_MS,
  );
  const workingMessage = locale === 'en'
    ? getWorkingMessage(messageSequence, messageStartedAt)
    : t(`chat.live.working.${messageSequence % 6}` as any);

  const laneRows = lanes ? laneList(lanes) : [];
  const summary = laneRows.length > 0 ? (() => {
    const running = laneRows.filter(lane => lane.status === 'running').length;
    const queued = laneRows.filter(lane => lane.status === 'pending').length;
    const done = laneRows.filter(lane => lane.status === 'completed').length;
    const failed = laneRows.filter(lane => lane.status === 'error').length;
    if (running === 0 && queued === 0 && failed > 0) {
      return {
        text: t('chat.live.partialFailure', { failed: formatNumber(failed), total: formatNumber(laneRows.length) }),
        warning: true,
      };
    }
    const parts = [
      running > 0 ? tp('chat.live.laneRunning', running) : '',
      queued > 0 ? tp('chat.live.laneQueued', queued) : '',
      done > 0 ? tp('chat.live.laneDone', done) : '',
      failed > 0 ? tp('chat.live.laneFailed', failed) : '',
    ].filter(Boolean);
    return {
      text: tp('chat.live.lanes', laneRows.length, { states: formatList(parts) }),
      warning: failed > 0,
    };
  })() : null;

  if (compact) {
    const status = awaitingApproval
      ? t('chat.live.waitingApproval')
      : liveStats?.activeNode
        ? t('chat.live.running', { node: liveStats.activeNode })
        : t('chat.live.working');

    return (
      <Box
        data-testid="compact-live-run"
        sx={{
          flexShrink: 0,
          bgcolor: 'background.paper',
          borderTop: 1,
          borderBottom: 1,
          borderColor: 'divider',
          boxShadow: '0 -8px 24px rgba(0,0,0,.10)',
          position: 'relative',
          zIndex: 3,
        }}
      >
        <Box sx={{ minHeight: 44, px: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {awaitingApproval ? (
            <PauseCircleOutlineIcon fontSize="small" color="warning" />
          ) : (
            <CircularProgress size={18} color={stuck ? 'warning' : 'primary'} />
          )}
          <Typography variant="body2" noWrap aria-live="polite" sx={{ flex: 1, minWidth: 0 }}>
            {status}
          </Typography>
          {!awaitingApproval && (
            <Typography variant="caption" color={stuck ? 'warning.main' : 'text.secondary'} sx={{ whiteSpace: 'nowrap' }}>
              {formatNumber(liveStats?.totalTokens ?? 0)} · {formatNumber(elapsed)}s
            </Typography>
          )}
          {summary && (
            <Tooltip title={summary.text}>
              <IconButton
                size="small"
                onClick={() => setCompactExpanded(open => !open)}
                aria-label={summary.text}
                aria-expanded={compactExpanded}
              >
                {compactExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            </Tooltip>
          )}
          {onAttachDebugger && !awaitingApproval && (
            <Tooltip title={attaching ? t('chat.live.attaching') : t('chat.live.attach')}>
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={() => { setAttaching(true); onAttachDebugger(); }}
                  disabled={attaching}
                  aria-label={attaching ? t('chat.live.attaching') : t('chat.live.attach')}
                >
                  <BugReportIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Button
            variant="outlined"
            color="secondary"
            size="small"
            onClick={onStop}
            disabled={stopDisabled}
            sx={{ minWidth: 'auto', px: 1 }}
          >
            {t('chat.live.stop')}
          </Button>
        </Box>
        {!awaitingApproval && (
          <Typography
            data-testid="compact-working-message"
            variant="body2"
            color="text.primary"
            aria-live="polite"
            sx={{
              px: 1.5,
              pb: 0.75,
              fontSize: '0.8125rem',
              fontWeight: 500,
              lineHeight: 1.35,
              textAlign: 'center',
              overflowWrap: 'anywhere',
            }}
          >
            {workingMessage}
          </Typography>
        )}
        {summary && (
          <Collapse in={compactExpanded} unmountOnExit>
            <Box sx={{ px: 1, pb: 1 }}>
              <Typography
                variant="caption"
                color={summary.warning ? 'warning.main' : 'text.secondary'}
                sx={{ display: 'block', mb: 0.25 }}
              >
                {summary.text}
              </Typography>
              {laneRows.map(lane => (
                <LaneRow key={lane.laneIndex} lane={lane} onOpenLane={onOpenLane} />
              ))}
            </Box>
          </Collapse>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', my: 2, gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {awaitingApproval ? (
          <PauseCircleOutlineIcon fontSize="small" color="warning" />
        ) : (
          <CircularProgress size={20} color={stuck ? 'warning' : 'primary'} />
        )}
        <Typography variant="body2" color="textSecondary">
          {awaitingApproval
            ? t('chat.live.waitingApproval')
            : liveStats?.activeNode ? t('chat.live.running', { node: liveStats.activeNode }) : t('chat.live.working')}
        </Typography>
        {onAttachDebugger && !awaitingApproval && (
          <Button
            variant="outlined"
            color="primary"
            size="small"
            startIcon={<BugReportIcon fontSize="small" />}
            onClick={() => { setAttaching(true); onAttachDebugger(); }}
            disabled={attaching}
          >
            {attaching ? t('chat.live.attaching') : t('chat.live.attach')}
          </Button>
        )}
        <Button
          variant="outlined"
          color="secondary"
          size="small"
          onClick={onStop}
          disabled={stopDisabled}
        >
          {t('chat.live.stop')}
        </Button>
      </Box>
      {!awaitingApproval && (
        <Typography
          variant="body2"
          color="text.primary"
          sx={{
            maxWidth: 680,
            px: 2,
            py: 0.5,
            borderRadius: 1,
            bgcolor: 'action.hover',
            fontSize: '0.875rem',
            fontWeight: 500,
            lineHeight: 1.45,
            textAlign: 'center',
            overflowWrap: 'anywhere',
          }}
          aria-live="polite"
        >
          {workingMessage}
        </Typography>
      )}
      {summary && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 280, maxWidth: 520 }}>
          <Typography
            variant="caption"
            color={summary.warning ? 'warning.main' : 'textSecondary'}
            sx={{ px: 1, fontWeight: 500 }}
          >
            {summary.text}
          </Typography>
          {laneRows.map(lane => (
            <LaneRow key={lane.laneIndex} lane={lane} onOpenLane={onOpenLane} />
          ))}
        </Box>
      )}
      {!awaitingApproval && (
        <Typography variant="caption" color={stuck ? 'warning.main' : 'textSecondary'}>
          {tp('chat.live.elapsed', elapsed, {
            tokens: t('chat.stats.tokens', { count: formatNumber(liveStats?.totalTokens ?? 0) }),
          })}
          {stuck ? ` · ${tp('chat.live.inactive', sinceLast)}` : ''}
        </Typography>
      )}
    </Box>
  );
};

export default LiveRunIndicator;

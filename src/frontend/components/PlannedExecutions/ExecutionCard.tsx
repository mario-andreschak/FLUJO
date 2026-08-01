"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import { RunRecord, RunRecordStatus } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';
import { describeTrigger } from './triggerSummary';

/** How many run records to show before the "Load more" button. */
const RUNS_PAGE_SIZE = 10;

/** Status → theme color, mirroring the chat sidebar's conversation dots. */
const statusColor = (status: RunRecordStatus) => {
  switch (status) {
    case 'completed': return 'success.main';
    case 'error': return 'error.main';
    case 'skipped': return 'warning.main';
    default: return 'transparent';
  }
};

const formatDuration = (record: RunRecord, t: Translator, formatNumber: (value: number) => string) => {
  if (!record.finishedAt) return '';
  const ms = new Date(record.finishedAt).getTime() - new Date(record.firedAt).getTime();
  if (ms < 1000) return t('automations.card.lessThanSecond');
  const count = Math.round(ms < 60_000 ? ms / 1000 : ms / 60_000);
  return t(ms < 60_000 ? 'automations.card.seconds' : 'automations.card.minutes', {
    count: formatNumber(count),
  });
};

const runStatusLabel = (status: RunRecordStatus, t: Translator) => {
  switch (status) {
    case 'completed': return t('automations.card.status.completed');
    case 'error': return t('automations.card.status.error');
    case 'skipped': return t('automations.card.status.skipped');
    default: return t('automations.card.status.running');
  }
};

/**
 * Truthful one-line status for the card (issue #118). Replaces the old bare
 * "Not armed", which read as "this trigger is broken" even when the only cause
 * was the global pause switch. Precedence:
 *  - a disabled execution shows nothing here (the "Off" chip already says so);
 *  - a scheduled trigger with a next fire time shows "Next run: …";
 *  - a globally-paused (but enabled) execution shows "Paused (global)";
 *  - an armed "waiting" trigger (file-watch/webhook/poll — no nextRun) shows a
 *    POSITIVE confirmation ("Watching…"/"Listening…") instead of a blank line;
 *  - anything else that is enabled but not armed falls back to "Not armed".
 */
const statusLine = (
  entry: PlannedExecutionListEntry,
  t: Translator,
  formatTime: (iso?: string) => string,
): string => {
  const { execution, status } = entry;
  if (!execution.enabled) return '';
  if (status.nextRun) return t('automations.card.nextRun', { time: formatTime(status.nextRun) });
  if (status.notArmedReason === 'paused') return t('automations.card.pausedGlobal');
  if (status.armed) {
    switch (execution.trigger.type) {
      case 'webhook':
        return t('automations.card.listeningWebhook');
      case 'file-watch':
        return t('automations.card.watchingPath', { path: execution.trigger.path });
      case 'mcp-poll':
      case 'url-watch':
        return t('automations.card.watchingChanges');
      case 'flow-event':
        return t('automations.card.waitingFlowEvent');
      default:
        return t('automations.card.armed');
    }
  }
  return t('automations.card.notArmed');
};

interface ExecutionCardProps {
  entry: PlannedExecutionListEntry;
  /** Global pause switch state — gates every trigger (issue #118). */
  paused: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  /** Existing folder names offered by the shared folder picker. */
  folders: string[];
  /** Assign or clear this execution's organizing folder. */
  onSetFolder: (folder: string | undefined) => void;
  /** Called after a manual run finishes so the list can refresh lastRun. */
  onRanNow: () => void;
}

const ExecutionCard = ({
  entry,
  paused,
  folders,
  onEdit,
  onDelete,
  onToggleEnabled,
  onSetFolder,
  onRanNow,
}: ExecutionCardProps) => {
  const { t, tp, formatDate, formatNumber } = useI18n();
  const { execution, status, lastRun } = entry;
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [visibleCount, setVisibleCount] = useState(RUNS_PAGE_SIZE);
  const [folderAnchorEl, setFolderAnchorEl] = useState<null | HTMLElement>(null);
  const formatTime = (iso?: string) => iso
    ? formatDate(iso, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const loaded = await plannedExecutionsService.loadRuns(execution.id);
    // Newest first for display.
    setRuns([...loaded].reverse());
    // Start each (re)load at the first page; older runs are revealed on demand.
    setVisibleCount(RUNS_PAGE_SIZE);
    setLoadingRuns(false);
  }, [execution.id]);

  // Reload on expand AND whenever the list poller reports a fresh last run,
  // so an expanded history keeps up with background fires (webhooks, schedules).
  useEffect(() => {
    if (expanded) {
      void loadRuns();
    }
  }, [expanded, loadRuns, lastRun?.runId]);

  const handleRunNow = async () => {
    setRunningNow(true);
    await plannedExecutionsService.runNow(execution.id);
    setRunningNow(false);
    if (expanded) {
      void loadRuns();
    }
    onRanNow();
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1, minWidth: 220 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {execution.name}
            </Typography>
            <Chip size="small" label={describeTrigger(execution.trigger, t)} />
            {execution.exclusive && (
              <Tooltip title={t('automations.card.exclusiveHelp')}>
                <Chip size="small" color="secondary" label={t('automations.card.exclusive')} />
              </Tooltip>
            )}
            {!execution.enabled && <Chip size="small" label={t('automations.card.off')} variant="outlined" />}
            {execution.folder && (
              <Chip
                size="small"
                variant="outlined"
                icon={<FolderOutlinedIcon />}
                label={execution.folder}
              />
            )}
          </Box>
          {status.running ? (
            // Live "in flight" state (issue #50): shown as soon as a run starts,
            // independent of saveConversations, and cleared within a poll of it
            // finishing. Takes precedence over the "Next run" line.
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
              <CircularProgress size={12} thickness={6} />
              <Typography variant="body2" color="text.secondary">
                {status.runningSince
                  ? t('automations.card.runningSince', { time: formatTime(status.runningSince) })
                  : t('automations.card.running')}
              </Typography>
            </Box>
          ) : status.blockedByExclusive ? (
            // A non-exclusive execution held off because an exclusive one holds
            // (or is waiting for) the scheduler-global lock (issue #171).
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('automations.card.blockedExclusive')}
              {status.lastTriggerError
                ? ` — ${t('automations.card.triggerError', { error: status.lastTriggerError })}`
                : ''}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {statusLine(entry, t, formatTime)}
              {status.lastTriggerError
                ? ` — ${t('automations.card.triggerError', { error: status.lastTriggerError })}`
                : ''}
            </Typography>
          )}
          {lastRun && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
              <Tooltip title={runStatusLabel(lastRun.status, t)}>
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    bgcolor: statusColor(lastRun.status),
                    flexShrink: 0,
                  }}
                />
              </Tooltip>
              <Typography variant="body2" color="text.secondary">
                {t('automations.card.lastRun', { time: formatTime(lastRun.firedAt) })}
                {lastRun.status === 'error' && lastRun.error ? ` — ${lastRun.error}` : ''}
              </Typography>
            </Box>
          )}
        </Box>

        <Tooltip title={t('automations.card.runNow')}>
          <span>
            <IconButton onClick={handleRunNow} disabled={runningNow} color="primary">
              {runningNow ? <CircularProgress size={20} /> : <PlayArrowIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip
          title={
            paused
              ? t('automations.card.pausedHelp')
              : execution.enabled
                ? t('automations.card.turnOff')
                : t('automations.card.turnOn')
          }
        >
          <Switch
            checked={execution.enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
        </Tooltip>
        <Tooltip title={t('automations.card.edit')}>
          <IconButton onClick={onEdit}>
            <EditIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={execution.folder
          ? t('automations.card.folder', { folder: execution.folder })
          : t('automations.card.moveFolder')}>
          <IconButton
            onClick={(event) => setFolderAnchorEl(event.currentTarget)}
            color={execution.folder ? 'primary' : 'default'}
            aria-label={t('automations.card.moveFolderAria')}
          >
            <DriveFileMoveOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('automations.card.delete')}>
          <IconButton onClick={onDelete}>
            <DeleteIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={expanded
          ? t('automations.card.hideHistory')
          : t('automations.card.showHistory')}>
          <IconButton onClick={() => setExpanded(v => !v)}>
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Tooltip>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          {loadingRuns && !runs && (
            <Typography variant="body2" color="text.secondary">{t('automations.card.loadingRuns')}</Typography>
          )}
          {runs && runs.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t('automations.card.noRuns')}
            </Typography>
          )}
          {runs?.slice(0, visibleCount).map(record => (
            <Box
              key={record.runId}
              sx={{
                display: 'flex',
                gap: 1,
                py: 0.75,
                alignItems: 'flex-start',
                '&:hover .run-detail-button': { opacity: 1 },
              }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  bgcolor: statusColor(record.status),
                  mt: '5px',
                  flexShrink: 0,
                }}
              />
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography variant="body2">
                  {formatTime(record.firedAt)}
                  {formatDuration(record, t, formatNumber) ? ` · ${formatDuration(record, t, formatNumber)}` : ''}
                  {' · '}{record.triggerSummary}
                  {record.usage?.totalTokens
                    ? ` · ${t('automations.card.tokens', { count: formatNumber(record.usage.totalTokens) })}`
                    : ''}
                </Typography>
                {record.error && (
                  <Typography variant="body2" color="error">
                    {record.error}
                  </Typography>
                )}
                {record.outputText && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {record.outputText}
                  </Typography>
                )}
              </Box>
              <Tooltip title={t('automations.card.fullOutput')}>
                <IconButton
                  className="run-detail-button"
                  size="small"
                  onClick={() => setDetail(record)}
                  sx={{ opacity: { xs: 1, md: 0.35 }, transition: 'opacity 120ms', flexShrink: 0 }}
                >
                  <OpenInFullIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
          {runs && runs.length > visibleCount && (
            <Button
              size="small"
              onClick={() => setVisibleCount(c => c + RUNS_PAGE_SIZE)}
              sx={{ mt: 1 }}
            >
              {tp('automations.card.loadOlder', runs.length - visibleCount)}
            </Button>
          )}
        </Box>
      </Collapse>

      <FolderAssignMenu
        anchorEl={folderAnchorEl}
        open={Boolean(folderAnchorEl)}
        currentFolder={execution.folder}
        folders={folders}
        onClose={() => setFolderAnchorEl(null)}
        onAssign={onSetFolder}
      />

      <Dialog open={detail !== null} onClose={() => setDetail(null)} maxWidth="md" fullWidth>
        <DialogTitle component="div">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: detail ? statusColor(detail.status) : 'transparent',
                flexShrink: 0,
              }}
            />
            <Typography variant="h6">
              {execution.name} — {detail ? formatTime(detail.firedAt) : ''}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {detail && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {runStatusLabel(detail.status, t)}
                {formatDuration(detail, t, formatNumber) ? ` · ${formatDuration(detail, t, formatNumber)}` : ''}
                {' · '}{detail.triggerSummary}
                {detail.usage?.totalTokens
                  ? ` · ${t('automations.card.tokenBreakdown', {
                      total: formatNumber(detail.usage.totalTokens),
                      input: formatNumber(detail.usage.promptTokens),
                      output: formatNumber(detail.usage.completionTokens),
                    })}`
                  : ''}
              </Typography>
              {detail.error && (
                <Typography variant="body2" color="error" sx={{ mb: 1.5, whiteSpace: 'pre-wrap' }}>
                  {detail.error}
                </Typography>
              )}
              {detail.outputText ? (
                <Box
                  sx={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    p: 2,
                    fontSize: 14,
                    maxHeight: '55vh',
                    overflow: 'auto',
                  }}
                >
                  {detail.outputText}
                </Box>
              ) : (
                !detail.error && (
                  <Typography variant="body2" color="text.secondary">
                    {t('automations.card.noOutput')}
                  </Typography>
                )
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail(null)}>{t('automations.card.close')}</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};

export default ExecutionCard;

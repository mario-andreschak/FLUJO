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
import { RunRecord, RunRecordStatus } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
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

const formatTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

const formatDuration = (record: RunRecord) => {
  if (!record.finishedAt) return '';
  const ms = new Date(record.finishedAt).getTime() - new Date(record.firedAt).getTime();
  if (ms < 1000) return '<1s';
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`;
};

interface ExecutionCardProps {
  entry: PlannedExecutionListEntry;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  /** Called after a manual run finishes so the list can refresh lastRun. */
  onRanNow: () => void;
}

const ExecutionCard = ({ entry, onEdit, onDelete, onToggleEnabled, onRanNow }: ExecutionCardProps) => {
  const { execution, status, lastRun } = entry;
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [visibleCount, setVisibleCount] = useState(RUNS_PAGE_SIZE);

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
            <Chip size="small" label={describeTrigger(execution.trigger)} />
            {!execution.enabled && <Chip size="small" label="Off" variant="outlined" />}
          </Box>
          {status.running ? (
            // Live "in flight" state (issue #50): shown as soon as a run starts,
            // independent of saveConversations, and cleared within a poll of it
            // finishing. Takes precedence over the "Next run" line.
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
              <CircularProgress size={12} thickness={6} />
              <Typography variant="body2" color="text.secondary">
                Running…{status.runningSince ? ` — started ${formatTime(status.runningSince)}` : ''}
              </Typography>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {status.nextRun && execution.enabled
                ? `Next run: ${formatTime(status.nextRun)}`
                : execution.enabled && !status.armed
                  ? 'Not armed'
                  : ''}
              {status.lastTriggerError ? ` — trigger error: ${status.lastTriggerError}` : ''}
            </Typography>
          )}
          {lastRun && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
              <Tooltip title={lastRun.status}>
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
                Last run {formatTime(lastRun.firedAt)}
                {lastRun.status === 'error' && lastRun.error ? ` — ${lastRun.error}` : ''}
              </Typography>
            </Box>
          )}
        </Box>

        <Tooltip title="Run now">
          <span>
            <IconButton onClick={handleRunNow} disabled={runningNow} color="primary">
              {runningNow ? <CircularProgress size={20} /> : <PlayArrowIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={execution.enabled ? 'Turn off' : 'Turn on'}>
          <Switch
            checked={execution.enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
        </Tooltip>
        <Tooltip title="Edit">
          <IconButton onClick={onEdit}>
            <EditIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete">
          <IconButton onClick={onDelete}>
            <DeleteIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={expanded ? 'Hide run history' : 'Show run history'}>
          <IconButton onClick={() => setExpanded(v => !v)}>
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Tooltip>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          {loadingRuns && !runs && (
            <Typography variant="body2" color="text.secondary">Loading runs…</Typography>
          )}
          {runs && runs.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No runs yet. Use the play button to try it now.
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
                  {formatDuration(record) ? ` · ${formatDuration(record)}` : ''}
                  {' · '}{record.triggerSummary}
                  {record.usage?.totalTokens ? ` · ${record.usage.totalTokens.toLocaleString()} tokens` : ''}
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
              <Tooltip title="Show full output">
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
              Load more ({runs.length - visibleCount} older)
            </Button>
          )}
        </Box>
      </Collapse>

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
                {detail.status}
                {formatDuration(detail) ? ` · ${formatDuration(detail)}` : ''}
                {' · '}{detail.triggerSummary}
                {detail.usage?.totalTokens
                  ? ` · ${detail.usage.totalTokens.toLocaleString()} tokens (${detail.usage.promptTokens.toLocaleString()} in / ${detail.usage.completionTokens.toLocaleString()} out)`
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
                    This run produced no output text.
                  </Typography>
                )
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};

export default ExecutionCard;

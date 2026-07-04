"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Collapse,
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
import { RunRecord, RunRecordStatus } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
import { describeTrigger } from './triggerSummary';

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

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const loaded = await plannedExecutionsService.loadRuns(execution.id);
    // Newest first for display.
    setRuns([...loaded].reverse());
    setLoadingRuns(false);
  }, [execution.id]);

  useEffect(() => {
    if (expanded) {
      void loadRuns();
    }
  }, [expanded, loadRuns]);

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
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {status.nextRun && execution.enabled
              ? `Next run: ${formatTime(status.nextRun)}`
              : execution.enabled && !status.armed
                ? 'Not armed'
                : ''}
            {status.lastTriggerError ? ` — trigger error: ${status.lastTriggerError}` : ''}
          </Typography>
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
          {runs?.map(record => (
            <Box
              key={record.runId}
              sx={{ display: 'flex', gap: 1, py: 0.75, alignItems: 'flex-start' }}
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
              <Box sx={{ minWidth: 0 }}>
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
            </Box>
          ))}
        </Box>
      </Collapse>
    </Paper>
  );
};

export default ExecutionCard;

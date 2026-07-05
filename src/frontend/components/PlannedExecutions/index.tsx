"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import { IconButton, Tooltip } from '@mui/material';
import { PlannedExecution } from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionListEntry,
} from '@/frontend/services/plannedExecutions';
import { createLogger } from '@/utils/logger';
import ExecutionCard from './ExecutionCard';
import ExecutionModal from './ExecutionModal';

const log = createLogger('frontend/components/PlannedExecutions');

/**
 * Planned Executions page: manage flows that run headlessly on triggers.
 */
const PlannedExecutionsManager = () => {
  const [entries, setEntries] = useState<PlannedExecutionListEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedExecution | null>(null);
  const [deleting, setDeleting] = useState<PlannedExecution | null>(null);

  const refresh = useCallback(async () => {
    const response = await plannedExecutionsService.list();
    setEntries(response.executions);
    setPaused(response.paused);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Triggers fire in the background (schedules, external webhooks, watchers),
  // so poll for fresh statuses while the page is actually being looked at.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleTogglePaused = async (nextPaused: boolean) => {
    setPaused(nextPaused); // optimistic
    const result = await plannedExecutionsService.setPaused(nextPaused);
    if (!result.success) {
      log.warn('Failed to toggle pause', result.error);
    }
    void refresh();
  };

  const handleToggleEnabled = async (execution: PlannedExecution, enabled: boolean) => {
    await plannedExecutionsService.update(execution.id, { enabled });
    void refresh();
  };

  const handleDelete = async () => {
    if (!deleting) return;
    await plannedExecutionsService.delete(deleting.id);
    setDeleting(null);
    void refresh();
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto', width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 2,
          mb: 1,
        }}
      >
        <Typography variant="h5">Planned Executions</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Tooltip title="Refresh">
            <IconButton onClick={() => void refresh()}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <FormControlLabel
            control={
              <Switch
                checked={!paused}
                onChange={(e) => handleTogglePaused(!e.target.checked)}
              />
            }
            label={paused ? 'Paused' : 'Active'}
          />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
            data-tour="add-execution"
          >
            Add
          </Button>
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Run your flows automatically — on a schedule or when something happens —
        without opening the chat. FLUJO must be running for triggers to fire.
      </Typography>

      {loaded && entries.length === 0 && (
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            borderStyle: 'dashed',
            p: 6,
            textAlign: 'center',
          }}
        >
          <Typography variant="h6" sx={{ mb: 1 }}>
            Nothing planned yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Create your first planned execution to run a flow on a schedule.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            New planned execution
          </Button>
        </Box>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {entries.map(entry => (
          <ExecutionCard
            key={entry.execution.id}
            entry={entry}
            onEdit={() => {
              setEditing(entry.execution);
              setModalOpen(true);
            }}
            onDelete={() => setDeleting(entry.execution)}
            onToggleEnabled={(enabled) => handleToggleEnabled(entry.execution, enabled)}
            onRanNow={() => void refresh()}
          />
        ))}
      </Box>

      <ExecutionModal
        open={modalOpen}
        execution={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => void refresh()}
      />

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)}>
        <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This removes the planned execution and its run history. The flow
            itself is not affected.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PlannedExecutionsManager;

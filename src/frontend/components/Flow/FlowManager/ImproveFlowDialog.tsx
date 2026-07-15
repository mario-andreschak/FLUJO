"use client";

/**
 * "AI-Improve" dialog (issue #99): describe the changes you want to an EXISTING flow in
 * plain language, pick which configured model does the revising, and get back the flow
 * revised as an UNSAVED draft that the FlowBuilder applies to the canvas for review.
 * Improving runs entirely backend-side (POST /api/flow/improve); this dialog never sees
 * key material. It operates on the current (possibly edited-but-unsaved) canvas state,
 * passed in via `currentFlow`.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  TextField,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { Flow } from '@/frontend/types/flow/flow';
import { Model } from '@/shared/types/model';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/ImproveFlowDialog');

export interface ImprovedFlowInfo {
  /** The revised flow (same id as the flow that was sent) applied to the builder canvas. */
  flow: Flow;
  errorCount: number;
  warningCount: number;
  attempts: number;
  /** MCP servers the improver installed during this run (allowInstall only). */
  installedServers: Array<{ name: string; tools: string[]; alreadyExisted?: boolean }>;
}

interface ImproveFlowDialogProps {
  open: boolean;
  onClose: () => void;
  /** The current flow to improve (assembled from the live canvas state, incl. unsaved edits). */
  currentFlow: Flow;
  /** Called with the revised flow when improvement succeeds; the builder applies it. */
  onImproved: (result: ImprovedFlowInfo) => void;
  /** Pre-fills the change description each time the dialog opens (e.g. AI-supported repair). */
  initialDescription?: string;
}

const ImproveFlowDialog = ({ open, onClose, currentFlow, onImproved, initialDescription }: ImproveFlowDialogProps) => {
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [allowInstall, setAllowInstall] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the description from `initialDescription` each time the dialog opens (used by
  // AI-supported repair to pre-fill the repair instruction; the user can still edit it).
  useEffect(() => {
    if (open) setDescription(initialDescription ?? '');
  }, [open, initialDescription]);

  // Load the configured models when the dialog opens (frontend model list is masked).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    modelService
      .loadModels()
      .then((loaded) => {
        if (cancelled) return;
        setModels(loaded);
        setModelId((prev) => (loaded.some((m) => m.id === prev) ? prev : loaded[0]?.id ?? ''));
      })
      .catch((err) => {
        log.warn('Failed to load models for the improve dialog', err);
        if (!cancelled) setError('Could not load your models. Configure a model first.');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = useCallback(() => {
    if (isImproving) return; // no closing mid-flight; the request is not cancellable
    setError(null);
    onClose();
  }, [isImproving, onClose]);

  const handleImprove = useCallback(async () => {
    setError(null);
    setIsImproving(true);
    try {
      // Snapshot the flow as it is now so mid-flight canvas edits can't corrupt the result.
      const snapshot: Flow = {
        ...currentFlow,
        nodes: [...currentFlow.nodes],
        edges: [...currentFlow.edges],
      };
      const result = await flowService.improveFlow(snapshot, description.trim(), modelId, { allowInstall });
      if (!result.success) {
        setError(result.error);
        return;
      }
      log.info('Flow improved', {
        flowId: result.flow.id,
        attempts: result.attempts,
        errors: result.validation.errorCount,
        warnings: result.validation.warningCount,
        installedServers: result.installedServers.length,
      });
      setDescription('');
      onImproved({
        flow: result.flow,
        errorCount: result.validation.errorCount,
        warningCount: result.validation.warningCount,
        attempts: result.attempts,
        installedServers: result.installedServers,
      });
    } finally {
      setIsImproving(false);
    }
  }, [currentFlow, description, modelId, allowInstall, onImproved]);

  const canImprove = !isImproving && description.trim().length > 0 && !!modelId;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Improve this flow with AI</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Describe the changes you want — add or remove a step, rewrite a prompt, wire up a
          tool, rename a node. The model revises the <strong>current</strong> flow and the
          result opens on the canvas as an unsaved change you can review, undo, and save.
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={4}
          label="What should change?"
          placeholder="e.g. Add a step after the research that emails the summary, and make the research step use the full conversation"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isImproving}
          sx={{ mb: 2 }}
        />
        <FormControl fullWidth disabled={isImproving || models.length === 0}>
          <InputLabel id="improve-flow-model-label">Generator model</InputLabel>
          <Select
            labelId="improve-flow-model-label"
            label="Generator model"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <MenuItem key={m.id} value={m.id}>
                {m.displayName?.trim() || m.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControlLabel
          sx={{ mt: 2 }}
          control={
            <Checkbox
              checked={allowInstall}
              onChange={(e) => setAllowInstall(e.target.checked)}
              disabled={isImproving}
            />
          }
          label="Let the improver install MCP servers it needs (self-improve)"
        />
        {allowInstall && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The improver may <strong>download, install, and run third-party MCP servers</strong> from
            the public registry on this machine — without asking again. It prefers servers that need
            no API keys, but anything it installs executes real code with your user&apos;s permissions.
            Installed servers stay configured afterwards (remove them on the MCP page).
          </Alert>
        )}
        {isImproving && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
            <CircularProgress size={20} />
            <DialogContentText>
              {allowInstall
                ? 'Improving… the model may search the marketplace and install servers (this can take a few minutes).'
                : 'Improving… the model revises the flow and FLUJO checks it (this can take up to a minute).'}
            </DialogContentText>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isImproving}>
          Cancel
        </Button>
        <Button
          onClick={handleImprove}
          variant="contained"
          color="primary"
          startIcon={<AutoFixHighIcon />}
          disabled={!canImprove}
        >
          Improve
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ImproveFlowDialog;

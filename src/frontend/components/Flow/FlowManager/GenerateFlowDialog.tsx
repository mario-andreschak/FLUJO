"use client";

/**
 * "Generate flow" dialog (issue #14): describe a flow in plain language, pick which
 * configured model does the generating, and get back an UNSAVED draft that the flows
 * page opens in the FlowBuilder for review. Generation runs entirely backend-side
 * (POST /api/flow/generate); this dialog never sees key material.
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
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Flow } from '@/frontend/types/flow/flow';
import { Model } from '@/shared/types/model';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Flow/FlowManager/GenerateFlowDialog');

export interface GeneratedFlowInfo {
  /** The root draft flow (opened in the builder for review). */
  flow: Flow;
  /**
   * The whole draft bundle (root + auto-generated subflow descendants) in dependency order
   * (descendants first). Single-level drafts have just the root. The caller saves the
   * descendants before the root so every subflowId resolves.
   */
  flows: Flow[];
  rootFlowId: string;
  errorCount: number;
  warningCount: number;
  attempts: number;
  /** MCP servers the generator installed during this generation (allowInstall only). */
  installedServers: Array<{
    name: string;
    tools: string[];
    alreadyExisted?: boolean;
    command?: string;
    args?: string[];
    verificationStatus?: string;
  }>;
}

interface GenerateFlowDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the draft when generation succeeds; the caller opens it in the builder. */
  onGenerated: (result: GeneratedFlowInfo) => void;
}

const GenerateFlowDialog = ({ open, onClose, onGenerated }: GenerateFlowDialogProps) => {
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [allowInstall, setAllowInstall] = useState(false);
  const [allowSubflows, setAllowSubflows] = useState(false);
  const [maxDepth, setMaxDepth] = useState(2);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the configured models when the dialog opens (frontend model list is masked).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    modelService
      .loadModels()
      .then((loaded) => {
        if (cancelled) return;
        setModels(loaded);
        // Keep a previously picked model if it still exists; else default to the first.
        setModelId((prev) => (loaded.some((m) => m.id === prev) ? prev : loaded[0]?.id ?? ''));
      })
      .catch((err) => {
        log.warn('Failed to load models for the generate dialog', err);
        if (!cancelled) setError('Could not load your models. Configure a model first.');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = useCallback(() => {
    if (isGenerating) return; // no closing mid-flight; the request is not cancellable
    setError(null);
    onClose();
  }, [isGenerating, onClose]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    setIsGenerating(true);
    try {
      const result = await flowService.generateFlow(description.trim(), modelId, {
        allowInstall,
        allowSubflows,
        ...(allowSubflows ? { maxDepth } : {}),
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      log.info('Draft flow generated', {
        flowId: result.flow.id,
        flowCount: result.flows.length,
        attempts: result.attempts,
        errors: result.validation.errorCount,
        warnings: result.validation.warningCount,
        installedServers: result.installedServers.length,
      });
      setDescription('');
      onGenerated({
        flow: result.flow,
        flows: result.flows.map((f) => f.flow),
        rootFlowId: result.rootFlowId,
        errorCount: result.validation.errorCount,
        warningCount: result.validation.warningCount,
        attempts: result.attempts,
        installedServers: result.installedServers,
      });
    } finally {
      setIsGenerating(false);
    }
  }, [description, modelId, allowInstall, allowSubflows, maxDepth, onGenerated]);

  const canGenerate = !isGenerating && description.trim().length > 0 && !!modelId;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Generate a flow</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Describe what the flow should do — which steps, which tools, what the result is.
          The generated flow opens in the builder as a draft for you to review before saving.
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
          label="What should this flow do?"
          placeholder="e.g. Research a topic on the web, then summarize the findings as bullet points"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isGenerating}
          sx={{ mb: 2 }}
        />
        <FormControl fullWidth disabled={isGenerating || models.length === 0}>
          <InputLabel id="generate-flow-model-label">Generator model</InputLabel>
          <Select
            labelId="generate-flow-model-label"
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
              disabled={isGenerating}
            />
          }
          label="Let the generator install MCP servers it needs (self-improve)"
        />
        <FormControlLabel
          sx={{ mt: 1, display: 'flex' }}
          control={
            <Checkbox
              checked={allowSubflows}
              onChange={(e) => setAllowSubflows(e.target.checked)}
              disabled={isGenerating}
            />
          }
          label="Allow multi-level flows (auto-generate nested subflows)"
        />
        {allowSubflows && (
          <Box sx={{ mt: 1, ml: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <FormControl sx={{ maxWidth: 220 }} size="small" disabled={isGenerating}>
              <InputLabel id="generate-flow-depth-label">Max nesting depth</InputLabel>
              <Select
                labelId="generate-flow-depth-label"
                label="Max nesting depth"
                value={maxDepth}
                onChange={(e) => setMaxDepth(Number(e.target.value))}
              >
                <MenuItem value={1}>1 level</MenuItem>
                <MenuItem value={2}>2 levels</MenuItem>
                <MenuItem value={3}>3 levels</MenuItem>
              </Select>
            </FormControl>
            <Alert severity="info">
              The generator can design subflows that are themselves generated (up to a few
              flows total). This is slower and uses more tokens. You review the whole bundle
              before anything is saved.
            </Alert>
          </Box>
        )}
        {allowInstall && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The generator may <strong>download, install, and run third-party MCP servers</strong> from
            the public registry on this machine. It prefers servers that need no API keys, but anything
            it installs executes real code with your user&apos;s permissions. The <strong>exact command
            and arguments</strong> of every install are recorded (audited) before it runs, and each
            installed server is listed in the post-generation summary so you can review — and remove
            (on the MCP page) — exactly what was added.
          </Alert>
        )}
        {isGenerating && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
            <CircularProgress size={20} />
            <DialogContentText>
              {allowInstall
                ? 'Generating… the model may search the marketplace and install servers (this can take a few minutes).'
                : 'Generating… the model designs the flow and FLUJO checks it (this can take up to a minute).'}
            </DialogContentText>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isGenerating}>
          Cancel
        </Button>
        <Button
          onClick={handleGenerate}
          variant="contained"
          color="primary"
          startIcon={<AutoAwesomeIcon />}
          disabled={!canGenerate}
        >
          Generate
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default GenerateFlowDialog;

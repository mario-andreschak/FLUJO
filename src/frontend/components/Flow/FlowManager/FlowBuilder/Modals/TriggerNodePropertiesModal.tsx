"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
  Typography,
  Divider,
  Alert,
  CircularProgress,
  Snackbar,
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WebhookIcon from '@mui/icons-material/Webhook';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import LanguageIcon from '@mui/icons-material/Language';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import { FlowNode } from '@/frontend/types/flow/flow';
import {
  FileWatchTriggerConfig,
  FlowEventTriggerConfig,
  McpPollTriggerConfig,
  OverlapStrategy,
  ScheduleTriggerConfig,
  TriggerConfig,
  UrlWatchTriggerConfig,
  WebhookTriggerConfig,
} from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionInput,
} from '@/frontend/services/plannedExecutions';
import { flowService } from '@/frontend/services/flow';
import { Flow } from '@/frontend/types/flow/flow';
import OptionCard from '@/frontend/components/PlannedExecutions/OptionCard';
import SchedulePanel from '@/frontend/components/PlannedExecutions/SchedulePanel';
import WebhookPanel from '@/frontend/components/PlannedExecutions/WebhookPanel';
import FileWatchPanel from '@/frontend/components/PlannedExecutions/FileWatchPanel';
import WatchToolPanel from '@/frontend/components/PlannedExecutions/WatchToolPanel';
import UrlWatchPanel from '@/frontend/components/PlannedExecutions/UrlWatchPanel';
import FlowEventPanel from '@/frontend/components/PlannedExecutions/FlowEventPanel';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/FlowBuilder/Modals/TriggerNodePropertiesModal');

// Default trigger configs (mirrors ExecutionModal.tsx)
const DEFAULT_SCHEDULE: ScheduleTriggerConfig = { type: 'schedule', cron: '0 9 * * *' };
const newWebhookTrigger = (): WebhookTriggerConfig => ({
  type: 'webhook',
  token: crypto.randomUUID(),
});
const DEFAULT_FILE_WATCH: FileWatchTriggerConfig = {
  type: 'file-watch',
  path: '',
  events: ['add', 'change'],
};
const DEFAULT_MCP_POLL: McpPollTriggerConfig = {
  type: 'mcp-poll',
  serverName: '',
  toolName: '',
  args: {},
  cron: '*/5 * * * *',
  evaluate: { mode: 'on-change' },
};
const DEFAULT_URL_WATCH: UrlWatchTriggerConfig = {
  type: 'url-watch',
  url: '',
  cron: '*/15 * * * *',
};
const DEFAULT_FLOW_EVENT: FlowEventTriggerConfig = {
  type: 'flow-event',
  source: { flowId: '' },
  on: ['completed'],
};

interface TriggerNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  /** The current flow's id — used to link the PlannedExecution record. */
  flowId: string;
  onClose: () => void;
  /**
   * Called when the user saves. The caller should update the node data AND
   * sync the PlannedExecution to the API (see syncTriggerNode in FlowBuilder).
   */
  onSave: (nodeId: string, data: any) => void;
}

/**
 * Properties modal for the Trigger node (issue #241).
 *
 * The Trigger node lives on the FlowBuilder canvas above the Start node and
 * links to a PlannedExecution record — giving the user a first-class visual
 * representation of "this flow has a trigger" without navigating to
 * /planned-executions.
 *
 * All six trigger-type panels from the PlannedExecutions UI are reused here.
 */
const TriggerNodePropertiesModal = ({
  open,
  node,
  flowId,
  onClose,
  onSave,
}: TriggerNodePropertiesModalProps) => {
  const [name, setName] = useState('Flow Trigger');
  const [enabled, setEnabled] = useState(true);
  const [trigger, setTrigger] = useState<TriggerConfig>(DEFAULT_SCHEDULE);
  const [overlapStrategy, setOverlapStrategy] = useState<OverlapStrategy>('skip');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);

  // Stable execution id: pre-generated so webhook URL is visible before first save.
  // Stored in the node's properties once the user saves for the first time.
  const [executionId, setExecutionId] = useState(() => crypto.randomUUID());
  const [isSaved, setIsSaved] = useState(false);

  // Load data from the existing node on open
  useEffect(() => {
    if (!open || !node) return;
    setSaveError(null);
    const props = node.data.properties || {};
    setName(typeof props.name === 'string' ? props.name : 'Flow Trigger');
    setEnabled(props.enabled !== false);
    setTrigger((props.trigger as TriggerConfig) || DEFAULT_SCHEDULE);
    setOverlapStrategy((props.overlapStrategy as OverlapStrategy) || 'skip');
    setPrompt(typeof props.prompt === 'string' ? props.prompt : '');
    if (typeof props.executionId === 'string' && props.executionId) {
      setExecutionId(props.executionId);
      setIsSaved(true);
    } else {
      setExecutionId(crypto.randomUUID());
      setIsSaved(false);
    }
  }, [open, node]);

  // Load flows for the FlowEvent panel
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    flowService.loadFlows().then((loaded) => {
      if (!cancelled) setFlows(loaded || []);
    }).catch(() => {
      if (!cancelled) setFlows([]);
    });
    return () => { cancelled = true; };
  }, [open]);

  const handleSave = useCallback(async () => {
    if (!node) return;
    setSaving(true);
    setSaveError(null);

    const properties = {
      executionId,
      name,
      enabled,
      trigger,
      overlapStrategy,
      prompt,
    };

    // Synchronize first so a failed request never leaves the canvas pointing
    // at a planned execution that was not created or updated.
    const input: PlannedExecutionInput = {
      name: name.trim() || 'Flow Trigger',
      flowId,
      prompt,
      overlapStrategy,
      trigger,
      enabled,
    };

    try {
      let result;
      if (isSaved) {
        result = await plannedExecutionsService.update(executionId, input);
      } else {
        result = await plannedExecutionsService.create({ ...input, id: executionId });
      }
      if (!result.success) {
        setSaveError(result.error || 'Failed to save trigger configuration');
        setSaving(false);
        return;
      }
      setIsSaved(true);

      // Persist the node link only after the PlannedExecution API accepted it.
      const label = name.trim() || 'Trigger';
      onSave(node.id, {
        ...node.data,
        label,
        type: 'trigger',
        properties,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save trigger configuration');
      setSaving(false);
      return;
    }

    setSaving(false);
    log.info(`TriggerNodePropertiesModal: Saved trigger node for executionId=${executionId}`);
  }, [node, executionId, name, enabled, trigger, overlapStrategy, prompt, flowId, isSaved, onSave]);

  if (!node) return null;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            borderTop: 5,
            borderColor: '#E91E63',
            maxWidth: '95vw',
            maxHeight: '90vh',
          },
        }}
      >
        <DialogTitle component="div">
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Trigger Node</Typography>
            <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>

        <Divider />

        <DialogContent sx={{ p: 3 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            This node links a planned execution trigger to this flow. When the trigger fires,
            the flow will run headlessly. Configure the trigger below.
            {!isSaved && (
              <> The trigger will be created when you first save.</>
            )}
          </Alert>

          <TextField
            fullWidth
            label="Trigger name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            margin="normal"
            placeholder="e.g. Daily digest trigger"
          />

          <FormControlLabel
            control={
              <Switch
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                color="primary"
              />
            }
            label="Enabled"
            sx={{ mt: 1, mb: 1 }}
          />

          <Typography variant="subtitle1" sx={{ mt: 2, mb: 1, fontWeight: 600 }}>
            When should it run?
          </Typography>

          <Box role="radiogroup" aria-label="Trigger type" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <OptionCard
              selected={trigger.type === 'schedule'}
              onClick={() => {
                if (trigger.type !== 'schedule') setTrigger(DEFAULT_SCHEDULE);
              }}
              icon={<ScheduleIcon />}
              title="On a schedule"
              description="Run at fixed times — every few minutes, daily, on weekdays, or a custom rhythm."
            />
            <OptionCard
              selected={trigger.type === 'webhook'}
              onClick={() => {
                if (trigger.type !== 'webhook') setTrigger(newWebhookTrigger());
              }}
              icon={<WebhookIcon />}
              title="When called (webhook)"
              description="Other apps run this flow by calling a URL."
            />
            <OptionCard
              selected={trigger.type === 'file-watch'}
              onClick={() => {
                if (trigger.type !== 'file-watch') setTrigger(DEFAULT_FILE_WATCH);
              }}
              icon={<FolderOpenIcon />}
              title="When files change"
              description="Watch a folder on this computer and run when files appear, change, or disappear."
            />
            <OptionCard
              selected={trigger.type === 'mcp-poll'}
              onClick={() => {
                if (trigger.type !== 'mcp-poll') setTrigger(DEFAULT_MCP_POLL);
              }}
              icon={<TravelExploreIcon />}
              title="Watch a tool"
              description="Check one of your MCP tools regularly — run when its result changes."
            />
            <OptionCard
              selected={trigger.type === 'url-watch'}
              onClick={() => {
                if (trigger.type !== 'url-watch') setTrigger(DEFAULT_URL_WATCH);
              }}
              icon={<LanguageIcon />}
              title="When a website changes"
              description="Check a URL regularly and run when its content is different from the last check."
            />
            <OptionCard
              selected={trigger.type === 'flow-event'}
              onClick={() => {
                if (trigger.type !== 'flow-event') setTrigger(DEFAULT_FLOW_EVENT);
              }}
              icon={<AltRouteIcon />}
              title="When another flow finishes"
              description="React to another flow completing or erroring."
            />
          </Box>

          {trigger.type === 'schedule' && (
            <SchedulePanel
              cron={trigger.cron}
              timezone={trigger.timezone}
              onChange={({ cron, timezone }) => setTrigger({ ...trigger, cron, timezone })}
              catchUp={trigger.catchUp === true}
              onCatchUpChange={(catchUp) => setTrigger({ ...trigger, catchUp })}
            />
          )}
          {trigger.type === 'webhook' && (
            <WebhookPanel
              config={trigger}
              onChange={setTrigger}
              executionId={executionId}
              saved={isSaved}
            />
          )}
          {trigger.type === 'file-watch' && (
            <FileWatchPanel config={trigger} onChange={setTrigger} />
          )}
          {trigger.type === 'mcp-poll' && (
            <WatchToolPanel config={trigger} onChange={setTrigger} />
          )}
          {trigger.type === 'url-watch' && (
            <UrlWatchPanel config={trigger} onChange={setTrigger} />
          )}
          {trigger.type === 'flow-event' && (
            <FlowEventPanel
              config={trigger}
              onChange={setTrigger}
              flows={flows}
              currentExecutionId={executionId}
            />
          )}

          <FormControl fullWidth margin="normal">
            <InputLabel id="overlap-strategy-label">If it&apos;s already running…</InputLabel>
            <Select
              labelId="overlap-strategy-label"
              label="If it's already running…"
              value={overlapStrategy}
              onChange={(e) => setOverlapStrategy(e.target.value as OverlapStrategy)}
            >
              <MenuItem value="skip">Skip the new run (default)</MenuItem>
              <MenuItem value="queue">Queue it — run after the current one finishes</MenuItem>
              <MenuItem value="parallel">Run in parallel — allow concurrent runs</MenuItem>
              <MenuItem value="error">Reject the new run with an error</MenuItem>
            </Select>
          </FormControl>

          <TextField
            fullWidth
            label="Initial prompt (optional)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            margin="normal"
            multiline
            minRows={2}
            placeholder="Optional prompt override for the triggered run"
            helperText="Leave blank to use the flow's default prompt. When set, this overrides the Start node prompt template for runs fired by this trigger."
          />

          {saveError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {saveError}
            </Alert>
          )}
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleSave}
            variant="contained"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
            sx={{ backgroundColor: '#E91E63', '&:hover': { backgroundColor: '#C2185B' } }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default TriggerNodePropertiesModal;

"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WebhookIcon from '@mui/icons-material/Webhook';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import LanguageIcon from '@mui/icons-material/Language';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import {
  FileWatchTriggerConfig,
  McpPollTriggerConfig,
  PlannedExecution,
  ScheduleTriggerConfig,
  TriggerConfig,
  UrlWatchTriggerConfig,
  WebhookTriggerConfig,
} from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionInput,
} from '@/frontend/services/plannedExecutions';
import { createLogger } from '@/utils/logger';
import OptionCard from './OptionCard';
import SchedulePanel from './SchedulePanel';
import WebhookPanel from './WebhookPanel';
import FileWatchPanel from './FileWatchPanel';
import WatchToolPanel from './WatchToolPanel';
import UrlWatchPanel from './UrlWatchPanel';

const log = createLogger('frontend/components/PlannedExecutions/ExecutionModal');

const DEFAULT_SCHEDULE: ScheduleTriggerConfig = { type: 'schedule', cron: '0 9 * * *' };
const newWebhookTrigger = (): WebhookTriggerConfig => ({
  type: 'webhook',
  // Generated client-side so the URL + token are visible BEFORE the first
  // save; the backend keeps a provided token as-is.
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

interface ExecutionModalProps {
  open: boolean;
  /** null = create a new execution. */
  execution: PlannedExecution | null;
  onClose: () => void;
  /** Called after a successful create/update so the list can refresh. */
  onSaved: () => void;
}

/**
 * Create/edit modal for a planned execution: name → flow → trigger → prompt.
 * Trigger types beyond Schedule land in follow-up slices and extend the
 * radio-card row below.
 */
const ExecutionModal = ({ open, execution, onClose, onSaved }: ExecutionModalProps) => {
  const [name, setName] = useState('');
  const [flowId, setFlowId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saveConversations, setSaveConversations] = useState(false);
  const [trigger, setTrigger] = useState<TriggerConfig>(DEFAULT_SCHEDULE);
  // Pre-generated id for NEW executions, so trigger types whose config is
  // id-derived (the webhook URL) can be shown before the first save.
  const [draftId, setDraftId] = useState('');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the form from the execution being edited (or to defaults) on open.
  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setName(execution?.name ?? '');
    setFlowId(execution?.flowId ?? '');
    setPrompt(execution?.prompt ?? '');
    setSaveConversations(execution?.saveConversations === true);
    setTrigger(execution?.trigger ?? DEFAULT_SCHEDULE);
    setDraftId(execution ? '' : crypto.randomUUID());
  }, [open, execution]);

  // Load the available flows to choose from when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingFlows(true);
    flowService.loadFlows()
      .then((loaded) => {
        if (!cancelled) setFlows(loaded || []);
      })
      .catch((err) => {
        log.warn('Failed to load flows for execution picker', err);
        if (!cancelled) setFlows([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFlows(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const selectedMissing = !!flowId && !loadingFlows && flows.length > 0 && !flows.some((f) => f.id === flowId);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const input: PlannedExecutionInput = {
      name,
      flowId,
      prompt,
      saveConversations,
      trigger,
      enabled: execution?.enabled ?? true,
      // The pre-generated id makes the webhook URL shown in the panel real.
      ...(execution ? {} : { id: draftId }),
    };
    const result = execution
      ? await plannedExecutionsService.update(execution.id, input)
      : await plannedExecutionsService.create(input);
    setSaving(false);
    if (!result.success) {
      setSaveError(result.error || 'Failed to save');
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5,
          borderColor: 'primary.main',
          maxWidth: '95vw',
          maxHeight: '90vh',
        },
      }}
    >
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {execution ? 'Edit planned execution' : 'New planned execution'}
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A planned execution runs one of your flows automatically — on a
          schedule or when something happens — without anyone sitting in the
          chat. Results show up in its run history on the Executions page.
        </Typography>

        <TextField
          fullWidth
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          margin="normal"
          placeholder="e.g. Morning news digest"
        />

        <Typography variant="subtitle1" sx={{ mt: 3, mb: 1, fontWeight: 600 }}>
          1 · When should it run?
        </Typography>
        <Box role="radiogroup" aria-label="Trigger type" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={trigger.type === 'schedule'}
            onClick={() => {
              if (trigger.type !== 'schedule') {
                setTrigger(
                  execution?.trigger.type === 'schedule' ? execution.trigger : DEFAULT_SCHEDULE
                );
              }
            }}
            icon={<ScheduleIcon />}
            title="On a schedule"
            description="Run at fixed times — every few minutes, daily, on weekdays, or a custom rhythm."
          />
          <OptionCard
            selected={trigger.type === 'webhook'}
            onClick={() => {
              if (trigger.type !== 'webhook') {
                setTrigger(
                  execution?.trigger.type === 'webhook' ? execution.trigger : newWebhookTrigger()
                );
              }
            }}
            icon={<WebhookIcon />}
            title="When called (webhook)"
            description="Other apps run this flow by calling a URL — GitHub, Stripe, Slack and most services can send webhooks."
          />
          <OptionCard
            selected={trigger.type === 'file-watch'}
            onClick={() => {
              if (trigger.type !== 'file-watch') {
                setTrigger(
                  execution?.trigger.type === 'file-watch' ? execution.trigger : DEFAULT_FILE_WATCH
                );
              }
            }}
            icon={<FolderOpenIcon />}
            title="When files change"
            description="Watch a folder on this computer and run when files appear, change, or disappear."
          />
          <OptionCard
            selected={trigger.type === 'mcp-poll'}
            onClick={() => {
              if (trigger.type !== 'mcp-poll') {
                setTrigger(
                  execution?.trigger.type === 'mcp-poll' ? execution.trigger : DEFAULT_MCP_POLL
                );
              }
            }}
            icon={<TravelExploreIcon />}
            title="Watch a tool"
            description="Check one of your MCP tools regularly — run when its result changes, or let AI decide."
          />
          <OptionCard
            selected={trigger.type === 'url-watch'}
            onClick={() => {
              if (trigger.type !== 'url-watch') {
                setTrigger(
                  execution?.trigger.type === 'url-watch' ? execution.trigger : DEFAULT_URL_WATCH
                );
              }
            }}
            icon={<LanguageIcon />}
            title="When a website changes"
            description="Check a URL regularly and run when its content is different from the last check."
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
            executionId={execution?.id ?? draftId}
            saved={execution !== null}
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

        <Divider sx={{ mt: 3 }} />
        <Typography variant="subtitle1" sx={{ mt: 2, mb: 0, fontWeight: 600 }}>
          2 · What should it run?
        </Typography>

        <FormControl fullWidth margin="normal">
          <InputLabel id="execution-flow-label">Flow to run</InputLabel>
          <Select
            labelId="execution-flow-label"
            label="Flow to run"
            value={selectedMissing ? '' : flowId}
            onChange={(e) => setFlowId(e.target.value)}
            displayEmpty
          >
            {flows.length === 0 && (
              <MenuItem value="" disabled>
                {loadingFlows ? 'Loading flows…' : 'No flows available'}
              </MenuItem>
            )}
            {flows.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {f.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {selectedMissing && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            The previously selected flow no longer exists. Please choose another.
          </Alert>
        )}

        <TextField
          fullWidth
          label="What should the flow do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          margin="normal"
          multiline
          rows={3}
          helperText="Sent to the flow as the user message each time this runs. Run details are attached automatically: current time, what triggered it, the previous run, the next planned run, and any trigger data."
        />

        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              checked={saveConversations}
              onChange={(e) => setSaveConversations(e.target.checked)}
            />
          }
          label="Save full conversations (each run appears in the chat sidebar — useful for debugging)"
        />

        {saveError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleSave}
          variant="contained"
          color="primary"
          disabled={saving || !name.trim() || !flowId}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ExecutionModal;

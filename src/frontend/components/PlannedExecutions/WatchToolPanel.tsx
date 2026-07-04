"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import DifferenceIcon from '@mui/icons-material/Difference';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import PsychologyIcon from '@mui/icons-material/Psychology';
import { McpPollTriggerConfig } from '@/shared/types/plannedExecution';
import { Model } from '@/shared/types/model';
import { mcpService } from '@/frontend/services/mcp';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';
import OptionCard from './OptionCard';

const log = createLogger('frontend/components/PlannedExecutions/WatchToolPanel');

interface WatchToolPanelProps {
  config: McpPollTriggerConfig;
  onChange: (config: McpPollTriggerConfig) => void;
}

interface ToolEntry {
  name: string;
  description?: string;
}

/**
 * "Watch a tool" trigger editor: poll an MCP tool on an interval and run the
 * flow when the result changes or new items appear. The per-app integration
 * knowledge lives in the MCP server — FLUJO only supplies the polling.
 */
const WatchToolPanel = ({ config, onChange }: WatchToolPanelProps) => {
  const [servers, setServers] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [argsText, setArgsText] = useState<string>(
    Object.keys(config.args || {}).length > 0 ? JSON.stringify(config.args, null, 2) : ''
  );
  const [argsError, setArgsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);

  // Load the configured MCP servers once.
  useEffect(() => {
    let cancelled = false;
    mcpService.loadServerConfigs().then((configs: unknown) => {
      if (cancelled) return;
      if (Array.isArray(configs)) {
        setServers(
          configs
            .filter((c: { disabled?: boolean }) => !c.disabled)
            .map((c: { name: string }) => c.name)
        );
      } else {
        log.warn('Failed to load MCP servers for watch-tool panel', configs);
        setServers([]);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Load the selected server's tools.
  useEffect(() => {
    if (!config.serverName) {
      setTools([]);
      return;
    }
    let cancelled = false;
    setLoadingTools(true);
    mcpService.listServerTools(config.serverName)
      .then(({ tools: loaded }: { tools: ToolEntry[] }) => {
        if (!cancelled) setTools(loaded || []);
      })
      .finally(() => {
        if (!cancelled) setLoadingTools(false);
      });
    return () => { cancelled = true; };
  }, [config.serverName]);

  // Load the models for the "AI decides" picker.
  useEffect(() => {
    let cancelled = false;
    modelService.loadModels()
      .then(list => {
        if (!cancelled) setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => { cancelled = true; };
  }, []);

  const handleArgsChange = (text: string) => {
    setArgsText(text);
    if (!text.trim()) {
      setArgsError(null);
      onChange({ ...config, args: {} });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setArgsError('Arguments must be a JSON object, e.g. { "query": "…" }');
        return;
      }
      setArgsError(null);
      onChange({ ...config, args: parsed });
    } catch {
      setArgsError('Not valid JSON yet');
    }
  };

  const handleTestPoll = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const response = await mcpService.callTool(config.serverName, config.toolName, config.args || {});
      if (response?.error) {
        setTestError(typeof response.error === 'string' ? response.error : 'Tool call failed');
      } else {
        const data = response?.data ?? response;
        const serialized = JSON.stringify(data, null, 2) ?? '';
        setTestResult(serialized.length > 6000 ? `${serialized.slice(0, 6000)}\n… (truncated)` : serialized);
      }
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Tool call failed');
    } finally {
      setTesting(false);
    }
  };

  const evaluate = config.evaluate;
  const intervalSeconds = Math.round((config.intervalMs || 60000) / 1000);

  return (
    <Box sx={{ mt: 1 }}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 220, flex: 1 }} margin="normal">
          <InputLabel id="watch-server-label">Server</InputLabel>
          <Select
            labelId="watch-server-label"
            label="Server"
            value={servers.includes(config.serverName) ? config.serverName : ''}
            onChange={(e) => onChange({ ...config, serverName: e.target.value, toolName: '' })}
          >
            {servers.length === 0 && (
              <MenuItem value="" disabled>No MCP servers configured</MenuItem>
            )}
            {servers.map(name => (
              <MenuItem key={name} value={name}>{name}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl sx={{ minWidth: 220, flex: 1 }} margin="normal" disabled={!config.serverName}>
          <InputLabel id="watch-tool-label">Tool</InputLabel>
          <Select
            labelId="watch-tool-label"
            label="Tool"
            value={tools.some(t => t.name === config.toolName) ? config.toolName : ''}
            onChange={(e) => onChange({ ...config, toolName: e.target.value })}
          >
            {tools.length === 0 && (
              <MenuItem value="" disabled>
                {loadingTools ? 'Loading tools…' : 'Pick a server first'}
              </MenuItem>
            )}
            {tools.map(tool => (
              <MenuItem key={tool.name} value={tool.name}>{tool.name}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          label="Check every (seconds)"
          type="number"
          margin="normal"
          value={intervalSeconds}
          onChange={(e) =>
            onChange({ ...config, intervalMs: Math.max(30, Number(e.target.value) || 30) * 1000 })
          }
          inputProps={{ min: 30, step: 30 }}
          helperText="Minimum 30s"
          sx={{ width: 180 }}
        />
      </Box>

      <TextField
        fullWidth
        label="Tool arguments (JSON, optional)"
        value={argsText}
        onChange={(e) => handleArgsChange(e.target.value)}
        margin="normal"
        multiline
        minRows={2}
        placeholder='{ "query": "is:unread" }'
        error={!!argsError}
        helperText={argsError ?? 'Sent to the tool on every check.'}
        slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 14 } } }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <Button
          variant="outlined"
          size="small"
          onClick={handleTestPoll}
          disabled={!config.serverName || !config.toolName || testing || !!argsError}
          startIcon={testing ? <CircularProgress size={16} /> : undefined}
        >
          Test: call the tool now
        </Button>
        <Typography variant="caption" color="text.secondary">
          See what the result looks like — useful for the settings below.
        </Typography>
      </Box>
      {testError && <Alert severity="error" sx={{ mb: 1 }}>{testError}</Alert>}
      {testResult && (
        <Box
          component="pre"
          sx={{
            maxHeight: 240,
            overflow: 'auto',
            bgcolor: 'action.hover',
            borderRadius: 1,
            p: 1.5,
            fontSize: 12,
            m: 0,
            mb: 1,
          }}
        >
          {testResult}
        </Box>
      )}

      <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
        Run the flow when…
      </Typography>
      <Box role="radiogroup" aria-label="Poll condition" sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <OptionCard
          selected={evaluate.mode === 'on-change'}
          onClick={() => onChange({ ...config, evaluate: { mode: 'on-change' } })}
          icon={<DifferenceIcon />}
          title="The result changes"
          description="Any difference from the last check runs the flow. Simplest — no setup."
        />
        <OptionCard
          selected={evaluate.mode === 'new-items'}
          onClick={() =>
            onChange({
              ...config,
              evaluate:
                evaluate.mode === 'new-items' ? evaluate : { mode: 'new-items', itemsPath: '', idField: 'id' },
            })
          }
          icon={<PlaylistAddIcon />}
          title="New items appear"
          description="The result is a list (emails, tasks, orders …); run once when unseen entries show up."
        />
        <OptionCard
          selected={evaluate.mode === 'llm-gate'}
          onClick={() =>
            onChange({
              ...config,
              evaluate:
                evaluate.mode === 'llm-gate' ? evaluate : { mode: 'llm-gate', condition: '', modelId: '' },
            })
          }
          icon={<PsychologyIcon />}
          title="AI decides"
          description="Describe the condition in plain language; a model checks the result whenever it changes."
        />
      </Box>

      {evaluate.mode === 'new-items' && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
          <TextField
            label="Where the list lives (optional)"
            value={evaluate.itemsPath}
            onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, itemsPath: e.target.value } })}
            placeholder="e.g. content.0.items — empty if the result is the list"
            helperText="Dot path into the result. Use the test button above to inspect it."
            sx={{ minWidth: 300, flex: 1 }}
          />
          <TextField
            label="Field that identifies an item"
            value={evaluate.idField}
            onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, idField: e.target.value } })}
            placeholder="id"
            helperText='Usually "id". Used to remember what was already seen.'
            sx={{ minWidth: 220 }}
          />
        </Box>
      )}

      {evaluate.mode === 'llm-gate' && (
        <Box sx={{ mt: 1 }}>
          <TextField
            fullWidth
            label="Run the flow if…"
            value={evaluate.condition}
            onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, condition: e.target.value } })}
            multiline
            minRows={2}
            margin="normal"
            placeholder="e.g. any email mentions an invoice or a payment reminder"
          />
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <FormControl sx={{ minWidth: 260, flex: 1 }}>
              <InputLabel id="gate-model-label">Model that checks</InputLabel>
              <Select
                labelId="gate-model-label"
                label="Model that checks"
                value={models.some(m => m.id === evaluate.modelId) ? evaluate.modelId : ''}
                onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, modelId: e.target.value } })}
              >
                {models.length === 0 && (
                  <MenuItem value="" disabled>No models configured</MenuItem>
                )}
                {models.map(m => (
                  <MenuItem key={m.id} value={m.id}>{m.displayName || m.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Max checks per day"
              type="number"
              value={evaluate.maxCallsPerDay ?? 500}
              onChange={(e) =>
                onChange({
                  ...config,
                  evaluate: { ...evaluate, maxCallsPerDay: Math.max(1, Number(e.target.value) || 1) },
                })
              }
              inputProps={{ min: 1 }}
              helperText="Cost guard — each check is one small model call."
              sx={{ width: 200 }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            The model is only asked when the result actually changed since the
            last check — an idle feed costs nothing. Pick a small, cheap model.
          </Typography>
        </Box>
      )}

      <Alert severity="info" sx={{ mt: 2 }}>
        The first check only takes a snapshot — the flow runs from the second
        check onwards, when something actually changed. FLUJO must be running
        for checks to happen.
      </Alert>
    </Box>
  );
};

export default WatchToolPanel;

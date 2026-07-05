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
import PsychologyIcon from '@mui/icons-material/Psychology';
import { McpPollTriggerConfig } from '@/shared/types/plannedExecution';
import { Model } from '@/shared/types/model';
import { Flow } from '@/frontend/types/flow/flow';
import { mcpService } from '@/frontend/services/mcp';
import { modelService } from '@/frontend/services/model';
import { flowService } from '@/frontend/services/flow';
import { createLogger } from '@/utils/logger';
import OptionCard from './OptionCard';
import SchedulePanel from './SchedulePanel';
import SchemaParamsForm from '@/frontend/components/shared/SchemaParamsForm';
import { intervalMsToCron } from '@/utils/shared/cron';

const log = createLogger('frontend/components/PlannedExecutions/WatchToolPanel');

interface WatchToolPanelProps {
  config: McpPollTriggerConfig;
  onChange: (config: McpPollTriggerConfig) => void;
}

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
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
  const [flows, setFlows] = useState<Flow[]>([]);

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

  // Load the models + flows for the "AI decides" pickers.
  useEffect(() => {
    let cancelled = false;
    modelService.loadModels()
      .then(list => {
        if (!cancelled) setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    flowService.loadFlows()
      .then(list => {
        if (!cancelled) setFlows(list || []);
      })
      .catch(() => {
        if (!cancelled) setFlows([]);
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
  const selectedTool = tools.find(t => t.name === config.toolName);

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
            // Args belong to a specific tool — reset them on tool change.
            onChange={(e) => onChange({ ...config, toolName: e.target.value, args: {} })}
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

      </Box>

      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        How often to check
      </Typography>
      <SchedulePanel
        verb="Check"
        cron={config.cron ?? intervalMsToCron(config.intervalMs)}
        timezone={config.timezone}
        onChange={({ cron, timezone }) => onChange({ ...config, cron, timezone })}
      />

      {selectedTool ? (
        <Box sx={{ my: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            Tool parameters — sent on every check
          </Typography>
          <SchemaParamsForm
            schema={selectedTool.inputSchema}
            values={config.args || {}}
            onChange={(args) => onChange({ ...config, args })}
          />
        </Box>
      ) : (
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
      )}

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
          selected={evaluate.mode === 'llm-gate' || evaluate.mode === 'flow-gate'}
          onClick={() => {
            if (evaluate.mode !== 'llm-gate' && evaluate.mode !== 'flow-gate') {
              onChange({ ...config, evaluate: { mode: 'llm-gate', condition: '', modelId: '' } });
            }
          }}
          icon={<PsychologyIcon />}
          title="AI decides"
          description="Describe the condition in plain language; a model — or one of your flows — checks the result whenever it changes."
        />
      </Box>

      {(evaluate.mode === 'llm-gate' || evaluate.mode === 'flow-gate') && (
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
            <FormControl sx={{ minWidth: 170 }}>
              <InputLabel id="gate-checker-label">Checked by</InputLabel>
              <Select
                labelId="gate-checker-label"
                label="Checked by"
                value={evaluate.mode}
                onChange={(e) => {
                  const mode = e.target.value as 'llm-gate' | 'flow-gate';
                  if (mode === evaluate.mode) return;
                  const common = {
                    condition: evaluate.condition,
                    maxCallsPerDay: evaluate.maxCallsPerDay,
                  };
                  onChange({
                    ...config,
                    evaluate:
                      mode === 'llm-gate'
                        ? { mode, ...common, modelId: '' }
                        : { mode, ...common, flowId: '' },
                  });
                }}
              >
                <MenuItem value="llm-gate">A model</MenuItem>
                <MenuItem value="flow-gate">One of my flows</MenuItem>
              </Select>
            </FormControl>

            {evaluate.mode === 'llm-gate' && (
              <FormControl sx={{ minWidth: 240, flex: 1 }}>
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
            )}

            {evaluate.mode === 'flow-gate' && (
              <FormControl sx={{ minWidth: 240, flex: 1 }}>
                <InputLabel id="gate-flow-label">Flow that checks</InputLabel>
                <Select
                  labelId="gate-flow-label"
                  label="Flow that checks"
                  value={flows.some(f => f.id === evaluate.flowId) ? evaluate.flowId : ''}
                  onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, flowId: e.target.value } })}
                >
                  {flows.length === 0 && (
                    <MenuItem value="" disabled>No flows available</MenuItem>
                  )}
                  {flows.map(f => (
                    <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

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
              helperText="Cost guard per check."
              sx={{ width: 180 }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {evaluate.mode === 'flow-gate'
              ? 'The checker flow runs invisibly (never in the chat), gets the condition + tool result, and must answer with {"fire": true/false, "reason": "…"} — it can use its own tools to verify before deciding.'
              : 'The model is only asked when the result actually changed since the last check — an idle feed costs nothing. Pick a small, cheap model.'}
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

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
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';
import { useI18n } from '@/frontend/contexts/I18nContext';

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

// Full server config (not just the name) so the card picker can render status,
// transport and path, and reuse the MCP page's saved sort/folder settings (#92).
interface ServerConfigLike {
  name: string;
  status?: string;
  transport?: string;
  rootPath?: string;
  disabled?: boolean;
  folder?: string;
}

/**
 * "Watch a tool" trigger editor: poll an MCP tool on an interval and run the
 * flow when the result changes or new items appear. The per-app integration
 * knowledge lives in the MCP server — FLUJO only supplies the polling.
 */
const WatchToolPanel = ({ config, onChange }: WatchToolPanelProps) => {
  const { t } = useI18n();
  const [servers, setServers] = useState<ServerConfigLike[]>([]);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
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
        setServers((configs as ServerConfigLike[]).filter((c) => !c.disabled));
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
        setArgsError(t('automations.tool.argsObject'));
        return;
      }
      setArgsError(null);
      onChange({ ...config, args: parsed });
    } catch {
      setArgsError(t('automations.tool.invalidJson'));
    }
  };

  const handleTestPoll = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const response = await mcpService.callTool(config.serverName, config.toolName, config.args || {});
      if (response?.error) {
        setTestError(typeof response.error === 'string' ? response.error : t('automations.tool.callFailed'));
      } else {
        const data = response?.data ?? response;
        const serialized = JSON.stringify(data, null, 2) ?? '';
        setTestResult(serialized.length > 6000 ? `${serialized.slice(0, 6000)}\n… (${t('automations.tool.truncated')})` : serialized);
      }
    } catch (error) {
      setTestError(error instanceof Error ? error.message : t('automations.tool.callFailed'));
    } finally {
      setTesting(false);
    }
  };

  const evaluate = config.evaluate;
  const selectedTool = tools.find(t => t.name === config.toolName);

  // MCP server card picker (#92): mirrors the MCP Servers page layout + saved
  // search/sort/folder settings instead of a plain dropdown.
  const serverPicker = useCardPicker<ServerConfigLike>('mcp', servers);
  const handlePickServer = (serverName: string) => {
    onChange({ ...config, serverName, toolName: '' });
    setServerPickerOpen(false);
  };
  const renderServerCard = (server: ServerConfigLike) => (
    <ServerCard
      name={server.name}
      status={(server.status as any) || 'disconnected'}
      path={server.rootPath || ''}
      enabled={!server.disabled}
      transport={(server.transport as any) || 'stdio'}
      pickerMode
      selected={config.serverName === server.name}
      onClick={() => handlePickServer(server.name)}
    />
  );
  const toServerCell = (server: ServerConfigLike): CardPickerItem => ({ key: server.name, content: renderServerCard(server) });
  const serverPickerItems: CardPickerItem[] = serverPicker.items.map(toServerCell);
  const serverPickerGroups: CardGroup<CardPickerItem>[] | null = serverPicker.groups
    ? serverPicker.groups.map((g) => ({ ...g, items: g.items.map(toServerCell) }))
    : null;

  return (
    <Box sx={{ mt: 1 }}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ minWidth: 220, flex: 1, mt: 2, mb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {t('automations.tool.server')}
          </Typography>
          <Button
            variant="outlined"
            fullWidth
            onClick={() => setServerPickerOpen(true)}
            sx={{ justifyContent: 'flex-start', textTransform: 'none' }}
          >
            {config.serverName ? t('automations.tool.changeServer', { server: config.serverName }) : t('automations.tool.chooseServer')}
          </Button>
          <CardPickerDialog
            open={serverPickerOpen}
            onClose={() => setServerPickerOpen(false)}
            title={t('automations.tool.chooseServerTitle')}
            description={t('automations.tool.chooseServerDescription')}
            emptyMessage={t('automations.tool.noServers')}
            searchable
            searchPlaceholder={t('automations.tool.searchServers')}
            searchTerm={serverPicker.searchTerm}
            onSearchChange={serverPicker.setSearchTerm}
            columns={{ xs: 12, sm: 6 }}
            items={serverPickerItems}
            groups={serverPickerGroups}
            collapsedKeys={serverPicker.collapsedKeys}
            onToggleGroup={serverPicker.toggleGroup}
          />
        </Box>

        <FormControl sx={{ minWidth: 220, flex: 1 }} margin="normal" disabled={!config.serverName}>
          <InputLabel id="watch-tool-label">{t('automations.tool.tool')}</InputLabel>
          <Select
            labelId="watch-tool-label"
            label={t('automations.tool.tool')}
            value={tools.some(t => t.name === config.toolName) ? config.toolName : ''}
            // Args belong to a specific tool — reset them on tool change.
            onChange={(e) => onChange({ ...config, toolName: e.target.value, args: {} })}
          >
            {tools.length === 0 && (
              <MenuItem value="" disabled>
                {loadingTools ? t('automations.tool.loadingTools') : t('automations.tool.pickServerFirst')}
              </MenuItem>
            )}
            {tools.map(tool => (
              <MenuItem key={tool.name} value={tool.name}>{tool.name}</MenuItem>
            ))}
          </Select>
        </FormControl>

      </Box>

      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        {t('automations.howOften')}
      </Typography>
      <SchedulePanel
        verb={t('automations.checkVerb')}
        cron={config.cron ?? intervalMsToCron(config.intervalMs)}
        timezone={config.timezone}
        onChange={({ cron, timezone }) => onChange({ ...config, cron, timezone })}
      />

      {selectedTool ? (
        <Box sx={{ my: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            {t('automations.tool.params')}
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
          label={t('automations.tool.args')}
          value={argsText}
          onChange={(e) => handleArgsChange(e.target.value)}
          margin="normal"
          multiline
          minRows={2}
          placeholder='{ "query": "is:unread" }'
          error={!!argsError}
          helperText={argsError ?? t('automations.tool.argsHelp')}
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
          {t('automations.tool.test')}
        </Button>
        <Typography variant="caption" color="text.secondary">
          {t('automations.tool.testHelp')}
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
        {t('automations.tool.runWhen')}
      </Typography>
      <Box role="radiogroup" aria-label={t('automations.tool.pollConditionAria')} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <OptionCard
          selected={evaluate.mode === 'on-change'}
          onClick={() => onChange({ ...config, evaluate: { mode: 'on-change' } })}
          icon={<DifferenceIcon />}
          title={t('automations.tool.resultChanges')}
          description={t('automations.tool.resultChangesDescription')}
        />
        <OptionCard
          selected={evaluate.mode === 'llm-gate' || evaluate.mode === 'flow-gate'}
          onClick={() => {
            if (evaluate.mode !== 'llm-gate' && evaluate.mode !== 'flow-gate') {
              onChange({ ...config, evaluate: { mode: 'llm-gate', condition: '', modelId: '' } });
            }
          }}
          icon={<PsychologyIcon />}
          title={t('automations.tool.aiDecides')}
          description={t('automations.tool.aiDecidesDescription')}
        />
      </Box>

      {(evaluate.mode === 'llm-gate' || evaluate.mode === 'flow-gate') && (
        <Box sx={{ mt: 1 }}>
          <TextField
            fullWidth
            label={t('automations.tool.condition')}
            value={evaluate.condition}
            onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, condition: e.target.value } })}
            multiline
            minRows={2}
            margin="normal"
            placeholder={t('automations.tool.conditionPlaceholder')}
          />
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <FormControl sx={{ minWidth: 170 }}>
              <InputLabel id="gate-checker-label">{t('automations.tool.checkedBy')}</InputLabel>
              <Select
                labelId="gate-checker-label"
                label={t('automations.tool.checkedBy')}
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
                <MenuItem value="llm-gate">{t('automations.tool.aModel')}</MenuItem>
                <MenuItem value="flow-gate">{t('automations.tool.oneFlow')}</MenuItem>
              </Select>
            </FormControl>

            {evaluate.mode === 'llm-gate' && (
              <FormControl sx={{ minWidth: 240, flex: 1 }}>
                <InputLabel id="gate-model-label">{t('automations.tool.modelChecker')}</InputLabel>
                <Select
                  labelId="gate-model-label"
                  label={t('automations.tool.modelChecker')}
                  value={models.some(m => m.id === evaluate.modelId) ? evaluate.modelId : ''}
                  onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, modelId: e.target.value } })}
                >
                  {models.length === 0 && (
                    <MenuItem value="" disabled>{t('automations.tool.noModels')}</MenuItem>
                  )}
                  {models.map(m => (
                    <MenuItem key={m.id} value={m.id}>{m.displayName || m.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {evaluate.mode === 'flow-gate' && (
              <FormControl sx={{ minWidth: 240, flex: 1 }}>
                <InputLabel id="gate-flow-label">{t('automations.tool.flowChecker')}</InputLabel>
                <Select
                  labelId="gate-flow-label"
                  label={t('automations.tool.flowChecker')}
                  value={flows.some(f => f.id === evaluate.flowId) ? evaluate.flowId : ''}
                  onChange={(e) => onChange({ ...config, evaluate: { ...evaluate, flowId: e.target.value } })}
                >
                  {flows.length === 0 && (
                    <MenuItem value="" disabled>{t('automations.tool.noFlows')}</MenuItem>
                  )}
                  {flows.map(f => (
                    <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <TextField
              label={t('automations.tool.maxChecks')}
              type="number"
              value={evaluate.maxCallsPerDay ?? 500}
              onChange={(e) =>
                onChange({
                  ...config,
                  evaluate: { ...evaluate, maxCallsPerDay: Math.max(1, Number(e.target.value) || 1) },
                })
              }
              inputProps={{ min: 1 }}
              helperText={t('automations.tool.costGuard')}
              sx={{ width: 180 }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {evaluate.mode === 'flow-gate'
              ? t('automations.tool.flowGateHelp')
              : t('automations.tool.modelGateHelp')}
          </Typography>
        </Box>
      )}

      <Alert severity="info" sx={{ mt: 2 }}>
        {t('automations.tool.firstSnapshot')}
      </Alert>
    </Box>
  );
};

export default WatchToolPanel;

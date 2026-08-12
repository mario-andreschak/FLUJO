"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControlLabel,
  FormHelperText,
  IconButton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import CardPickerGrid, { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import RootsManager from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RootsManager';
import { FlowNode } from '@/frontend/types/flow/flow';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS, TOOL_CALL_TIMEOUT_INFINITE } from '@/shared/types/mcp';
import { resolveAutoNodeLabel } from '@/shared/utils/nodeLabel';
import { CardGroup } from '@/utils/shared/cardGrouping';
import { createLogger } from '@/utils/logger/index';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import { useI18n } from '@/frontend/contexts/I18nContext';
import MCPNodeToolList from './MCPNodeToolList';

const logger = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodePropertiesModal');

interface MCPNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
  authoringMode?: FlowAuthoringMode;
}

type CompactTab = 'server' | 'tools' | 'settings';
type DesktopTab = 'tools' | 'settings';

export const MCPNodePropertiesModal = ({
  open,
  node,
  onClose,
  onSave,
  authoringMode = 'advanced',
}: MCPNodePropertiesModalProps) => {
  const { t } = useI18n();
  const theme = useTheme();
  const isCompactLayout = useMediaQuery(theme.breakpoints.down('md'), { noSsr: true });
  const isPhoneLayout = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);
  const [retryingServers, setRetryingServers] = useState<Record<string, boolean>>({});
  const [retryingAll, setRetryingAll] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [activeCompactTab, setActiveCompactTab] = useState<CompactTab>('server');
  const [activeDesktopTab, setActiveDesktopTab] = useState<DesktopTab>('tools');
  const [initializeToolsForServer, setInitializeToolsForServer] = useState<string | null>(null);

  const {
    servers,
    isLoading: isLoadingServers,
    loadError,
    retryServer,
  } = useServerStatus();
  const serverPicker = useCardPicker<any>('mcp', servers);
  const selectedServer = nodeData?.properties?.boundServer || '';
  const {
    tools: mcpTools,
    toolsServerName,
    isLoading: isLoadingTools,
    error: toolsError,
    loadTools,
  } = useServerTools(selectedServer);

  useEffect(() => {
    if (!node) return;
    setNodeData({
      ...node.data,
      properties: { ...node.data.properties },
    });
    const hasServer = !!node.data.properties?.boundServer;
    setActiveCompactTab(hasServer ? 'tools' : 'server');
    setActiveDesktopTab('tools');
    setServerPickerOpen(false);
    setInitializeToolsForServer(null);
  }, [node, open]);

  // A newly selected server starts with all of its tools enabled, matching the
  // existing add-and-connect flow. An explicitly saved empty list is left alone
  // so "Deactivate all" remains durable after reopening the modal.
  useEffect(() => {
    if (
      !initializeToolsForServer
      || initializeToolsForServer !== selectedServer
      || toolsServerName !== initializeToolsForServer
      || isLoadingTools
      || toolsError
    ) return;
    setNodeData((previous) => previous ? {
      ...previous,
      properties: {
        ...previous.properties,
        enabledTools: mcpTools.map((tool) => tool.name),
      },
    } : null);
    setInitializeToolsForServer(null);
  }, [initializeToolsForServer, isLoadingTools, mcpTools, selectedServer, toolsError, toolsServerName]);

  const handlePropertyChange = (key: string, value: any) => {
    setNodeData((previous) => previous ? {
      ...previous,
      properties: { ...previous.properties, [key]: value },
    } : null);
  };

  const handleLabelChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setNodeData((previous) => previous ? {
      ...previous,
      label: event.target.value,
      properties: { ...previous.properties, nameIsCustom: true },
    } : null);
  };

  const handleSave = () => {
    if (!node || !nodeData) return;
    onSave(node.id, nodeData);
    onClose();
  };

  const handleRetryAllServers = async () => {
    setRetryingAll(true);
    try {
      await Promise.all(servers.map((server: any) => retryServer(server.name)));
    } finally {
      setRetryingAll(false);
    }
  };

  const handleRetryServer = async (serverName: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    logger.debug(`Retrying server: ${serverName}`);
    setRetryingServers((previous) => ({ ...previous, [serverName]: true }));
    try {
      await retryServer(serverName);
      if (serverName === selectedServer) loadTools(true);
      return true;
    } catch (error) {
      logger.warn(`Failed to retry server ${serverName}: ${error}`);
      return false;
    } finally {
      setRetryingServers((previous) => ({ ...previous, [serverName]: false }));
    }
  };

  const handleServerSelect = (serverName: string) => {
    logger.debug(`Server selected: ${serverName}`);
    setServerPickerOpen(false);
    setNodeData((previous) => {
      if (!previous || previous.properties?.boundServer === serverName) return previous;
      const newLabel = resolveAutoNodeLabel({
        currentLabel: previous.label,
        nameIsCustom: previous.properties?.nameIsCustom,
        defaultLabel: 'MCP Node',
        previousAutoLabel: previous.properties?.boundServer || undefined,
        nextAutoLabel: serverName,
      });
      return {
        ...previous,
        label: newLabel,
        properties: {
          ...previous.properties,
          boundServer: serverName,
          enabledTools: [],
        },
      };
    });
    if (serverName !== selectedServer) setInitializeToolsForServer(serverName);
    setActiveCompactTab('tools');
  };

  const handleToolToggle = (toolName: string) => {
    setNodeData((previous) => {
      if (!previous) return null;
      const current = Array.isArray(previous.properties.enabledTools)
        ? previous.properties.enabledTools as string[]
        : [];
      const enabledTools = current.includes(toolName)
        ? current.filter((name) => name !== toolName)
        : [...current, toolName];
      return {
        ...previous,
        properties: { ...previous.properties, enabledTools },
      };
    });
  };

  const setAllToolsEnabled = (enabled: boolean) => {
    handlePropertyChange('enabledTools', enabled ? mcpTools.map((tool) => tool.name) : []);
  };

  if (!node || !nodeData) return null;

  const boundServer = nodeData.properties?.boundServer || '';
  const enabledTools = Array.isArray(nodeData.properties?.enabledTools)
    ? nodeData.properties.enabledTools as string[]
    : [];
  const selectedServerConfig = servers.find((server: any) => server.name === boundServer);
  const toolTimeout = nodeData.properties?.toolTimeout;
  const isTimeoutInfinite = toolTimeout === TOOL_CALL_TIMEOUT_INFINITE;

  const renderServerCard = (server: any) => (
    <ServerCard
      name={server.name}
      status={(server.status as any) || 'disconnected'}
      path={server.path || server.rootPath || ''}
      enabled={!server.disabled}
      transport={(server.transport as any) || 'stdio'}
      pickerMode
      selected={boundServer === server.name}
      onClick={() => handleServerSelect(server.name)}
    />
  );
  const toServerCell = (server: any): CardPickerItem => ({ key: server.name, content: renderServerCard(server) });
  const serverPickerItems: CardPickerItem[] = serverPicker.items.map(toServerCell);
  const serverPickerGroups: CardGroup<CardPickerItem>[] | null = serverPicker.groups
    ? serverPicker.groups.map((group) => ({ ...group, items: group.items.map(toServerCell) }))
    : null;

  const serverGrid = (
    <CardPickerGrid
      isLoading={isLoadingServers}
      error={loadError}
      emptyMessage={t('flows.mcpNode.empty')}
      loadingMessage={t('flows.mcpNode.loadingServers')}
      searchable
      searchPlaceholder={t('flows.mcpNode.searchServers')}
      searchTerm={serverPicker.searchTerm}
      onSearchChange={serverPicker.setSearchTerm}
      columns={{ xs: 12 }}
      items={serverPickerItems}
      groups={serverPickerGroups}
      collapsedKeys={serverPicker.collapsedKeys}
      onToggleGroup={serverPicker.toggleGroup}
      autoFocusSearch={false}
    />
  );

  const desktopServerPanel = (
    <Box data-testid="mcp-server-pane" sx={{ height: '100%', minHeight: 0, overflowY: 'auto', p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1.5 }}>
        <Box>
          <Typography variant="h6">{t('flows.mcpNode.bind')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('flows.mcpNode.select')}</Typography>
        </Box>
        <Tooltip title={t('flows.mcpNode.retryAll')}>
          <span>
            <IconButton size="small" onClick={handleRetryAllServers} disabled={retryingAll || isLoadingServers}>
              {retryingAll ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {serverGrid}
      <FormHelperText sx={{ mt: 1 }}>
        {boundServer ? t('flows.mcpNode.bound', { server: boundServer }) : t('flows.mcpNode.select')}
      </FormHelperText>
    </Box>
  );

  const compactServerPanel = (
    <Box data-testid="mcp-compact-server-picker" sx={{ maxWidth: 680, mx: 'auto' }}>
      <Typography variant="h6" sx={{ mb: 0.5 }}>{t('flows.mcpNode.bind')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('flows.mcpNode.select')}
      </Typography>
      <Button
        fullWidth
        variant="outlined"
        size="large"
        startIcon={<DnsOutlinedIcon />}
        onClick={() => setServerPickerOpen(true)}
        sx={{ justifyContent: 'flex-start', textTransform: 'none', py: 1.25 }}
      >
        <Box component="span" sx={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {boundServer || t('flows.mcpNode.chooseServer')}
        </Box>
        {selectedServerConfig && (
          <Chip
            size="small"
            label={selectedServerConfig.status || 'disconnected'}
            color={selectedServerConfig.status === 'connected' ? 'success' : 'default'}
            sx={{ ml: 1 }}
          />
        )}
      </Button>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
        <Button
          size="small"
          startIcon={retryingAll ? <CircularProgress size={16} /> : <RefreshIcon />}
          onClick={handleRetryAllServers}
          disabled={retryingAll || isLoadingServers}
        >
          {t('flows.mcpNode.retryAll')}
        </Button>
      </Box>
      <FormHelperText>
        {boundServer ? t('flows.mcpNode.bound', { server: boundServer }) : t('flows.mcpNode.select')}
      </FormHelperText>
    </Box>
  );

  const toolsPanel = (
    <Box data-testid="mcp-tools-pane">
      {!boundServer ? (
        <Alert severity="info">{t('flows.mcpNode.connectForTools')}</Alert>
      ) : (
        <>
          {selectedServerConfig?.status !== 'connected' && (
            <Alert
              severity="warning"
              sx={{ mb: 2 }}
              action={(
                <Button
                  color="inherit"
                  size="small"
                  startIcon={retryingServers[boundServer] ? <CircularProgress size={16} /> : <RefreshIcon />}
                  onClick={() => handleRetryServer(boundServer)}
                  disabled={retryingServers[boundServer]}
                >
                  {t('flows.mcpNode.retry')}
                </Button>
              )}
            >
              {t('flows.mcpNode.disconnected')}
            </Alert>
          )}
          {isLoadingTools ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 6 }}>
              <CircularProgress size={24} />
              <Typography color="text.secondary">{t('flows.mcpNode.loadingTools')}</Typography>
            </Box>
          ) : toolsError ? (
            <Alert severity="error">{toolsError}</Alert>
          ) : mcpTools.length === 0 ? (
            <Typography color="text.secondary" sx={{ py: 3 }}>
              {selectedServerConfig?.status === 'connected'
                ? t('flows.mcpNode.noTools')
                : t('flows.mcpNode.connectForTools')}
            </Typography>
          ) : (
            <MCPNodeToolList
              tools={mcpTools}
              enabledTools={enabledTools}
              onToggle={handleToolToggle}
              onActivateAll={() => setAllToolsEnabled(true)}
              onDeactivateAll={() => setAllToolsEnabled(false)}
              parameterPresets={nodeData.properties?.toolParameterPresets}
              onParameterPresetsChange={(toolParameterPresets) => handlePropertyChange('toolParameterPresets', toolParameterPresets)}
              workspaceRoots={nodeData.properties?.roots?.length
                ? nodeData.properties.roots
                : selectedServerConfig?.roots?.length
                  ? selectedServerConfig.roots
                  : selectedServerConfig?.rootPath
                    ? [selectedServerConfig.rootPath]
                    : []}
            />
          )}
        </>
      )}
    </Box>
  );

  const settingsPanel = (
    <Box data-testid="mcp-settings-pane" sx={{ maxWidth: 820 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>{t('common.settings')}</Typography>
      <TextField
        fullWidth
        label={t('flows.mcpNode.label')}
        value={nodeData.label || ''}
        onChange={handleLabelChange}
        helperText={t('flows.mcpNode.labelHelp')}
        sx={{ mb: 2 }}
      />
      <TextField
        fullWidth
        label={t('flows.mcpNode.description')}
        value={nodeData.description || ''}
        onChange={(event) => setNodeData({ ...nodeData, description: event.target.value })}
        multiline
        minRows={2}
        helperText={t('flows.mcpNode.descriptionHelp')}
      />

      {boundServer && (
        <>
          <Divider sx={{ my: 3 }} />
          <Typography variant="subtitle1">{t('flows.mcpNode.timeoutTitle')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {t('flows.mcpNode.timeoutHelp')}
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
            <TextField
              label={t('flows.mcpNode.timeoutSeconds')}
              type="number"
              size="small"
              sx={{ width: { xs: '100%', sm: 220 } }}
              value={isTimeoutInfinite ? '' : (toolTimeout ?? '')}
              placeholder={String(DEFAULT_TOOL_CALL_TIMEOUT_SECONDS)}
              disabled={isTimeoutInfinite}
              inputProps={{ min: 1 }}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw === '') {
                  handlePropertyChange('toolTimeout', undefined);
                  return;
                }
                const parsed = Number.parseInt(raw, 10);
                if (!Number.isNaN(parsed) && parsed > 0) handlePropertyChange('toolTimeout', parsed);
              }}
              helperText={isTimeoutInfinite
                ? t('flows.mcpNode.noTimeoutHelp')
                : t('flows.mcpNode.defaultTimeout', { seconds: DEFAULT_TOOL_CALL_TIMEOUT_SECONDS })}
            />
            <FormControlLabel
              control={(
                <Switch
                  checked={isTimeoutInfinite}
                  onChange={(event) => handlePropertyChange(
                    'toolTimeout',
                    event.target.checked ? TOOL_CALL_TIMEOUT_INFINITE : undefined,
                  )}
                />
              )}
              label={t('flows.mcpNode.noTimeout')}
            />
          </Stack>

          <Divider sx={{ my: 3 }} />
          <RootsManager
            roots={nodeData.properties?.roots || []}
            onChange={(roots) => handlePropertyChange('roots', roots)}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t('flows.mcpNode.rootsHelp', { server: boundServer })}
          </Typography>
        </>
      )}
    </Box>
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="xl"
        fullWidth
        data-authoring-mode={authoringMode}
        PaperProps={{
          sx: {
            borderTop: 5,
            borderColor: 'info.main',
            m: { xs: 1, sm: 4 },
            width: { xs: 'calc(100% - 16px)', sm: '95vw' },
            height: { xs: 'calc(100dvh - 16px)', sm: '90vh' },
            maxWidth: { xs: 'calc(100% - 16px)', sm: '95vw' },
            maxHeight: { xs: 'calc(100dvh - 16px)', sm: '90vh' },
          },
        }}
      >
        <DialogHeaderActions
          title={t('flows.modal.properties', { name: nodeData.label || t('flows.mcpNode.title') })}
          onClose={onClose}
          titleProps={{ sx: { minWidth: 0, overflowWrap: 'anywhere' } }}
        />
        <Divider />

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 0, overflow: 'hidden', flexGrow: 1, minHeight: 0 }}>
          {isCompactLayout ? (
            <>
              <Box sx={{ borderBottom: 1, borderColor: 'divider', px: { xs: 0, sm: 2 }, flexShrink: 0 }}>
                <Tabs
                  value={activeCompactTab}
                  onChange={(_, value: CompactTab) => setActiveCompactTab(value)}
                  variant="scrollable"
                  scrollButtons="auto"
                  aria-label={t('flows.mcpNode.title')}
                >
                  <Tab label={t('flows.mcpNode.bind')} value="server" />
                  <Tab label={t('flows.mcpNode.allowedTools')} value="tools" />
                  <Tab label={t('common.settings')} value="settings" />
                </Tabs>
              </Box>
              <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', p: { xs: 2, sm: 3 } }}>
                {activeCompactTab === 'server' && compactServerPanel}
                {activeCompactTab === 'tools' && toolsPanel}
                {activeCompactTab === 'settings' && settingsPanel}
              </Box>
            </>
          ) : (
            <Box
              data-testid="mcp-desktop-split"
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(320px, 38%) minmax(0, 1fr)',
                flexGrow: 1,
                minHeight: 0,
              }}
            >
              <Box sx={{ minWidth: 0, minHeight: 0, borderRight: 1, borderColor: 'divider' }}>
                {desktopServerPanel}
              </Box>
              <Box sx={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2, flexShrink: 0 }}>
                  <Tabs
                    value={activeDesktopTab}
                    onChange={(_, value: DesktopTab) => setActiveDesktopTab(value)}
                    variant="scrollable"
                    scrollButtons="auto"
                    aria-label={t('flows.mcpNode.allowedTools')}
                  >
                    <Tab label={t('flows.mcpNode.allowedTools')} value="tools" />
                    <Tab label={t('common.settings')} value="settings" />
                  </Tabs>
                </Box>
                <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', p: 3 }}>
                  {activeDesktopTab === 'tools' ? toolsPanel : settingsPanel}
                </Box>
              </Box>
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ px: { xs: 1.5, sm: 3 }, py: { xs: 1, sm: 1.5 }, flexShrink: 0 }}>
          <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
          <Button onClick={handleSave} variant="contained" color="primary">
            {t('flows.modal.saveChanges')}
          </Button>
        </DialogActions>
      </Dialog>

      <CardPickerDialog
        open={serverPickerOpen}
        onClose={() => setServerPickerOpen(false)}
        fullScreen={isPhoneLayout}
        maxWidth="md"
        title={t('flows.mcpNode.bind')}
        description={t('flows.mcpNode.select')}
        isLoading={isLoadingServers}
        error={loadError}
        emptyMessage={t('flows.mcpNode.empty')}
        loadingMessage={t('flows.mcpNode.loadingServers')}
        searchable
        searchPlaceholder={t('flows.mcpNode.searchServers')}
        searchTerm={serverPicker.searchTerm}
        onSearchChange={serverPicker.setSearchTerm}
        columns={{ xs: 12, sm: 6 }}
        items={serverPickerItems}
        groups={serverPickerGroups}
        collapsedKeys={serverPicker.collapsedKeys}
        onToggleGroup={serverPicker.toggleGroup}
      />
    </>
  );
};

export default MCPNodePropertiesModal;

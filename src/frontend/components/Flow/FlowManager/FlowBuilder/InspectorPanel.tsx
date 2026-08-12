"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, styled } from '@mui/material/styles';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import SettingsSuggestRoundedIcon from '@mui/icons-material/SettingsSuggestRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import type { Flow, FlowNode } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';
import InspectorMcpServers, {
  type InspectorMcpConnection,
  type InspectorMcpServerOption,
} from './InspectorMcpServers';
import InspectorModelBinding from './InspectorModelBinding';
import GuidedAgentConnections, { type GuidedAgentConnection } from './GuidedAgentConnections';

const InspectorSurface = styled(Paper)(({ theme }) => ({
  width: 320,
  minWidth: 320,
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: 16,
  backgroundColor: theme.palette.mode === 'dark'
    ? 'rgba(17, 22, 41, 0.9)'
    : 'rgba(255, 255, 255, 0.92)',
  boxShadow: theme.palette.mode === 'dark'
    ? '0 18px 55px rgba(0,0,0,.24)'
    : '0 18px 55px rgba(49,45,99,.1)',
  backdropFilter: 'blur(20px) saturate(140%)',
  [theme.breakpoints.down('lg')]: {
    width: 286,
    minWidth: 286,
  },
  [theme.breakpoints.down('md')]: {
    width: '100%',
    minWidth: 0,
    height: 'auto',
    maxHeight: 'none',
  },
}));

type InspectorTab = 'node' | 'flow';

interface InspectorPanelProps {
  selectedNode: FlowNode | null;
  onClearSelection: () => void;
  onCommitNode: (nodeId: string, data: FlowNode['data']) => void;
  onOpenAdvanced: (node: FlowNode) => void;
  /**
   * Opens the read-only technical-details modal for the given node (#412).
   * Optional so the panel can be rendered standalone; the FlowBuilder always
   * supplies it and owns the modal state.
   */
  onOpenTechnicalDetails?: (node: FlowNode) => void;
  flowName: string;
  flowNameError: string | null;
  onFlowNameChange: (value: string) => void;
  flowDescription: string;
  onFlowDescriptionChange: (value: string) => void;
  authoringMode: FlowAuthoringMode;
  onAuthoringModeChange: (mode: FlowAuthoringMode) => void;
  beginnerMode?: boolean;
  onSuggestTools?: (node: FlowNode) => void;
  onSuggestAgents?: (node: FlowNode) => void;
  onImprovePrompt?: (node: FlowNode) => Promise<string>;
  onCheckPlausibility?: () => void;
  connectedMcpServers?: InspectorMcpConnection[];
  onConnectMcpServer?: (processNodeId: string, serverName: string) => void | Promise<void>;
  onRemoveMcpServer?: (processNodeId: string, mcpNodeId: string) => void;
  loadMcpServers?: () => Promise<InspectorMcpServerOption[]>;
  onSelectMcpNodeServer?: (node: FlowNode, serverName: string) => void | Promise<void>;
  currentFlowId?: string;
  availableAgents?: Flow[];
  connectedAgents?: GuidedAgentConnection[];
  onConnectAgent?: (processNodeId: string, flowId: string) => void;
  onRemoveAgent?: (processNodeId: string, subflowNodeId: string) => void;
  models?: Model[];
  /** Opens another flow in the builder (used by the subflow target pill). */
  onNavigateToFlow?: (flowId: string) => void;
}

const typeLabel = (node: FlowNode, beginnerMode: boolean, t: Translator) => {
  const type = String(node.data.type || node.type || 'node');
  if (beginnerMode) {
    const friendlyTypes: Record<string, string> = {
      start: t('flows.inspector.type.start'),
      process: t('flows.inspector.type.process'),
      finish: t('flows.inspector.type.finish'),
      mcp: t('flows.inspector.type.mcp'),
      subflow: t('flows.inspector.type.subflow'),
      resource: t('flows.inspector.type.resource'),
      signal: t('flows.inspector.type.signal'),
      trigger: t('flows.inspector.type.trigger'),
    };
    return friendlyTypes[type] ?? t('flows.inspector.type.step');
  }
  if (type === 'mcp') return 'MCP';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
};

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  selectedNode,
  onClearSelection,
  onCommitNode,
  onOpenAdvanced,
  onOpenTechnicalDetails,
  flowName,
  flowNameError,
  onFlowNameChange,
  flowDescription,
  onFlowDescriptionChange,
  authoringMode,
  onAuthoringModeChange,
  beginnerMode = false,
  onSuggestTools,
  onSuggestAgents,
  onImprovePrompt,
  onCheckPlausibility,
  connectedMcpServers = [],
  onConnectMcpServer,
  onRemoveMcpServer,
  loadMcpServers,
  onSelectMcpNodeServer,
  currentFlowId,
  availableAgents = [],
  connectedAgents = [],
  onConnectAgent,
  onRemoveAgent,
  models = [],
  onNavigateToFlow,
}) => {
  const { t, tp } = useI18n();
  const [tab, setTab] = useState<InspectorTab>(selectedNode ? 'node' : 'flow');
  const [label, setLabel] = useState(selectedNode?.data.label ?? '');
  const [promptTemplate, setPromptTemplate] = useState(
    String(selectedNode?.data.properties?.promptTemplate ?? ''),
  );
  const [improvingPrompt, setImprovingPrompt] = useState(false);
  const [promptImprovementError, setPromptImprovementError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNode) setTab('node');
    else setTab('flow');
  }, [selectedNode?.id]);

  useEffect(() => {
    setLabel(selectedNode?.data.label ?? '');
    setPromptTemplate(String(selectedNode?.data.properties?.promptTemplate ?? ''));
    setPromptImprovementError(null);
  }, [selectedNode?.id, selectedNode?.data]);

  const nodeSummary = useMemo(() => {
    if (!selectedNode) return [];
    const properties = selectedNode.data.properties ?? {};
    const entries: Array<{ label: string; value: string }> = [];
    // The bound model is deliberately NOT listed here: `InspectorModelBinding`
    // is the single authoritative display for the connected model (and owns
    // selection/removal), so a generic summary row would only duplicate it.
    const serverHasInlinePicker = selectedNode.data.type === 'mcp'
      && !!loadMcpServers
      && !!onSelectMcpNodeServer;
    if (typeof properties.boundServer === 'string' && properties.boundServer && !serverHasInlinePicker) {
      entries.push({ label: beginnerMode ? t('flows.inspector.summary.app') : t('flows.inspector.summary.server'), value: properties.boundServer });
    }
    // The subflow target is deliberately NOT listed here: it is rendered as a
    // clickable pill at the top of the node tab (where the node id used to be)
    // so it doubles as a shortcut into the target flow.
    if (typeof properties.signalName === 'string' && properties.signalName) {
      entries.push({ label: beginnerMode ? t('flows.inspector.summary.notification') : t('flows.inspector.summary.signal'), value: properties.signalName });
    }
    return entries;
  }, [selectedNode, beginnerMode, t, loadMcpServers, onSelectMcpNodeServer]);

  // Subflow nodes get their target flow shown as a pill in the node header. The
  // stored value is a flow id, so resolve it to the flow name when we know it
  // (falling back to the raw id for targets that are not in `availableAgents`).
  const subflowTarget = useMemo(() => {
    if (!selectedNode) return null;
    const subflowId = selectedNode.data.properties?.subflowId;
    if (typeof subflowId !== 'string' || !subflowId) return null;
    const target = availableAgents.find((flow) => flow.id === subflowId);
    return { id: subflowId, name: target?.name || subflowId };
  }, [selectedNode, availableAgents]);

  const commitNode = (): FlowNode | null => {
    if (!selectedNode) return null;
    const nextProperties = { ...(selectedNode.data.properties ?? {}) };
    if (selectedNode.data.type === 'process' || selectedNode.data.type === 'start') {
      nextProperties.promptTemplate = promptTemplate;
    }
    const nextData: FlowNode['data'] = {
      ...selectedNode.data,
      label: label.trim() || selectedNode.data.label,
      properties: nextProperties,
    };
    if (JSON.stringify(nextData) !== JSON.stringify(selectedNode.data)) {
      onCommitNode(selectedNode.id, nextData);
    }
    return { ...selectedNode, data: nextData };
  };

  const selectBoundModel = (modelId: string) => {
    const updatedNode = commitNode();
    if (!updatedNode) return;
    const model = models.find((candidate) => candidate.id === modelId);
    onCommitNode(updatedNode.id, {
      ...updatedNode.data,
      properties: {
        ...(updatedNode.data.properties ?? {}),
        boundModel: modelId,
        ...(model ? { modelName: model.name } : {}),
      },
    });
  };

  const removeBoundModel = () => {
    const updatedNode = commitNode();
    if (!updatedNode) return;
    const { boundModel: _boundModel, modelName: _modelName, ...properties } = updatedNode.data.properties ?? {};
    onCommitNode(updatedNode.id, { ...updatedNode.data, properties });
  };

  const selectMcpNodeServer = async (_nodeId: string, serverName: string) => {
    if (!onSelectMcpNodeServer) return;
    const updatedNode = commitNode();
    if (updatedNode) await onSelectMcpNodeServer(updatedNode, serverName);
  };

  const improvePrompt = async () => {
    if (!onImprovePrompt) return;
    const updatedNode = commitNode();
    if (!updatedNode) return;
    setImprovingPrompt(true);
    setPromptImprovementError(null);
    try {
      const improved = await onImprovePrompt(updatedNode);
      setPromptTemplate(improved);
      onCommitNode(updatedNode.id, {
        ...updatedNode.data,
        properties: {
          ...(updatedNode.data.properties ?? {}),
          promptTemplate: improved,
        },
      });
    } catch (error) {
      setPromptImprovementError(error instanceof Error ? error.message : t('flows.inspector.improvePromptFailed'));
    } finally {
      setImprovingPrompt(false);
    }
  };

  return (
    <InspectorSurface
      elevation={0}
      aria-label={beginnerMode && selectedNode ? t('flows.inspector.stepSettings') : beginnerMode ? t('flows.inspector.agentSettings') : t('flows.inspector.flowInspector')}
    >
      <Box sx={{ px: 1.5, pt: 1.25 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '.12em' }}>
              {beginnerMode
                ? selectedNode ? t('flows.inspector.editStep') : t('flows.inspector.agentSettings')
                : t('flows.inspector.inspector')}
            </Typography>
            <Typography variant="subtitle1" fontWeight={800} noWrap>
              {selectedNode ? selectedNode.data.label : flowName}
            </Typography>
          </Box>
          {selectedNode && (
            <Tooltip title={beginnerMode ? t('flows.inspector.closeStep') : t('flows.inspector.clearSelection')}>
              <IconButton size="small" aria-label={beginnerMode ? t('flows.inspector.closeStep') : t('flows.inspector.closeNode')} onClick={onClearSelection}>
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>

        {!beginnerMode && (
          <Tabs
            value={tab}
            onChange={(_event, value: InspectorTab) => setTab(value)}
            variant="fullWidth"
            sx={{ mt: 0.5, minHeight: 38, '& .MuiTab-root': { minHeight: 38 } }}
          >
            <Tab value="node" label={t('flows.inspector.node')} disabled={!selectedNode} />
            <Tab value="flow" label={t('flows.inspector.flow')} />
          </Tabs>
        )}
      </Box>

      <Divider />

      <Box sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}>
        {tab === 'node' && selectedNode ? (
          <Stack spacing={1.5}>
            <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
              <Chip
                size="small"
                sx={{ flexShrink: 0 }}
                label={typeLabel(selectedNode, beginnerMode, t)}
                color={selectedNode.data.type === 'finish' ? 'success' : 'primary'}
                variant="outlined"
              />
              {subflowTarget && (
                <Tooltip
                  title={onNavigateToFlow
                    ? `${t('flows.subflow.openTarget')}: ${subflowTarget.name}`
                    : subflowTarget.name}
                >
                  <Chip
                    size="small"
                    variant="outlined"
                    icon={<AccountTreeOutlinedIcon />}
                    label={subflowTarget.name}
                    clickable={!!onNavigateToFlow}
                    onClick={onNavigateToFlow
                      ? () => {
                          commitNode();
                          onNavigateToFlow(subflowTarget.id);
                        }
                      : undefined}
                    sx={{ minWidth: 0, flexShrink: 1, maxWidth: '100%' }}
                  />
                </Tooltip>
              )}
            </Stack>

            {/* The escape hatch into advanced configuration sits directly below the
                node context pills so it is reachable before the editable fields and
                the variable-length connection sections further down. */}
            <Button
              variant={beginnerMode ? 'outlined' : 'contained'}
              startIcon={<TuneRoundedIcon />}
              endIcon={<OpenInNewRoundedIcon />}
              onClick={() => {
                const updatedNode = commitNode();
                if (updatedNode) onOpenAdvanced(updatedNode);
              }}
            >
              {beginnerMode ? t('flows.inspector.moreOptions') : t('flows.inspector.fullSettings')}
            </Button>

            <TextField
              label={beginnerMode ? t('flows.inspector.stepName') : t('flows.inspector.nodeName')}
              size="small"
              fullWidth
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onBlur={commitNode}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />

            {(selectedNode.data.type === 'process' || selectedNode.data.type === 'start') && (
              <Stack spacing={0.75}>
                <TextField
                  label={
                    beginnerMode
                      ? selectedNode.data.type === 'start' ? t('flows.inspector.helpfulBackground') : t('flows.inspector.aiTask')
                      : selectedNode.data.type === 'start' ? t('flows.inspector.startingContext') : t('flows.inspector.taskPrompt')
                  }
                  size="small"
                  fullWidth
                  multiline
                  minRows={5}
                  maxRows={12}
                  value={promptTemplate}
                  onChange={(event) => setPromptTemplate(event.target.value)}
                  onBlur={commitNode}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      commitNode();
                    }
                  }}
                  placeholder={
                    selectedNode.data.type === 'start'
                      ? beginnerMode ? t('flows.inspector.startBeginnerPlaceholder') : t('flows.inspector.startPlaceholder')
                      : beginnerMode ? t('flows.inspector.taskBeginnerPlaceholder') : t('flows.inspector.taskPlaceholder')
                  }
                  helperText={
                    beginnerMode
                      ? t('flows.inspector.blurHelp')
                      : t('flows.inspector.keyboardHelp')
                  }
                />
                {selectedNode.data.type === 'process' && onImprovePrompt && (
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={improvingPrompt ? <CircularProgress size={16} /> : <AutoFixHighRoundedIcon />}
                    disabled={improvingPrompt}
                    onClick={() => { void improvePrompt(); }}
                  >
                    {improvingPrompt ? t('flows.inspector.improvingPrompt') : t('flows.inspector.improvePrompt')}
                  </Button>
                )}
                {promptImprovementError && (
                  <Typography variant="caption" color="error">{promptImprovementError}</Typography>
                )}
              </Stack>
            )}

            {!beginnerMode && nodeSummary.length > 0 && (
              <Box
                sx={(theme) => ({
                  p: 1.25,
                  borderRadius: 2.5,
                  border: `1px solid ${theme.palette.divider}`,
                  bgcolor: alpha(theme.palette.primary.main, 0.05),
                })}
              >
                {nodeSummary.map((item) => (
                  <Stack key={item.label} direction="row" justifyContent="space-between" gap={1} mb={0.5}>
                    <Typography variant="caption" color="text.secondary">{item.label}</Typography>
                    <Typography variant="caption" fontWeight={700} noWrap>{item.value}</Typography>
                  </Stack>
                ))}
              </Box>
            )}

            {selectedNode.data.type === 'mcp'
              && loadMcpServers
              && onSelectMcpNodeServer
              && (
                <InspectorMcpServers
                  processNodeId={selectedNode.id}
                  connections={typeof selectedNode.data.properties?.boundServer === 'string'
                    && selectedNode.data.properties.boundServer
                    ? [{ nodeId: selectedNode.id, serverName: selectedNode.data.properties.boundServer }]
                    : []}
                  heading={t('flows.inspector.summary.server')}
                  actionLabel={t('flows.inspector.chooseMcpServer')}
                  emptyMessage={t('flows.mcpNode.select')}
                  pickerAriaLabel={t('flows.inspector.chooseMcpServer')}
                  singleSelection
                  onConnect={selectMcpNodeServer}
                  loadServers={loadMcpServers}
                />
              )}

            {selectedNode.data.type === 'process' && (
              <InspectorModelBinding
                models={models}
                selectedModelId={typeof selectedNode.data.properties?.boundModel === 'string'
                  ? selectedNode.data.properties.boundModel
                  : undefined}
                beginnerMode={beginnerMode}
                onSelect={selectBoundModel}
                onRemove={removeBoundModel}
              />
            )}

            {selectedNode.data.type === 'process'
              && onConnectMcpServer
              && onRemoveMcpServer
              && loadMcpServers
              && (
                <InspectorMcpServers
                  processNodeId={selectedNode.id}
                  connections={connectedMcpServers}
                  beginnerMode={beginnerMode}
                  onConnect={onConnectMcpServer}
                  onRemove={onRemoveMcpServer}
                  loadServers={loadMcpServers}
                />
              )}

            {selectedNode.data.type === 'process'
              && currentFlowId
              && onConnectAgent
              && onRemoveAgent
              && (
                <GuidedAgentConnections
                  processNodeId={selectedNode.id}
                  currentFlowId={currentFlowId}
                  flows={availableAgents}
                  connections={connectedAgents}
                  onConnect={onConnectAgent}
                  onRemove={onRemoveAgent}
                />
              )}

            {selectedNode.data.type === 'process' && onSuggestTools && (
              <Button
                variant="contained"
                startIcon={<AutoAwesomeRoundedIcon />}
                onClick={() => {
                  const updatedNode = commitNode();
                  if (updatedNode) onSuggestTools(updatedNode);
                }}
              >
                {t('flows.inspector.suggestTools')}
              </Button>
            )}

            {selectedNode.data.type === 'process' && onSuggestAgents && (
              <Button
                variant="contained"
                startIcon={<AutoAwesomeRoundedIcon />}
                onClick={() => {
                  const updatedNode = commitNode();
                  if (updatedNode) onSuggestAgents(updatedNode);
                }}
              >
                {t('flows.inspector.suggestAgents')}
              </Button>
            )}

            {/* Technical details are the LAST actionable option for a selected
                node (issue #412). The tip below is explanatory copy, not an
                option, so it may stay underneath. */}
            <Button
              variant="text"
              size="small"
              startIcon={<CodeRoundedIcon />}
              onClick={() => {
                // Commit the in-progress label/prompt edits first so the modal
                // shows the current draft instead of stale selection data.
                const updatedNode = commitNode();
                if (updatedNode) onOpenTechnicalDetails?.(updatedNode);
              }}
            >
              {t('flows.inspector.technicalDetails')}
            </Button>

            <Typography variant="caption" color="text.secondary">
              {beginnerMode
                ? t('flows.inspector.beginnerTip')
                : t('flows.inspector.expertTip')}
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" gap={1} alignItems="center">
              <SettingsSuggestRoundedIcon color="primary" fontSize="small" />
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>
                  {beginnerMode ? t('flows.inspector.aboutAgent') : t('flows.inspector.flowDetails')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {beginnerMode
                    ? t('flows.inspector.aboutHelp')
                    : t('flows.inspector.flowHelp')}
                </Typography>
              </Box>
            </Stack>

            <TextField
              size="small"
              label={beginnerMode ? t('flows.inspector.agentName') : t('flows.inspector.flowName')}
              value={flowName}
              onChange={(event) => onFlowNameChange(event.target.value)}
              error={!!flowNameError}
              helperText={
                flowNameError
                  ?? (beginnerMode ? t('flows.inspector.agentNameHelp') : t('flows.inspector.renameHelp'))
              }
              fullWidth
            />

            {onCheckPlausibility && (
              <Button variant="outlined" startIcon={<AutoAwesomeRoundedIcon />} onClick={onCheckPlausibility}>
                {t('flows.inspector.checkAgent')}
              </Button>
            )}

            <TextField
              size="small"
              label={beginnerMode ? t('flows.inspector.helpQuestion') : t('flows.inspector.description')}
              value={flowDescription}
              onChange={(event) => onFlowDescriptionChange(event.target.value)}
              multiline
              minRows={3}
              maxRows={7}
              fullWidth
              placeholder={beginnerMode ? t('flows.inspector.agentDescriptionPlaceholder') : t('flows.inspector.flowDescriptionPlaceholder')}
            />

            {!beginnerMode && (
            <Box
              sx={(theme) => ({
                p: 1.25,
                borderRadius: 2.5,
                border: `1px solid ${theme.palette.divider}`,
                bgcolor: alpha(theme.palette.primary.main, 0.04),
              })}
            >
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={authoringMode === 'advanced'}
                    onChange={(event) => onAuthoringModeChange(event.target.checked ? 'advanced' : 'guided')}
                  />
                }
                label={authoringMode === 'advanced' ? t('flows.inspector.advanced') : t('flows.inspector.guided')}
              />
              <Typography variant="caption" color="text.secondary" display="block">
                {authoringMode === 'advanced'
                  ? t('flows.inspector.advancedHelp')
                  : t('flows.inspector.guidedHelp')}
              </Typography>
            </Box>
            )}

            {!beginnerMode && (
              <>
                <Divider />
                <Typography variant="caption" color="text.secondary">
                  {t('flows.inspector.shortcuts')}
                </Typography>
              </>
            )}
          </Stack>
        )}
      </Box>
    </InspectorSurface>
  );
};

export default InspectorPanel;

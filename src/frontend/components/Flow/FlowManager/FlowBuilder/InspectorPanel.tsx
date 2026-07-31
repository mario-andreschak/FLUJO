"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
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
import type { FlowNode } from '@/frontend/types/flow/flow';
import type { FlowAuthoringMode } from '@/utils/shared/flowAuthoringProfile';

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
  flowName: string;
  flowNameError: string | null;
  onFlowNameChange: (value: string) => void;
  flowDescription: string;
  onFlowDescriptionChange: (value: string) => void;
  authoringMode: FlowAuthoringMode;
  onAuthoringModeChange: (mode: FlowAuthoringMode) => void;
  permissionRuleCount: number;
  onOpenPermissionRules: () => void;
  beginnerMode?: boolean;
}

const typeLabel = (node: FlowNode, beginnerMode: boolean) => {
  const type = String(node.data.type || node.type || 'node');
  if (beginnerMode) {
    const friendlyTypes: Record<string, string> = {
      start: 'When it starts',
      process: 'AI step',
      finish: 'Final answer',
      mcp: 'Connected app',
      subflow: 'Another agent',
      resource: 'Saved information',
      signal: 'Notification',
      trigger: 'Automatic start',
    };
    return friendlyTypes[type] ?? 'Step';
  }
  if (type === 'mcp') return 'MCP';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
};

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  selectedNode,
  onClearSelection,
  onCommitNode,
  onOpenAdvanced,
  flowName,
  flowNameError,
  onFlowNameChange,
  flowDescription,
  onFlowDescriptionChange,
  authoringMode,
  onAuthoringModeChange,
  permissionRuleCount,
  onOpenPermissionRules,
  beginnerMode = false,
}) => {
  const [tab, setTab] = useState<InspectorTab>(selectedNode ? 'node' : 'flow');
  const [label, setLabel] = useState(selectedNode?.data.label ?? '');
  const [description, setDescription] = useState(selectedNode?.data.description ?? '');
  const [promptTemplate, setPromptTemplate] = useState(
    String(selectedNode?.data.properties?.promptTemplate ?? ''),
  );

  useEffect(() => {
    if (selectedNode) setTab('node');
    else setTab('flow');
  }, [selectedNode?.id]);

  useEffect(() => {
    setLabel(selectedNode?.data.label ?? '');
    setDescription(selectedNode?.data.description ?? '');
    setPromptTemplate(String(selectedNode?.data.properties?.promptTemplate ?? ''));
  }, [selectedNode?.id, selectedNode?.data]);

  const nodeSummary = useMemo(() => {
    if (!selectedNode) return [];
    const properties = selectedNode.data.properties ?? {};
    const entries: Array<{ label: string; value: string }> = [];
    if (typeof properties.modelId === 'string' && properties.modelId) {
      entries.push({ label: beginnerMode ? 'AI' : 'Model', value: properties.modelId });
    } else if (typeof properties.model === 'string' && properties.model) {
      entries.push({ label: beginnerMode ? 'AI' : 'Model', value: properties.model });
    }
    if (typeof properties.boundServer === 'string' && properties.boundServer) {
      entries.push({ label: beginnerMode ? 'App' : 'Server', value: properties.boundServer });
    }
    if (typeof properties.subflowId === 'string' && properties.subflowId) {
      entries.push({ label: beginnerMode ? 'Agent' : 'Flow', value: properties.subflowId });
    }
    if (typeof properties.signalName === 'string' && properties.signalName) {
      entries.push({ label: beginnerMode ? 'Notification' : 'Signal', value: properties.signalName });
    }
    return entries;
  }, [selectedNode, beginnerMode]);

  const commitNode = (): FlowNode | null => {
    if (!selectedNode) return null;
    const nextProperties = { ...(selectedNode.data.properties ?? {}) };
    if (selectedNode.data.type === 'process' || selectedNode.data.type === 'start') {
      nextProperties.promptTemplate = promptTemplate;
    }
    const nextData: FlowNode['data'] = {
      ...selectedNode.data,
      label: label.trim() || selectedNode.data.label,
      description: description.trim() || undefined,
      properties: nextProperties,
    };
    if (JSON.stringify(nextData) !== JSON.stringify(selectedNode.data)) {
      onCommitNode(selectedNode.id, nextData);
    }
    return { ...selectedNode, data: nextData };
  };

  return (
    <InspectorSurface
      elevation={0}
      aria-label={beginnerMode && selectedNode ? 'Step settings' : beginnerMode ? 'Agent settings' : 'Flow inspector'}
    >
      <Box sx={{ px: 1.5, pt: 1.25 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '.12em' }}>
              {beginnerMode
                ? selectedNode ? 'Edit this step' : 'Agent settings'
                : 'Inspector'}
            </Typography>
            <Typography variant="subtitle1" fontWeight={800} noWrap>
              {selectedNode ? selectedNode.data.label : flowName}
            </Typography>
          </Box>
          {selectedNode && (
            <Tooltip title={beginnerMode ? 'Close step settings' : 'Clear node selection'}>
              <IconButton size="small" aria-label={beginnerMode ? 'Close step settings' : 'Close node inspector'} onClick={onClearSelection}>
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
            <Tab value="node" label="Node" disabled={!selectedNode} />
            <Tab value="flow" label="Flow" />
          </Tabs>
        )}
      </Box>

      <Divider />

      <Box sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}>
        {tab === 'node' && selectedNode ? (
          <Stack spacing={1.5}>
            <Stack direction="row" alignItems="center" gap={1}>
              <Chip
                size="small"
                label={typeLabel(selectedNode, beginnerMode)}
                color={selectedNode.data.type === 'finish' ? 'success' : 'primary'}
                variant="outlined"
              />
              {!beginnerMode && (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {selectedNode.id}
                </Typography>
              )}
            </Stack>

            <TextField
              label={beginnerMode ? 'Step name' : 'Node name'}
              size="small"
              fullWidth
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onBlur={commitNode}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />

            <TextField
              label={beginnerMode ? 'Short note (optional)' : 'What this step does'}
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={commitNode}
              placeholder={beginnerMode ? 'A reminder about why this step is here' : 'Optional note for future you'}
            />

            {(selectedNode.data.type === 'process' || selectedNode.data.type === 'start') && (
              <TextField
                label={
                  beginnerMode
                    ? selectedNode.data.type === 'start' ? 'Helpful background' : 'What should the AI do?'
                    : selectedNode.data.type === 'start' ? 'Starting context' : 'Task prompt'
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
                    ? beginnerMode ? 'Anything the agent should always know' : 'Optional context injected when the flow starts'
                    : beginnerMode ? 'Explain the job in everyday language' : 'Describe the result this step should produce'
                }
                helperText={
                  beginnerMode
                    ? 'Your change is applied when you leave this field.'
                    : 'Changes apply when you leave the field. Ctrl/⌘ + Enter applies immediately.'
                }
              />
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

            <Button
              variant={beginnerMode ? 'outlined' : 'contained'}
              startIcon={<TuneRoundedIcon />}
              endIcon={<OpenInNewRoundedIcon />}
              onClick={() => {
                const updatedNode = commitNode();
                if (updatedNode) onOpenAdvanced(updatedNode);
              }}
            >
              {beginnerMode ? 'More options' : 'Full settings'}
            </Button>

            <Typography variant="caption" color="text.secondary">
              {beginnerMode
                ? 'Most people only need the fields above. More options contains AI and connected-app controls.'
                : 'Single-click any node to inspect it. Double-click opens full settings immediately.'}
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" gap={1} alignItems="center">
              <SettingsSuggestRoundedIcon color="primary" fontSize="small" />
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>
                  {beginnerMode ? 'About your agent' : 'Flow details'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {beginnerMode
                    ? 'Give it a clear name and say what it is for.'
                    : 'Name, describe, and tune the whole workflow.'}
                </Typography>
              </Box>
            </Stack>

            <TextField
              size="small"
              label={beginnerMode ? 'Agent name' : 'Flow Name'}
              value={flowName}
              onChange={(event) => onFlowNameChange(event.target.value)}
              error={!!flowNameError}
              helperText={
                flowNameError
                  ?? (beginnerMode ? 'Use a short name you will recognize.' : 'Renames save directly—Duplicate is a separate command.')
              }
              fullWidth
            />

            <TextField
              size="small"
              label={beginnerMode ? 'What should it help with?' : 'Description'}
              value={flowDescription}
              onChange={(event) => onFlowDescriptionChange(event.target.value)}
              multiline
              minRows={3}
              maxRows={7}
              fullWidth
              placeholder={beginnerMode ? 'Example: Turns long notes into a short, friendly summary' : 'What this flow accomplishes'}
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
                label={authoringMode === 'advanced' ? 'Advanced' : 'Guided'}
              />
              <Typography variant="caption" color="text.secondary" display="block">
                {authoringMode === 'advanced'
                  ? 'Runtime, routing, resources, signals, and scheduling are visible.'
                  : 'The common authoring controls stay focused and calm.'}
              </Typography>
            </Box>
            )}

            {authoringMode === 'advanced' && (
              <Button
                variant="outlined"
                onClick={onOpenPermissionRules}
                startIcon={<SettingsSuggestRoundedIcon />}
              >
                Permission rules{permissionRuleCount ? ` (${permissionRuleCount})` : ''}
              </Button>
            )}

            {!beginnerMode && (
              <>
                <Divider />
                <Typography variant="caption" color="text.secondary">
                  Shortcuts: A or / adds a step · Ctrl/⌘ S saves · Ctrl/⌘ Z undoes.
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

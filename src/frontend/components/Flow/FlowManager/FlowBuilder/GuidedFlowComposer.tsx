"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import type { FlowNode, NodeType } from '@/frontend/types/flow/flow';

interface GuidedFlowComposerProps {
  nodes: FlowNode[];
  orderedStepIds?: string[];
  selectedNodeId?: string;
  flowName: string;
  flowNameError: string | null;
  onFlowNameChange: (value: string) => void;
  onSelectNode: (nodeId: string) => void;
  onAddTask: (prompt: string) => void;
  onTry?: () => void;
  isSaving?: boolean;
  hasAdvancedFeatures?: boolean;
  readyToTry?: boolean;
  needsAIConnection?: boolean;
  onSwitchAdvanced: () => void;
}

const defaultFriendlyLabels: Partial<Record<NodeType, string>> = {
  process: 'AI works on the task',
  subflow: 'Ask another agent',
  signal: 'Notify another automation',
};

const technicalDefaultLabels = new Set([
  'Process Node',
  'Subflow Node',
  'Signal Node',
]);

const friendlyType = (type: NodeType) => {
  if (type === 'subflow') return 'Another agent';
  if (type === 'signal') return 'Notification';
  return 'AI step';
};

const friendlyTitle = (node: FlowNode) => {
  const label = node.data.label?.trim();
  if (!label || technicalDefaultLabels.has(label)) {
    return defaultFriendlyLabels[node.data.type as NodeType] ?? 'Agent step';
  }
  return label;
};

const friendlySummary = (node: FlowNode) => {
  const prompt = String(node.data.properties?.promptTemplate ?? '').trim();
  if (prompt) return prompt;
  if (node.data.description?.trim()) return node.data.description.trim();
  if (node.data.type === 'subflow') return 'Hand this part of the job to another saved agent.';
  if (node.data.type === 'signal') return 'Let another automation know that this point was reached.';
  return 'Click this step to describe the result you want.';
};

const StepNumber = ({ children, complete = false }: { children: React.ReactNode; complete?: boolean }) => (
  <Box
    aria-hidden="true"
    sx={{
      display: 'grid',
      width: 34,
      height: 34,
      flexShrink: 0,
      placeItems: 'center',
      borderRadius: '50%',
      color: complete ? 'success.contrastText' : 'primary.contrastText',
      bgcolor: complete ? 'success.main' : 'primary.main',
      fontWeight: 850,
      boxShadow: (theme) => `0 8px 24px ${alpha(
        complete ? theme.palette.success.main : theme.palette.primary.main,
        0.28,
      )}`,
    }}
  >
    {complete ? <CheckRoundedIcon fontSize="small" /> : children}
  </Box>
);

export const GuidedFlowComposer: React.FC<GuidedFlowComposerProps> = ({
  nodes,
  orderedStepIds = [],
  selectedNodeId,
  flowName,
  flowNameError,
  onFlowNameChange,
  onSelectNode,
  onAddTask,
  onTry,
  isSaving = false,
  hasAdvancedFeatures = false,
  readyToTry = true,
  needsAIConnection = false,
  onSwitchAdvanced,
}) => {
  const [taskPrompt, setTaskPrompt] = useState('');
  const steps = useMemo(
    () => {
      const order = new Map(orderedStepIds.map((nodeId, index) => [nodeId, index]));
      return nodes
        .filter((node) => ['process', 'subflow', 'signal'].includes(node.data.type))
        .sort((a, b) =>
          (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
          || (a.position?.y ?? 0) - (b.position?.y ?? 0)
        );
    },
    [nodes, orderedStepIds],
  );
  const hasUsefulName = !!flowName.trim()
    && !/^(?:NewFlow\d*|Untitled (?:assistant|agent)(?: \d+)?)$/i.test(flowName.trim())
    && !flowNameError;
  const canAdd = !!taskPrompt.trim() && !hasAdvancedFeatures;
  const canTry = hasUsefulName && steps.length > 0 && readyToTry && !isSaving;

  const addTask = () => {
    const prompt = taskPrompt.trim();
    if (!prompt) return;
    onAddTask(prompt);
    setTaskPrompt('');
  };

  return (
    <Box
      aria-label="Guided agent builder"
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        px: { xs: 0.5, sm: 1.5, lg: 3 },
        py: { xs: 1, sm: 1.5, lg: 2.5 },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 780, mx: 'auto' }}>
        <Stack spacing={0.8} sx={{ mb: 2.5 }}>
          <Chip
            icon={<AutoAwesomeRoundedIcon />}
            label="Simple setup"
            color="primary"
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
          />
          <Typography variant="h4">Build it like a simple recipe.</Typography>
          <Typography color="text.secondary">
            No diagrams or technical setup needed. Tell FLUJO what you want, one step at a time.
          </Typography>
        </Stack>

        <Stack spacing={1.5}>
          <Paper
            elevation={0}
            sx={{
              p: { xs: 2, sm: 2.5 },
              border: 1,
              borderColor: hasUsefulName ? 'success.main' : 'divider',
              borderRadius: 4,
              bgcolor: 'background.paper',
            }}
          >
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <StepNumber complete={hasUsefulName}>1</StepNumber>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6">Give your agent a name</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Pick something you will recognize later, like “Trip planner” or “Weekly report helper.”
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  label="Agent name"
                  value={flowName}
                  error={!!flowNameError}
                  helperText={flowNameError ?? (hasUsefulName ? 'Looks good.' : 'Use a short, memorable name.')}
                  onChange={(event) => onFlowNameChange(event.target.value)}
                  onFocus={(event) => {
                    if (/^(?:NewFlow\d*|Untitled (?:assistant|agent)(?: \d+)?)$/i.test(event.currentTarget.value)) {
                      event.currentTarget.select();
                    }
                  }}
                />
              </Box>
            </Stack>
          </Paper>

          <Paper
            elevation={0}
            sx={{
              p: { xs: 2, sm: 2.5 },
              border: 1,
              borderColor: steps.length > 0 ? 'success.main' : 'divider',
              borderRadius: 4,
              bgcolor: 'background.paper',
            }}
          >
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <StepNumber complete={steps.length > 0}>2</StepNumber>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6">Tell it what to do</Typography>
                <Typography variant="body2" color="text.secondary">
                  Write it the same way you would explain the job to a helpful person.
                </Typography>

                {hasAdvancedFeatures && (
                  <Alert
                    severity="info"
                    action={
                      <Button color="inherit" size="small" onClick={onSwitchAdvanced}>
                        Open expert view
                      </Button>
                    }
                    sx={{ mt: 1.5 }}
                  >
                    This agent uses branches or expert settings. You can review it here and make structural changes in Expert view.
                  </Alert>
                )}

                <Stack spacing={1} sx={{ mt: 2 }}>
                  <Box
                    sx={{
                      px: 1.5,
                      py: 1,
                      borderRadius: 3,
                      color: 'text.secondary',
                      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.055),
                      border: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography variant="caption" fontWeight={800} color="primary.main">
                      WHEN
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>Someone asks this agent for help</Typography>
                  </Box>

                  {steps.map((node, index) => (
                    <React.Fragment key={node.id}>
                      <ArrowDownwardRoundedIcon
                        aria-hidden="true"
                        sx={{ alignSelf: 'center', color: 'text.disabled', fontSize: 20 }}
                      />
                      <ButtonBase
                        onClick={() => onSelectNode(node.id)}
                        sx={{ display: 'block', width: '100%', borderRadius: 3, textAlign: 'left' }}
                      >
                        <Paper
                          elevation={0}
                          sx={{
                            width: '100%',
                            p: 1.5,
                            border: 1,
                            borderColor: selectedNodeId === node.id ? 'primary.main' : 'divider',
                            borderRadius: 3,
                            bgcolor: selectedNodeId === node.id
                              ? (theme) => alpha(theme.palette.primary.main, 0.1)
                              : 'background.default',
                            boxShadow: selectedNodeId === node.id
                              ? (theme) => `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}`
                              : 'none',
                          }}
                        >
                          <Stack direction="row" spacing={1.25} alignItems="flex-start">
                            <Box
                              sx={{
                                display: 'grid',
                                width: 30,
                                height: 30,
                                flexShrink: 0,
                                placeItems: 'center',
                                borderRadius: 2,
                                color: 'primary.contrastText',
                                bgcolor: 'primary.main',
                                fontWeight: 850,
                              }}
                            >
                              {index + 1}
                            </Box>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Typography variant="overline" color="primary.main">
                                {friendlyType(node.data.type as NodeType)}
                              </Typography>
                              <Typography variant="subtitle1" fontWeight={800}>
                                {friendlyTitle(node)}
                              </Typography>
                              <Typography
                                variant="body2"
                                color="text.secondary"
                                sx={{
                                  mt: 0.35,
                                  display: '-webkit-box',
                                  overflow: 'hidden',
                                  WebkitBoxOrient: 'vertical',
                                  WebkitLineClamp: 2,
                                }}
                              >
                                {friendlySummary(node)}
                              </Typography>
                            </Box>
                            <TuneRoundedIcon color="action" fontSize="small" />
                          </Stack>
                        </Paper>
                      </ButtonBase>
                    </React.Fragment>
                  ))}

                  <ArrowDownwardRoundedIcon
                    aria-hidden="true"
                    sx={{ alignSelf: 'center', color: 'text.disabled', fontSize: 20 }}
                  />
                  <Box
                    sx={{
                      px: 1.5,
                      py: 1,
                      borderRadius: 3,
                      color: 'text.secondary',
                      bgcolor: (theme) => alpha(theme.palette.success.main, 0.055),
                      border: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography variant="caption" fontWeight={800} color="success.main">
                      THEN
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>Send the finished answer back</Typography>
                  </Box>
                </Stack>

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="stretch" sx={{ mt: 2 }}>
                  <TextField
                    fullWidth
                    multiline
                    minRows={2}
                    maxRows={5}
                    label={steps.length ? 'Add another thing it should do' : 'What should the AI do?'}
                    placeholder="Example: Read my notes, find the important points, and explain them simply."
                    value={taskPrompt}
                    disabled={hasAdvancedFeatures}
                    onChange={(event) => setTaskPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canAdd) {
                        event.preventDefault();
                        addTask();
                      }
                    }}
                  />
                  <Button
                    variant="contained"
                    startIcon={<AddRoundedIcon />}
                    disabled={!canAdd}
                    onClick={addTask}
                    sx={{ minWidth: { sm: 150 } }}
                  >
                    Add this step
                  </Button>
                </Stack>
              </Box>
            </Stack>
          </Paper>

          <Paper
            elevation={0}
            sx={{
              p: { xs: 2, sm: 2.5 },
              border: 1,
              borderColor: canTry ? 'primary.main' : 'divider',
              borderRadius: 4,
              bgcolor: (theme) => alpha(theme.palette.primary.main, canTry ? 0.075 : 0.025),
            }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
              <StepNumber>3</StepNumber>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6">Try it with a real question</Typography>
                <Typography variant="body2" color="text.secondary">
                  FLUJO will save your changes, then open a normal chat so you can see how it feels.
                </Typography>
                {needsAIConnection && steps.some(node => node.data.type === 'process') && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    This step still needs an AI. Select the step, choose More options, and connect the AI you want to use.
                  </Alert>
                )}
              </Box>
              {onTry && (
                <Button
                  size="large"
                  variant="contained"
                  startIcon={<PlayArrowRoundedIcon />}
                  disabled={!canTry}
                  onClick={onTry}
                >
                  {isSaving ? 'Saving…' : 'Try my agent'}
                </Button>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Box>
    </Box>
  );
};

export default GuidedFlowComposer;

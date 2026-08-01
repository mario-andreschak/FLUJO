"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Paper,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
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
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';

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
  models?: Array<{ id: string; name: string; displayName?: string }>;
  aiAssistance?: 'unasked' | 'manual' | 'assisted';
  selectedModelId?: string | null;
  onChooseAssistance?: (choice: 'manual' | 'assisted') => void;
  onModelChange?: (modelId: string) => void;
  onCheckPlausibility?: () => void;
}

const technicalDefaultLabels = new Set([
  'Process Node',
  'Subflow Node',
  'Signal Node',
]);

const friendlyType = (type: NodeType, t: Translator) => {
  if (type === 'subflow') return t('flows.guided.type.subflow');
  if (type === 'signal') return t('flows.guided.type.signal');
  return t('flows.guided.type.process');
};

const friendlyTitle = (node: FlowNode, t: Translator) => {
  const label = node.data.label?.trim();
  if (!label || technicalDefaultLabels.has(label)) {
    if (node.data.type === 'process') return t('flows.guided.default.process');
    if (node.data.type === 'subflow') return t('flows.guided.default.subflow');
    if (node.data.type === 'signal') return t('flows.guided.default.signal');
    return t('flows.guided.default.step');
  }
  return label;
};

const friendlySummary = (node: FlowNode, t: Translator) => {
  const prompt = String(node.data.properties?.promptTemplate ?? '').trim();
  if (prompt) return prompt;
  if (node.data.description?.trim()) return node.data.description.trim();
  if (node.data.type === 'subflow') return t('flows.guided.summary.subflow');
  if (node.data.type === 'signal') return t('flows.guided.summary.signal');
  return t('flows.guided.summary.process');
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
  models = [],
  aiAssistance = 'manual',
  selectedModelId,
  onChooseAssistance,
  onModelChange,
  onCheckPlausibility,
}) => {
  const { t } = useI18n();
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
  const canAdd = !!taskPrompt.trim()
    && !hasAdvancedFeatures
    && aiAssistance !== 'unasked'
    && (aiAssistance !== 'assisted' || !!selectedModelId);
  const canTry = hasUsefulName && steps.length > 0 && readyToTry && !isSaving;

  const addTask = () => {
    const prompt = taskPrompt.trim();
    if (!prompt) return;
    onAddTask(prompt);
    setTaskPrompt('');
  };

  return (
    <Box
      aria-label={t('flows.guided.aria')}
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
            label={t('flows.guided.simple')}
            color="primary"
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
          />
          <Typography variant="h4">{t('flows.guided.recipe')}</Typography>
          <Typography color="text.secondary">
            {t('flows.guided.intro')}
          </Typography>
        </Stack>

        <Stack spacing={1.5}>
          {models.length > 0 && onChooseAssistance && (
            <Paper
              elevation={0}
              sx={{ p: { xs: 2, sm: 2.5 }, border: 1, borderColor: aiAssistance === 'unasked' ? 'primary.main' : 'divider', borderRadius: 4 }}
            >
              <Stack spacing={1.5}>
                <Box>
                  <Typography variant="h6">{t('flows.guided.aiQuestion')}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('flows.guided.aiHelp')}
                  </Typography>
                </Box>
                {aiAssistance === 'unasked' ? (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <Button variant="contained" startIcon={<AutoAwesomeRoundedIcon />} onClick={() => onChooseAssistance('assisted')}>
                      {t('flows.guided.yesHelp')}
                    </Button>
                    <Button variant="outlined" onClick={() => onChooseAssistance('manual')}>{t('flows.guided.manual')}</Button>
                  </Stack>
                ) : (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                    <Chip
                      color={aiAssistance === 'assisted' ? 'primary' : 'default'}
                      label={aiAssistance === 'assisted' ? t('flows.guided.aiOn') : t('flows.guided.manualSetup')}
                    />
                    {aiAssistance === 'assisted' && onModelChange && (
                      <FormControl size="small" sx={{ minWidth: 260 }}>
                        <InputLabel id="guided-helper-model-label">{t('flows.guided.aiHelper')}</InputLabel>
                        <Select
                          labelId="guided-helper-model-label"
                          label={t('flows.guided.aiHelper')}
                          value={selectedModelId ?? ''}
                          onChange={(event) => onModelChange(String(event.target.value))}
                        >
                          {models.map((model) => (
                            <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    )}
                    <Button size="small" onClick={() => onChooseAssistance(aiAssistance === 'assisted' ? 'manual' : 'assisted')}>
                      {aiAssistance === 'assisted' ? t('flows.guided.turnOff') : t('flows.guided.turnOn')}
                    </Button>
                  </Stack>
                )}
              </Stack>
            </Paper>
          )}

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
                <Typography variant="h6">{t('flows.guided.nameTitle')}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {t('flows.guided.nameHelp')}
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  label={t('flows.guided.name')}
                  value={flowName}
                  error={!!flowNameError}
                  helperText={flowNameError ?? (hasUsefulName ? t('flows.guided.looksGood') : t('flows.guided.nameHint'))}
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
                <Typography variant="h6">{steps.length ? t('flows.guided.addAnother') : t('flows.guided.goalQuestion')}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {steps.length
                    ? t('flows.guided.nextHelp')
                    : t('flows.guided.goalHelp')}
                </Typography>

                {hasAdvancedFeatures && (
                  <Alert
                    severity="info"
                    action={
                      <Button color="inherit" size="small" onClick={onSwitchAdvanced}>
                        {t('flows.guided.openExpert')}
                      </Button>
                    }
                    sx={{ mt: 1.5 }}
                  >
                    {t('flows.guided.advancedWarning')}
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
                      {t('flows.guided.when').toLocaleUpperCase()}
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>{t('flows.guided.someoneAsks')}</Typography>
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
                                {friendlyType(node.data.type as NodeType, t)}
                              </Typography>
                              <Typography variant="subtitle1" fontWeight={800}>
                                {friendlyTitle(node, t)}
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
                                {friendlySummary(node, t)}
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
                      {t('flows.guided.then').toLocaleUpperCase()}
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>{t('flows.guided.sendAnswer')}</Typography>
                  </Box>
                </Stack>

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="stretch" sx={{ mt: 2 }}>
                  <TextField
                    fullWidth
                    multiline
                    minRows={2}
                    maxRows={5}
                    label={steps.length ? t('flows.guided.nextLabel') : t('flows.guided.goalLabel')}
                    placeholder={t('flows.guided.goalPlaceholder')}
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
                    {steps.length ? t('flows.guided.addStep') : t('flows.guided.createGoal')}
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
                <Typography variant="h6">{t('flows.guided.tryTitle')}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t('flows.guided.tryHelp')}
                </Typography>
                {needsAIConnection && steps.some(node => node.data.type === 'process') && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    {t('flows.guided.needsAi')}
                  </Alert>
                )}
              </Box>
              {onTry && (
                <Stack spacing={1}>
                  {onCheckPlausibility && aiAssistance === 'assisted' && (
                    <Button variant="outlined" startIcon={<AutoAwesomeRoundedIcon />} disabled={steps.length === 0} onClick={onCheckPlausibility}>
                      {t('flows.guided.checkAi')}
                    </Button>
                  )}
                  <Button
                    size="large"
                    variant="contained"
                    startIcon={<PlayArrowRoundedIcon />}
                    disabled={!canTry}
                    onClick={onTry}
                  >
                    {isSaving ? t('flows.guided.saving') : t('flows.guided.tryAgent')}
                  </Button>
                </Stack>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Box>
    </Box>
  );
};

export default GuidedFlowComposer;

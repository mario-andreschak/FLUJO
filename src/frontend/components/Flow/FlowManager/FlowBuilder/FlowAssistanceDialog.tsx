"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AskFlujoButton from '@/frontend/components/AskFlujo/AskFlujoButton';
import BugReportButton from '@/frontend/components/BugReport/BugReportButton';
import type { Flow } from '@/shared/types/flow';
import type {
  FlowPlausibilityResult,
  PlausibilityIssue,
  PlausibilityPatch,
  StepAgentSuggestionResult,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import { flowService } from '@/frontend/services/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { localizeFlowIssue } from '@/frontend/i18n/flowValidation';
import { applyPlausibilityPatches } from '@/utils/shared/flowAssistance';

interface FlowAssistanceDialogProps {
  open: boolean;
  flow: Flow;
  relatedFlows?: Flow[];
  nodeId?: string | null;
  initialFocus?: 'apps' | 'agents' | 'review';
  modelId?: string | null;
  models?: Array<{ id: string; name: string; displayName?: string }>;
  onApply: (flow: Flow) => void;
  onApplyRelatedFlows?: (flows: Flow[]) => void;
  onClose: () => void;
}

type Stage = 'suggesting' | 'tools' | 'suggesting-agents' | 'agents' | 'improving' | 'checking' | 'plausibility' | 'fixing';

interface PlausibilityIssueEntry {
  key: string;
  issue: PlausibilityIssue;
  flowId: string;
  patches: PlausibilityPatch[];
  selectable: boolean;
}

interface ToolSuggestionDiscussionTurn {
  message: string;
  response?: string;
}

function patchesForIssue(issue: PlausibilityIssue, patches: PlausibilityPatch[]): PlausibilityPatch[] {
  return patches.filter((patch) => (
    patch.flowId === issue.flowId
    && patch.nodeId === issue.nodeId
    && patch.reason === issue.message
  ));
}

function selectedIssueRepairRequest(entries: PlausibilityIssueEntry[]): string {
  const findings = entries.map(({ issue }) => (
    `- [${issue.severity}/${issue.code}] ${issue.message}${issue.nodeId ? ` (node: ${issue.nodeId})` : ''}`
  )).join('\n');
  return (
    'Fix only the selected plausibility findings below. Preserve all other behavior, prompts, and graph structure unless a selected finding requires a change. ' +
    'Do not add capabilities or install tools.\n\nSELECTED FINDINGS:\n' + findings
  );
}

export default function FlowAssistanceDialog({
  open,
  flow,
  relatedFlows = [],
  nodeId,
  initialFocus = 'apps',
  modelId,
  models = [],
  onApply,
  onApplyRelatedFlows,
  onClose,
}: FlowAssistanceDialogProps) {
  const { t, tp } = useI18n();
  const [stage, setStage] = useState<Stage>('suggesting');
  const [suggestion, setSuggestion] = useState<StepToolSuggestionResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [agentSuggestion, setAgentSuggestion] = useState<StepAgentSuggestionResult | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [approvedAppPrompt, setApprovedAppPrompt] = useState<string | null>(null);
  const [selectedIssueKeys, setSelectedIssueKeys] = useState<Set<string>>(new Set());
  const [plausibility, setPlausibility] = useState<FlowPlausibilityResult | null>(null);
  const [workingFlow, setWorkingFlow] = useState(flow);
  const [chosenModelId, setChosenModelId] = useState(modelId ?? '');
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionDraft, setDiscussionDraft] = useState('');
  const [discussionTurns, setDiscussionTurns] = useState<ToolSuggestionDiscussionTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const check = async (candidate: Flow) => {
    setStage('checking');
    setError(null);
    try {
      const result = await flowService.checkPlausibility({
        flow: candidate,
        relatedFlows,
        modelId: chosenModelId || modelId || undefined,
        intendedContext: 'chat',
      });
      setPlausibility(result);
      setSelectedIssueKeys(new Set());
      setStage('plausibility');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.checkFailed'));
      setStage('plausibility');
    }
  };

  const suggestAgents = async (candidate: Flow, requestedModelId?: string) => {
    if (!nodeId) return;
    const suggestionModelId = requestedModelId || chosenModelId || modelId || '';
    if (!suggestionModelId) {
      setStage('agents');
      return;
    }
    setStage('suggesting-agents');
    setError(null);
    try {
      const result = await flowService.suggestAgentsForStep({
        flow: candidate,
        nodeId,
        modelId: suggestionModelId,
        goal: candidate.description,
      });
      setAgentSuggestion(result);
      setSelectedAgents(new Set(result.suggestions.map((item) => item.flowId)));
      setStage('agents');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.agentSuggestFailed'));
      setStage('agents');
    }
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setWorkingFlow(flow);
    setSuggestion(null);
    setAgentSuggestion(null);
    setPlausibility(null);
    setSelected(new Set());
    setSelectedAgents(new Set());
    setApprovedAppPrompt(null);
    setSelectedIssueKeys(new Set());
    setChosenModelId(modelId ?? '');
    setDiscussionOpen(false);
    setDiscussionDraft('');
    setDiscussionTurns([]);
    setError(null);
    if (!nodeId || initialFocus === 'review') {
      void check(flow);
      return () => { active = false; };
    }
    if (!modelId) {
      setStage(initialFocus === 'agents' ? 'agents' : 'tools');
      return () => { active = false; };
    }
    if (initialFocus === 'agents') {
      setStage('suggesting-agents');
      void flowService.suggestAgentsForStep({
        flow,
        nodeId,
        modelId,
        goal: flow.description,
      }).then((result) => {
        if (!active) return;
        setAgentSuggestion(result);
        setSelectedAgents(new Set(result.suggestions.map((item) => item.flowId)));
        setStage('agents');
      }).catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : t('flows.assistance.agentSuggestFailed'));
        setStage('agents');
      });
      return () => { active = false; };
    }
    setStage('suggesting');
    void flowService.suggestToolsForStep({
      flow,
      relatedFlows,
      nodeId,
      modelId,
      goal: flow.description,
    }).then((result) => {
      if (!active) return;
      setSuggestion(result);
      setSelected(new Set(result.suggestions.map((item) => `${item.server}\u0000${item.tool}`)));
      setStage('tools');
    }).catch((caught) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : t('flows.assistance.suggestFailed'));
      setStage('tools');
    });
    return () => { active = false; };
    // The opening snapshot is intentional; live edits wait for the next review.
  }, [open, nodeId, modelId, initialFocus]);

  const chosen = useMemo(
    () => suggestion?.suggestions.filter((item) => selected.has(`${item.server}\u0000${item.tool}`)) ?? [],
    [selected, suggestion],
  );
  const chosenAgents = useMemo(
    () => agentSuggestion?.suggestions.filter((item) => selectedAgents.has(item.flowId)) ?? [],
    [agentSuggestion, selectedAgents],
  );
  const applicablePatchCount = useMemo(() => {
    if (!plausibility) return 0;
    const editableIds = new Set([flow.id, ...relatedFlows.map((candidate) => candidate.id)]);
    return plausibility.patches.filter((patch) => editableIds.has(patch.flowId)).length;
  }, [flow.id, plausibility, relatedFlows]);
  const issueEntries = useMemo<PlausibilityIssueEntry[]>(() => {
    if (!plausibility) return [];
    const editableIds = new Set([flow.id, ...relatedFlows.map((candidate) => candidate.id)]);
    const aiFixAvailable = !!(chosenModelId || modelId || models.length > 0);
    return plausibility.issues.map((issue, index) => {
      const targetFlowId = issue.flowId ?? flow.id;
      const directPatches = patchesForIssue(
        { ...issue, flowId: targetFlowId },
        plausibility.patches,
      );
      return {
        key: `issue-${index}`,
        issue,
        flowId: targetFlowId,
        patches: directPatches,
        selectable: editableIds.has(targetFlowId) && (directPatches.length > 0 || aiFixAvailable),
      };
    });
  }, [chosenModelId, flow.id, modelId, models.length, plausibility, relatedFlows]);
  const selectableIssueEntries = useMemo(
    () => issueEntries.filter((entry) => entry.selectable),
    [issueEntries],
  );
  const chosenIssueEntries = useMemo(
    () => issueEntries.filter((entry) => selectedIssueKeys.has(entry.key)),
    [issueEntries, selectedIssueKeys],
  );
  const selectedNeedsAi = chosenIssueEntries.some((entry) => entry.patches.length === 0);
  const effectiveFixModelId = chosenModelId || modelId || '';
  const allSelectableIssuesSelected = selectableIssueEntries.length > 0
    && selectableIssueEntries.every((entry) => selectedIssueKeys.has(entry.key));

  const suggestWithModel = async () => {
    if (!nodeId || !chosenModelId) return;
    setStage('suggesting');
    setError(null);
    try {
      const result = await flowService.suggestToolsForStep({
        flow: workingFlow,
        relatedFlows,
        nodeId,
        modelId: chosenModelId,
        goal: workingFlow.description,
      });
      setSuggestion(result);
      setSelected(new Set(result.suggestions.map((item) => `${item.server}\u0000${item.tool}`)));
      setStage('tools');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.suggestFailed'));
      setStage('tools');
    }
  };

  const suggestAgentsWithModel = async () => {
    if (!nodeId || !chosenModelId) return;
    await suggestAgents(workingFlow, chosenModelId);
  };

  const discussToolSuggestions = async () => {
    const message = discussionDraft.trim();
    const suggestionModelId = chosenModelId || modelId || '';
    if (!nodeId || !suggestion || !suggestionModelId || !message) return;
    const feedback = [...discussionTurns.map((turn) => turn.message), message];
    setStage('suggesting');
    setError(null);
    try {
      const result = await flowService.suggestToolsForStep({
        flow: workingFlow,
        relatedFlows,
        nodeId,
        modelId: suggestionModelId,
        goal: workingFlow.description,
        feedback,
        previousSuggestion: suggestion,
      });
      setSuggestion(result);
      setSelected(new Set(result.suggestions.map((item) => `${item.server}\u0000${item.tool}`)));
      setDiscussionTurns((current) => [...current, {
        message,
        response: result.assistantMessage,
      }]);
      setDiscussionDraft('');
      setStage('tools');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.suggestFailed'));
      setStage('tools');
    }
  };

  const applyTools = async () => {
    if (!nodeId || !suggestion) return;
    setStage('suggesting');
    setError(null);
    try {
      const updated = await flowService.applyToolsToStep({
        flow: workingFlow,
        nodeId,
        selections: chosen,
      });
      setWorkingFlow(updated);
      setApprovedAppPrompt(suggestion.proposedPrompt);
      onApply(updated);
      await suggestAgents(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.connectFailed'));
      setStage('tools');
    }
  };

  const improvePromptAndCheck = async (candidate: Flow) => {
    if (!nodeId) return;
    const promptModelId = chosenModelId || modelId || '';
    if (!promptModelId) {
      setError(t('flows.assistance.needModel'));
      setStage('agents');
      return;
    }
    setStage('improving');
    setError(null);
    try {
      const result = await flowService.improvePromptForStep({
        flow: candidate,
        relatedFlows,
        nodeId,
        modelId: promptModelId,
        ...(approvedAppPrompt ? { draftPrompt: approvedAppPrompt } : {}),
      });
      const improved = {
        ...candidate,
        nodes: candidate.nodes.map((node) => node.id === nodeId ? {
          ...node,
          data: {
            ...node.data,
            properties: {
              ...(node.data.properties ?? {}),
              promptTemplate: result.prompt,
            },
          },
        } : node),
      };
      setWorkingFlow(improved);
      onApply(improved);
      await check(improved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.improvePromptFailed'));
      setStage('agents');
    }
  };

  const applyAgents = async () => {
    if (!nodeId || !agentSuggestion) return;
    setStage('suggesting-agents');
    setError(null);
    try {
      const updated = await flowService.applyAgentsToStep({
        flow: workingFlow,
        nodeId,
        selections: chosenAgents,
      });
      setWorkingFlow(updated);
      onApply(updated);
      await improvePromptAndCheck(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.connectAgentsFailed'));
      setStage('agents');
    }
  };

  const fixSelectedIssues = async () => {
    if (!plausibility || chosenIssueEntries.length === 0) return;
    setStage('fixing');
    setError(null);
    try {
      const selectedPatches = chosenIssueEntries.flatMap((entry) => entry.patches);
      let bundle = applyPlausibilityPatches([workingFlow, ...relatedFlows], selectedPatches);
      const aiEntriesByFlow = new Map<string, PlausibilityIssueEntry[]>();
      for (const entry of chosenIssueEntries) {
        if (entry.patches.length > 0) continue;
        const current = aiEntriesByFlow.get(entry.flowId) ?? [];
        current.push(entry);
        aiEntriesByFlow.set(entry.flowId, current);
      }

      if (aiEntriesByFlow.size > 0) {
        if (!effectiveFixModelId) throw new Error(t('flows.assistance.needFixModel'));
        const improved = await Promise.all([...aiEntriesByFlow].map(async ([targetFlowId, entries]) => {
          const target = bundle.find((candidate) => candidate.id === targetFlowId);
          if (!target) throw new Error(t('flows.assistance.fixFailed'));
          const result = await flowService.improveFlow(
            target,
            selectedIssueRepairRequest(entries),
            effectiveFixModelId,
            {
              allowInstall: false,
              relatedFlows: bundle.filter((candidate) => candidate.id !== targetFlowId),
            },
          );
          if (!result.success) throw new Error(result.error);
          return result.flow;
        }));
        const improvedById = new Map(improved.map((candidate) => [candidate.id, candidate]));
        bundle = bundle.map((candidate) => improvedById.get(candidate.id) ?? candidate);
      }

      const updatedRoot = bundle.find((candidate) => candidate.id === workingFlow.id);
      if (!updatedRoot) throw new Error(t('flows.assistance.fixFailed'));
      setWorkingFlow(updatedRoot);
      onApply(updatedRoot);
      onApplyRelatedFlows?.(
        relatedFlows.map((candidate) => bundle.find((updated) => updated.id === candidate.id) ?? candidate),
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('flows.assistance.fixFailed'));
      setStage('plausibility');
    }
  };

  const busy = stage === 'suggesting'
    || stage === 'suggesting-agents'
    || stage === 'improving'
    || stage === 'checking'
    || stage === 'fixing';
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeRoundedIcon color="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {stage === 'plausibility' || stage === 'checking' || stage === 'fixing'
            ? t('flows.assistance.plausibilityTitle')
            : stage === 'agents' || stage === 'suggesting-agents'
              ? t('flows.assistance.agentsTitle')
              : stage === 'improving'
                ? t('flows.assistance.improvePromptTitle')
                : t('flows.assistance.toolsTitle')}
        </Box>
        <Box display="flex" alignItems="center" gap={0.5} flexShrink={0}>
          <AskFlujoButton />
          <BugReportButton variant="icon" />
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        {busy && (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}>
            <CircularProgress />
            <Typography color="text.secondary">
              {stage === 'suggesting'
                ? t('flows.assistance.finding')
                : stage === 'suggesting-agents'
                  ? t('flows.assistance.findingAgents')
                  : stage === 'improving'
                    ? t('flows.assistance.improvingPrompt')
                : stage === 'fixing'
                  ? t('flows.assistance.fixing')
                  : t('flows.assistance.checking')}
            </Typography>
          </Stack>
        )}
        {error && !busy && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {((stage === 'tools' && !suggestion) || (stage === 'agents' && !agentSuggestion)) && (
          <Stack spacing={2}>
            {models.length === 0 ? (
              <Alert severity="warning">{t('flows.assistance.needModel')}</Alert>
            ) : (
              <>
                <Alert severity="info">{t('flows.assistance.chooseModel')}</Alert>
                <FormControl fullWidth size="small">
                  <InputLabel id="assistance-model-label">{t('flows.assistance.aiHelper')}</InputLabel>
                  <Select
                    labelId="assistance-model-label"
                    label={t('flows.assistance.aiHelper')}
                    value={chosenModelId}
                    onChange={(event) => setChosenModelId(String(event.target.value))}
                  >
                    {models.map((model) => (
                      <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </>
            )}
          </Stack>
        )}

        {stage === 'tools' && suggestion && (
          <Stack spacing={1.5}>
            <Alert severity="info">
              {t('flows.assistance.approvalHelp')}
            </Alert>
            {suggestion.suggestions.length === 0 ? (
              <Alert severity="success">{t('flows.assistance.noTool')}</Alert>
            ) : suggestion.suggestions.map((item) => {
              const key = `${item.server}\u0000${item.tool}`;
              return (
                <Paper key={key} variant="outlined" sx={{ p: 1.25 }}>
                  <FormControlLabel
                    control={<Checkbox checked={selected.has(key)} onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(key); else next.delete(key);
                        return next;
                      });
                    }} />}
                    label={
                      <Box>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip size="small" label={item.server} />
                          <Typography fontWeight={800}>{item.tool}</Typography>
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{item.reason}</Typography>
                      </Box>
                    }
                  />
                </Paper>
              );
            })}
            <Box>
              <Typography variant="subtitle2">{t('flows.assistance.promptPreview')}</Typography>
              <Paper variant="outlined" sx={{ p: 1.25, mt: 0.5, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                <Typography variant="body2" component="pre" sx={{ m: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                  {suggestion.proposedPrompt}
                </Typography>
              </Paper>
            </Box>
            {discussionOpen && (
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={1.25}>
                  <Box>
                    <Typography variant="subtitle2">{t('flows.assistance.talkTitle')}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t('flows.assistance.talkHelp')}
                    </Typography>
                  </Box>
                  {discussionTurns.map((turn, index) => (
                    <Stack key={`${index}-${turn.message}`} spacing={0.75}>
                      <Box sx={{ alignSelf: 'flex-end', maxWidth: '85%', px: 1.25, py: 0.75, bgcolor: 'action.selected', borderRadius: 2 }}>
                        <Typography variant="caption" color="text.secondary">{t('flows.assistance.you')}</Typography>
                        <Typography variant="body2">{turn.message}</Typography>
                      </Box>
                      {turn.response && (
                        <Box sx={{ alignSelf: 'flex-start', maxWidth: '85%', px: 1.25, py: 0.75, bgcolor: 'action.hover', borderRadius: 2 }}>
                          <Typography variant="caption" color="text.secondary">{t('flows.assistance.aiHelper')}</Typography>
                          <Typography variant="body2">{turn.response}</Typography>
                        </Box>
                      )}
                    </Stack>
                  ))}
                  <TextField
                    autoFocus
                    fullWidth
                    multiline
                    minRows={2}
                    label={t('flows.assistance.talkLabel')}
                    placeholder={t('flows.assistance.talkPlaceholder')}
                    value={discussionDraft}
                    slotProps={{ htmlInput: { maxLength: 2_000 } }}
                    onChange={(event) => setDiscussionDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void discussToolSuggestions();
                      }
                    }}
                  />
                  <Stack direction="row" justifyContent="flex-end">
                    <Button
                      variant="contained"
                      startIcon={<AutoAwesomeRoundedIcon />}
                      disabled={!discussionDraft.trim()}
                      onClick={() => void discussToolSuggestions()}
                    >
                      {t('flows.assistance.reconsider')}
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )}
          </Stack>
        )}

        {stage === 'agents' && agentSuggestion && (
          <Stack spacing={1.5}>
            <Alert severity="info">
              {t('flows.assistance.agentApprovalHelp')}
            </Alert>
            {agentSuggestion.suggestions.length === 0 ? (
              <Alert severity="success">{t('flows.assistance.noAgent')}</Alert>
            ) : agentSuggestion.suggestions.map((item) => (
              <Paper key={item.flowId} variant="outlined" sx={{ p: 1.25 }}>
                <FormControlLabel
                  control={<Checkbox checked={selectedAgents.has(item.flowId)} onChange={(event) => {
                    setSelectedAgents((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.flowId); else next.delete(item.flowId);
                      return next;
                    });
                  }} />}
                  label={
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <AccountTreeOutlinedIcon color="primary" fontSize="small" />
                        <Typography fontWeight={800}>{item.flowName}</Typography>
                      </Stack>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{item.reason}</Typography>
                    </Box>
                  }
                />
              </Paper>
            ))}
          </Stack>
        )}

        {stage === 'plausibility' && plausibility && (
          <Stack spacing={1.5}>
            <Stack direction="row" gap={1} flexWrap="wrap">
              {plausibility.contexts.map((context) => <Chip key={`${context.kind}-${context.sourceId ?? ''}`} label={context.label} />)}
            </Stack>
            {plausibility.issues.length === 0 ? (
              <Alert severity="success">{t('flows.assistance.plausible')}</Alert>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  {t('flows.assistance.selectionHelp')}
                </Typography>
                {selectableIssueEntries.length > 1 && (
                  <FormControlLabel
                    sx={{ alignSelf: 'flex-start', ml: 0 }}
                    control={(
                      <Checkbox
                        checked={allSelectableIssuesSelected}
                        indeterminate={selectedIssueKeys.size > 0 && !allSelectableIssuesSelected}
                        onChange={(event) => {
                          setSelectedIssueKeys(event.target.checked
                            ? new Set(selectableIssueEntries.map((entry) => entry.key))
                            : new Set());
                        }}
                      />
                    )}
                    label={t('flows.assistance.selectAll')}
                  />
                )}
                {issueEntries.map((entry) => {
                  const { issue } = entry;
                  const reviewedFlow = plausibility.repairedFlows.find((candidate) => candidate.id === entry.flowId);
                  const message = `${reviewedFlow && reviewedFlow.id !== flow.id ? `${reviewedFlow.name}: ` : ''}${localizeFlowIssue(issue, t)}`;
                  return (
                    <Alert
                      key={entry.key}
                      severity={issue.severity}
                      action={(
                        <Checkbox
                          size="small"
                          checked={selectedIssueKeys.has(entry.key)}
                          disabled={!entry.selectable}
                          title={!entry.selectable ? t('flows.assistance.cannotFix') : undefined}
                          inputProps={{ 'aria-label': t('flows.assistance.selectIssue', { issue: message }) }}
                          onChange={(event) => {
                            setSelectedIssueKeys((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(entry.key); else next.delete(entry.key);
                              return next;
                            });
                          }}
                        />
                      )}
                      sx={{
                        '& .MuiAlert-action': { alignItems: 'center', py: 0 },
                      }}
                    >
                      {message}
                    </Alert>
                  );
                })}
              </>
            )}
            {selectedNeedsAi && !effectiveFixModelId && (
              models.length === 0 ? (
                <Alert severity="warning">{t('flows.assistance.needFixModel')}</Alert>
              ) : (
                <>
                  <Alert severity="info">{t('flows.assistance.chooseFixModel')}</Alert>
                  <FormControl fullWidth size="small">
                    <InputLabel id="assistance-fix-model-label">{t('flows.assistance.aiHelper')}</InputLabel>
                    <Select
                      labelId="assistance-fix-model-label"
                      label={t('flows.assistance.aiHelper')}
                      value={chosenModelId}
                      onChange={(event) => setChosenModelId(String(event.target.value))}
                    >
                      {models.map((model) => (
                        <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </>
              )
            )}
            {applicablePatchCount > 0 && (
              <Alert severity="info">
                {tp('flows.assistance.patch', applicablePatchCount)}
              </Alert>
            )}
            {plausibility.patches.length > applicablePatchCount && (
              <Alert severity="warning">
                {tp('flows.assistance.savedPatch', plausibility.patches.length - applicablePatchCount)}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={busy}>{t('flows.assistance.close')}</Button>
        {stage === 'improving' && (
          <Button
            variant="contained"
            disabled
            startIcon={<CircularProgress size={16} color="inherit" />}
          >
            {t('flows.inspector.improvingPrompt')}
          </Button>
        )}
        {stage === 'tools' && !suggestion && models.length > 0 && (
          <Button variant="contained" disabled={!chosenModelId} onClick={() => void suggestWithModel()}>
            {t('flows.assistance.suggest')}
          </Button>
        )}
        {stage === 'agents' && !agentSuggestion && models.length > 0 && (
          <Button variant="contained" disabled={!chosenModelId} onClick={() => void suggestAgentsWithModel()}>
            {t('flows.assistance.suggestAgents')}
          </Button>
        )}
        {stage === 'tools' && suggestion && suggestion.suggestions.length === 0 && (
          <Button startIcon={<AccountTreeOutlinedIcon />} onClick={() => void suggestAgents(workingFlow)}>{t('flows.assistance.continueAgents')}</Button>
        )}
        {stage === 'tools' && suggestion && (
          <Button
            startIcon={<ChatBubbleOutlineRoundedIcon />}
            aria-expanded={discussionOpen}
            onClick={() => setDiscussionOpen((current) => !current)}
          >
            {t('flows.assistance.talk')}
          </Button>
        )}
        {stage === 'tools' && suggestion && suggestion.suggestions.length > 0 && (
          <>
            <Button onClick={() => void suggestAgents(workingFlow)}>{t('flows.assistance.skip')}</Button>
            <Button variant="contained" startIcon={<BuildRoundedIcon />} disabled={chosen.length === 0} onClick={() => void applyTools()}>
              {tp('flows.assistance.connect', chosen.length)}
            </Button>
          </>
        )}
        {stage === 'agents' && agentSuggestion && agentSuggestion.suggestions.length === 0 && (
          <Button startIcon={<FactCheckRoundedIcon />} onClick={() => void improvePromptAndCheck(workingFlow)}>
            {t('flows.assistance.improveAndCheck')}
          </Button>
        )}
        {stage === 'agents' && agentSuggestion && agentSuggestion.suggestions.length > 0 && (
          <>
            <Button onClick={() => void improvePromptAndCheck(workingFlow)}>{t('flows.assistance.skipAgents')}</Button>
            <Button
              variant="contained"
              startIcon={<AccountTreeOutlinedIcon />}
              disabled={chosenAgents.length === 0}
              onClick={() => void applyAgents()}
            >
              {tp('flows.assistance.connectAgents', chosenAgents.length)}
            </Button>
          </>
        )}
        {stage === 'plausibility' && plausibility && selectableIssueEntries.length > 0 ? (
          <Button
            variant="contained"
            startIcon={<AutoFixHighRoundedIcon />}
            disabled={chosenIssueEntries.length === 0 || (selectedNeedsAi && !effectiveFixModelId)}
            onClick={() => void fixSelectedIssues()}
          >
            {tp('flows.assistance.fix', chosenIssueEntries.length)}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

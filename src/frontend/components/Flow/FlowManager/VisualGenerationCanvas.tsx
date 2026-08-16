'use client';

import React from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, keyframes } from '@mui/material/styles';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import SchemaRoundedIcon from '@mui/icons-material/SchemaRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import type { Flow } from '@/shared/types/flow';
import type {
  VisualGenerationAgent,
  VisualGenerationDecision,
  VisualGenerationEvent,
  VisualGenerationStep,
} from '@/shared/types/flow/visualGeneration';
import { useI18n } from '@/frontend/contexts/I18nContext';
import FlowPreview from './FlowBuilder/FlowPreview';

export interface VisualGenerationUiState {
  started: boolean;
  sessionId: string | null;
  maxDepth: number;
  agents: Record<string, VisualGenerationAgent>;
  agentOrder: string[];
  focusedAgentId: string | null;
  suggestions: Record<string, {
    tools: Array<{ server: string; tool: string; reason: string }>;
    agents: Array<{ flowId: string; flowName: string; reason: string }>;
  }>;
  decisions: VisualGenerationDecision[];
  activities: string[];
  routes: Record<string, Array<{ from: string; to: string }>>;
  previews: Record<string, { flow: Flow; revision: number }>;
}

export const initialVisualGenerationState: VisualGenerationUiState = {
  started: false,
  sessionId: null,
  maxDepth: 8,
  agents: {},
  agentOrder: [],
  focusedAgentId: null,
  suggestions: {},
  decisions: [],
  activities: [],
  routes: {},
  previews: {},
};

function stepKey(agentId: string, stepId: string) {
  return `${agentId}\u0000${stepId}`;
}

function updateAgentStep(
  state: VisualGenerationUiState,
  agentId: string,
  step: VisualGenerationStep,
): VisualGenerationUiState {
  const agent = state.agents[agentId];
  if (!agent) return state;
  const existing = agent.steps.findIndex((candidate) => candidate.id === step.id);
  const steps = existing >= 0
    ? agent.steps.map((candidate, index) => index === existing ? step : candidate)
    : [...agent.steps, step];
  return {
    ...state,
    agents: { ...state.agents, [agentId]: { ...agent, steps } },
  };
}

export function visualGenerationReducer(
  state: VisualGenerationUiState,
  event: VisualGenerationEvent | { type: 'reset' } | { type: 'focus'; agentId: string },
): VisualGenerationUiState {
  if (event.type === 'reset') return initialVisualGenerationState;
  if (event.type === 'focus') return { ...state, focusedAgentId: event.agentId };
  if (event.type === 'session-started') {
    return {
      ...initialVisualGenerationState,
      started: true,
      sessionId: event.sessionId,
      maxDepth: event.maxDepth,
      activities: [event.message],
    };
  }
  if (event.type === 'activity') {
    return { ...state, activities: [...state.activities.slice(-15), event.message] };
  }
  if (event.type === 'agent-created') {
    return {
      ...state,
      agents: { ...state.agents, [event.agent.id]: event.agent },
      agentOrder: state.agentOrder.includes(event.agent.id)
        ? state.agentOrder
        : [...state.agentOrder, event.agent.id],
      focusedAgentId: event.agent.id,
    };
  }
  if (event.type === 'agent-focused') return { ...state, focusedAgentId: event.agentId };
  if (event.type === 'step-added' || event.type === 'step-updated') {
    return updateAgentStep({ ...state, focusedAgentId: event.agentId }, event.agentId, event.step);
  }
  if (event.type === 'routes-updated') {
    return {
      ...state,
      routes: { ...state.routes, [event.agentId]: event.routes },
    };
  }
  if (event.type === 'flow-preview') {
    return {
      ...state,
      previews: {
        ...state.previews,
        [event.agentId]: { flow: event.flow, revision: event.revision },
      },
    };
  }
  if (event.type === 'suggestions') {
    return {
      ...state,
      suggestions: {
        ...state.suggestions,
        [stepKey(event.agentId, event.stepId)]: { tools: event.tools, agents: event.agents },
      },
    };
  }
  if (event.type === 'suggestion-decision') {
    return { ...state, decisions: [...state.decisions, event.decision] };
  }
  if (event.type === 'agent-status') {
    const agent = state.agents[event.agentId];
    if (!agent) return state;
    return {
      ...state,
      agents: { ...state.agents, [agent.id]: { ...agent, status: event.status } },
    };
  }
  if (event.type === 'marketplace-results') {
    return { ...state, activities: [...state.activities.slice(-15), `Marketplace search “${event.query}” found ${event.count} result(s).`] };
  }
  if (event.type === 'connector-installed') {
    return { ...state, activities: [...state.activities.slice(-15), `Connected ${event.name} with ${event.tools.length} tool(s).`] };
  }
  if (event.type === 'complete') {
    const revision = Math.max(0, ...Object.values(state.previews).map((preview) => preview.revision)) + 1;
    const completedPreviews = Object.fromEntries(
      event.result.flows.map((flow) => [flow.id, { flow, revision }]),
    );
    return { ...state, activities: [], previews: { ...state.previews, ...completedPreviews } };
  }
  if (event.type === 'error') {
    return { ...state, activities: [event.error] };
  }
  return state;
}

const breathe = keyframes`
  0%, 100% { transform: scale(1); opacity: .72; }
  50% { transform: scale(1.06); opacity: 1; }
`;

function statusColor(status: VisualGenerationAgent['status']) {
  if (status === 'ready') return 'success' as const;
  if (status === 'needs-attention') return 'warning' as const;
  if (status === 'checking') return 'info' as const;
  return 'primary' as const;
}

function formatTaskPreview(task: string) {
  return task.replace(/\$\{tool:([^}_]+)__([^}]+)\}/g, (_match, server: string, tool: string) => `${server} / ${tool}`);
}

const STATUS_LABEL_KEYS: Record<VisualGenerationAgent['status'],
  | 'flows.generator.visualStatus.building'
  | 'flows.generator.visualStatus.checking'
  | 'flows.generator.visualStatus.ready'
  | 'flows.generator.visualStatus.needs-attention'> = {
  building: 'flows.generator.visualStatus.building',
  checking: 'flows.generator.visualStatus.checking',
  ready: 'flows.generator.visualStatus.ready',
  'needs-attention': 'flows.generator.visualStatus.needs-attention',
};

function DecisionChip({ decision }: { decision: VisualGenerationDecision }) {
  const { t } = useI18n();
  const accepted = decision.decision === 'accepted';
  return (
    <Chip
      size="small"
      color={accepted ? 'success' : 'default'}
      variant={accepted ? 'filled' : 'outlined'}
      icon={accepted ? <CheckCircleRoundedIcon /> : <CloseRoundedIcon />}
      label={t(accepted ? 'flows.generator.visualUsing' : 'flows.generator.visualSkipped', { name: decision.label })}
      title={decision.reason}
      sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
    />
  );
}

function AgentTree({
  state,
  onSelect,
}: {
  state: VisualGenerationUiState;
  onSelect: (agentId: string) => void;
}) {
  const { t, tp } = useI18n();
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 0.5 }}>
        <AccountTreeRoundedIcon color="primary" fontSize="small" />
        <Typography variant="subtitle2" fontWeight={850}>{t('flows.generator.visualTree')}</Typography>
        <Chip size="small" label={`${state.agentOrder.length}`} />
      </Stack>
      {state.agentOrder.map((agentId) => {
        const agent = state.agents[agentId];
        if (!agent) return null;
        const selected = state.focusedAgentId === agent.id;
        return (
          <Paper
            component="button"
            type="button"
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            elevation={0}
            sx={{
              appearance: 'none',
              width: `calc(100% - ${Math.min(agent.depth, 5) * 10}px)`,
              ml: `${Math.min(agent.depth, 5) * 10}px !important`,
              p: 1,
              textAlign: 'left',
              color: 'text.primary',
              cursor: 'pointer',
              border: 1,
              borderColor: selected ? 'primary.main' : 'divider',
              borderRadius: 2.5,
              bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.11) : 'background.paper',
              transition: 'all 180ms ease',
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <SmartToyRoundedIcon color={selected ? 'primary' : 'action'} fontSize="small" />
              <Box minWidth={0} flex={1}>
                <Typography variant="body2" fontWeight={800} noWrap>{agent.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {tp('flows.card.step', agent.steps.length)} · {t('flows.generator.visualLevel', { count: agent.depth })}
                </Typography>
              </Box>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: `${statusColor(agent.status)}.main` }} />
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

function ExpertPreviewPanel({
  preview,
  agentName,
}: {
  preview?: { flow: Flow; revision: number };
  agentName: string;
}) {
  const { t } = useI18n();
  return (
    <Box
      data-testid="visual-expert-preview"
      sx={{
        minWidth: 0,
        minHeight: { xs: 360, lg: 0 },
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: { lg: 1 },
        borderTop: { xs: 1, lg: 0 },
        borderColor: 'divider',
        bgcolor: (theme) => alpha(theme.palette.background.default, 0.55),
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
        <SchemaRoundedIcon color="primary" fontSize="small" />
        <Box minWidth={0} flex={1}>
          <Typography variant="subtitle2" fontWeight={850}>{t('flows.generator.visualExpertPreview')}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>{agentName}</Typography>
        </Box>
        <Chip size="small" variant="outlined" color="primary" label={t('flows.builder.relayout')} />
      </Stack>
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {preview ? (
          <FlowPreview
            key={preview.flow.id}
            flow={preview.flow}
            relayoutTopToBottom
            fitViewOnChange
          />
        ) : (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 4, textAlign: 'center' }}>
            <Stack spacing={1.5} alignItems="center">
              <Box sx={{ position: 'relative', display: 'grid', placeItems: 'center', width: 64, height: 64 }}>
                <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', bgcolor: 'primary.main', opacity: 0.1, animation: `${breathe} 1.5s ease-in-out infinite` }} />
                <SchemaRoundedIcon color="primary" sx={{ fontSize: 32 }} />
              </Box>
              <Typography variant="body2" fontWeight={750}>{t('flows.generator.visualPreviewWaiting')}</Typography>
              <Typography variant="caption" color="text.secondary">{t('flows.generator.visualPreviewHelp')}</Typography>
            </Stack>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default function VisualGenerationCanvas({
  state,
  working,
  onSelectAgent,
}: {
  state: VisualGenerationUiState;
  working: boolean;
  onSelectAgent: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const agent = state.focusedAgentId ? state.agents[state.focusedAgentId] : undefined;
  if (!agent) {
    return (
      <Box sx={{ minHeight: 360, display: 'grid', placeItems: 'center', textAlign: 'center', p: 4 }}>
        <Stack alignItems="center" spacing={2}>
          <Box sx={{ position: 'relative', display: 'grid', placeItems: 'center', width: 88, height: 88 }}>
            <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', bgcolor: 'primary.main', opacity: 0.12, animation: `${breathe} 1.5s ease-in-out infinite` }} />
            <AutoAwesomeRoundedIcon color="primary" sx={{ fontSize: 42 }} />
          </Box>
          <Typography variant="h6">{t('flows.generator.visualDesigning')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('flows.generator.visualFirstAgent')}
          </Typography>
          {working && <CircularProgress size={24} />}
        </Stack>
      </Box>
    );
  }
  const preview = state.previews[agent.id];

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: '210px minmax(0, 1fr)',
          lg: '210px minmax(380px, 1.08fr) minmax(340px, 0.92fr)',
        },
        minHeight: 460,
        height: { lg: '58vh' },
        maxHeight: { lg: '58vh' },
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        overflowX: 'hidden',
      }}
    >
      <Box sx={{ minWidth: 0, p: 1.5, borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: 'divider', overflowY: 'auto' }}>
        <AgentTree state={state} onSelect={onSelectAgent} />
      </Box>
      <Box sx={{ minWidth: 0, p: { xs: 1.5, sm: 2.5 }, overflowY: 'auto' }}>
        <Stack spacing={2}>
          <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: (theme) => alpha(theme.palette.primary.main, 0.045) }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              <Box flex={1} minWidth={0}>
                <Typography variant="overline" color="primary.main">{t('flows.generator.visualLevelAgent', { count: agent.depth })}</Typography>
                <Typography variant="h5" fontWeight={850}>{agent.name}</Typography>
                <Typography variant="body2" color="text.secondary">{agent.goal}</Typography>
              </Box>
              <Chip color={statusColor(agent.status)} label={t(STATUS_LABEL_KEYS[agent.status])} />
            </Stack>
          </Paper>

          <Box sx={{ px: 1.5, py: 1, borderRadius: 2.5, border: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={850} color="primary.main" sx={{ textTransform: 'uppercase' }}>{t('flows.guided.when')}</Typography>
            <Typography variant="body2" fontWeight={700}>{t('flows.guided.someoneAsks')}</Typography>
          </Box>

          {agent.steps.map((step, index) => {
            const suggestions = state.suggestions[stepKey(agent.id, step.id)];
            const decisions = state.decisions.filter((decision) => decision.agentId === agent.id && decision.stepId === step.id);
            const waitingForDecision = !!suggestions && decisions.length < suggestions.tools.length + suggestions.agents.length;
            const childAgents = step.connectedAgentIds.map((id) => state.agents[id]).filter(Boolean);
            return (
              <React.Fragment key={step.id}>
                <ArrowDownwardRoundedIcon sx={{ alignSelf: 'center', color: 'text.disabled' }} />
                <Paper
                  elevation={0}
                  sx={{
                    p: 1.75,
                    border: 1,
                    borderColor: waitingForDecision ? 'info.main' : 'divider',
                    borderRadius: 3,
                    animation: waitingForDecision ? `${breathe} 1.8s ease-in-out infinite` : undefined,
                  }}
                >
                  <Stack spacing={1.25}>
                    <Stack direction="row" spacing={1.25} alignItems="flex-start">
                      <Box sx={{ display: 'grid', placeItems: 'center', width: 32, height: 32, flexShrink: 0, borderRadius: 2, bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 850 }}>
                        {index + 1}
                      </Box>
                      <Box minWidth={0} flex={1}>
                        <Typography variant="subtitle1" fontWeight={850}>{step.label}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>{formatTaskPreview(step.task)}</Typography>
                      </Box>
                      {waitingForDecision && <CircularProgress size={18} />}
                    </Stack>

                    {(suggestions || decisions.length > 0 || childAgents.length > 0) && <Divider />}
                    {suggestions && suggestions.tools.length + suggestions.agents.length > 0 && (
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <AutoAwesomeRoundedIcon color="info" fontSize="small" />
                        <Typography variant="caption" fontWeight={800}>{t('flows.generator.visualSuggestionsReviewed')}</Typography>
                      </Stack>
                    )}
                    {decisions.length > 0 && (
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        {decisions.map((decision) => <DecisionChip key={decision.id} decision={decision} />)}
                      </Stack>
                    )}
                    {childAgents.length > 0 && (
                      <Stack spacing={0.75}>
                        <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ textTransform: 'uppercase' }}>{t('flows.generator.visualNewHelpers')}</Typography>
                        {childAgents.map((child) => (
                          <Chip
                            key={child.id}
                            icon={<HubRoundedIcon />}
                            color="primary"
                            variant="outlined"
                            label={`${child.name} · ${t('flows.generator.visualLevel', { count: child.depth })}`}
                            onClick={() => onSelectAgent(child.id)}
                          />
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              </React.Fragment>
            );
          })}

          {agent.steps.length === 0 && (
            <Paper elevation={0} sx={{ p: 3, border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 3, textAlign: 'center' }}>
              <CircularProgress size={22} sx={{ mb: 1 }} />
              <Typography variant="body2" color="text.secondary">{t('flows.generator.visualChoosingStep')}</Typography>
            </Paper>
          )}

          <ArrowDownwardRoundedIcon sx={{ alignSelf: 'center', color: 'text.disabled' }} />
          <Box sx={{ px: 1.5, py: 1, borderRadius: 2.5, border: 1, borderColor: 'divider', bgcolor: (theme) => alpha(theme.palette.success.main, 0.055) }}>
            <Typography variant="caption" fontWeight={850} color="success.main" sx={{ textTransform: 'uppercase' }}>{t('flows.guided.then')}</Typography>
            <Typography variant="body2" fontWeight={700}>{t('flows.guided.sendAnswer')}</Typography>
          </Box>

          {state.activities.length > 0 && (
            <Paper elevation={0} sx={{ p: 1.5, borderRadius: 3, bgcolor: 'action.hover' }}>
              <Stack direction="row" spacing={1} alignItems="center">
                {working ? <CircularProgress size={16} /> : <CheckCircleRoundedIcon color="success" fontSize="small" />}
                <Typography variant="caption" color="text.secondary">
                  {state.activities[state.activities.length - 1]}
                </Typography>
              </Stack>
            </Paper>
          )}
        </Stack>
      </Box>
      <Box sx={{ gridColumn: { xs: '1', md: '1 / -1', lg: 'auto' }, minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' }}>
        <ExpertPreviewPanel preview={preview} agentName={agent.name} />
      </Box>
    </Box>
  );
}

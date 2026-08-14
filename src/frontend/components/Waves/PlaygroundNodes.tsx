'use client';

import React, { memo } from 'react';
import {
  Box,
  Chip,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import SubdirectoryArrowRightRoundedIcon from '@mui/icons-material/SubdirectoryArrowRightRounded';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { matchCronPreset } from '@/frontend/components/PlannedExecutions/triggerSummary';
import type { Translator } from '@/frontend/i18n/core';
import type { AutomationMapExecution } from '@/shared/types/waves/automationMap';
import type {
  PlaygroundFlowFrameData,
  PlaygroundPackageData,
  PlaygroundRelationAnchorData,
  PlaygroundSimpleFlowData,
  PlaygroundTriggerData,
} from './playgroundGraph';

const PACKAGE_TONES = ['#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b', '#ec4899', '#6366f1'];

function describeMapTrigger(execution: AutomationMapExecution, t: Translator): string {
  const trigger = execution.trigger;
  switch (trigger.type) {
    case 'schedule':
      return matchCronPreset(trigger.cron, t) ?? t('automations.trigger.schedule', { cron: trigger.cron });
    case 'webhook':
      return t('automations.trigger.webhook');
    case 'file-watch':
      return t('waves.kind.fileWatch');
    case 'mcp-poll':
      return t('automations.trigger.watchingTool', { server: trigger.serverName, tool: trigger.toolName });
    case 'url-watch':
      return t('waves.kind.urlWatch');
    case 'flow-event':
      if (trigger.source.topic) return t('automations.trigger.onSignal', { topic: trigger.source.topic });
      return t('automations.trigger.flowOutcome', {
        outcomes: (trigger.on ?? ['completed']).map((outcome) => (
          t(outcome === 'error' ? 'automations.trigger.outcome.error' : 'automations.trigger.outcome.completed')
        )).join('/'),
      });
  }
}

export interface PlaygroundNodeActions {
  onExecutionClick?: (executionId: string, waveIds: string[]) => void;
  activeWaveId?: string | null;
}

function PlaygroundPackageNodeComponent({ data }: NodeProps) {
  const theme = useTheme();
  const node = data as unknown as PlaygroundPackageData;
  const accent = PACKAGE_TONES[node.tone % PACKAGE_TONES.length];
  return (
    <Box
      data-testid="playground-package"
      sx={{
        width: node.width,
        height: node.height,
        boxSizing: 'border-box',
        borderRadius: 5,
        border: '1px solid',
        borderColor: alpha(accent, node.dimmed ? 0.08 : 0.26),
        bgcolor: alpha(theme.palette.background.paper, node.dimmed ? 0.24 : 0.48),
        backgroundImage: `linear-gradient(145deg, ${alpha(accent, node.dimmed ? 0.015 : 0.07)}, transparent 44%)`,
        boxShadow: node.dimmed ? 'none' : `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.07)}`,
        backdropFilter: 'blur(8px)',
        opacity: node.dimmed ? 0.42 : 1,
        transition: 'opacity 220ms ease, border-color 220ms ease',
        pointerEvents: 'none',
      }}
    >
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2.25, pt: 1.6 }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: 2,
            display: 'grid',
            placeItems: 'center',
            bgcolor: alpha(accent, 0.14),
            color: accent,
          }}
        >
          <Inventory2OutlinedIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 800, letterSpacing: '-0.01em' }}>
            {node.label}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {node.subtitle}
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}

function PlaygroundFlowFrameNodeComponent({ data }: NodeProps) {
  const theme = useTheme();
  const node = data as unknown as PlaygroundFlowFrameData;
  return (
    <Box
      data-testid={`playground-flow-frame-${node.flowId}`}
      sx={{
        width: node.width,
        height: node.height,
        boxSizing: 'border-box',
        borderRadius: 4,
        border: '1px solid',
        borderColor: alpha(theme.palette.primary.main, node.dimmed ? 0.07 : 0.2),
        bgcolor: alpha(theme.palette.background.default, node.dimmed ? 0.18 : 0.54),
        boxShadow: node.dimmed ? 'none' : `0 12px 36px ${alpha(theme.palette.common.black, 0.08)}`,
        opacity: node.dimmed ? 0.35 : 1,
        transition: 'opacity 220ms ease, border-color 220ms ease',
        pointerEvents: 'none',
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ px: 1.8, pt: 1.35 }}>
        <AccountTreeRoundedIcon color="primary" sx={{ fontSize: 18 }} />
        <Typography variant="subtitle2" noWrap sx={{ fontWeight: 750 }}>
          {node.label}
        </Typography>
        {node.subtitle && (
          <Typography variant="caption" noWrap color="text.secondary" sx={{ minWidth: 0 }}>
            · {node.subtitle}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function PlaygroundSimpleFlowNodeComponent({ data }: NodeProps) {
  const theme = useTheme();
  const { t, tp } = useI18n();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const node = data as unknown as PlaygroundSimpleFlowData & PlaygroundNodeActions;
  const steps = node.stepLabels.slice(0, 3);
  const remainingSteps = Math.max(0, node.stepLabels.length - steps.length);
  const signals = node.signalTopics.slice(0, 2);
  const remainingSignals = node.signalTopics.slice(signals.length);
  const visibleExecutions = node.executions.slice(0, 2);
  const remainingExecutions = node.executions.slice(visibleExecutions.length);
  const triggerChipMaxWidth = node.executions.length > 2
    ? 92
    : node.executions.length === 2
      ? 124
      : 210;

  return (
    <>
      <Handle
        id="relation-in-left"
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ width: 9, height: 9, border: 0, background: theme.palette.primary.light, opacity: node.dimmed ? 0.2 : 0.7 }}
      />
      <Handle id="relation-in-right" type="target" position={Position.Right} isConnectable={false} style={{ opacity: 0 }} />
      <Handle id="relation-in-top" type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0 }} />
      <Handle id="relation-in-bottom" type="target" position={Position.Bottom} isConnectable={false} style={{ opacity: 0 }} />
      <Box
        data-testid={`playground-simple-flow-${node.flowId}`}
        sx={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          p: 1.7,
          borderRadius: 4,
          border: '1px solid',
          borderColor: node.highlighted
            ? alpha(theme.palette.primary.main, 0.78)
            : alpha(theme.palette.divider, 0.9),
          bgcolor: alpha(theme.palette.background.paper, 0.94),
          boxShadow: node.highlighted
            ? `0 14px 36px ${alpha(theme.palette.primary.main, 0.2)}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.14)}`
            : `0 8px 26px ${alpha(theme.palette.common.black, 0.12)}`,
          backdropFilter: 'blur(10px)',
          opacity: node.dimmed ? 0.2 : 1,
          transition: reducedMotion ? 'none' : 'opacity 220ms ease, transform 180ms ease, box-shadow 220ms ease',
          animation: node.highlighted && !reducedMotion ? 'waveFlowGlow 2.8s ease-in-out infinite' : 'none',
          '@keyframes waveFlowGlow': {
            '0%, 100%': { transform: 'translateY(0)' },
            '50%': { transform: 'translateY(-2px)' },
          },
          '&:hover': node.dimmed || reducedMotion ? undefined : { transform: 'translateY(-2px)' },
        }}
      >
        <Stack spacing={1.05} sx={{ height: '100%' }}>
          <Stack direction="row" alignItems="flex-start" spacing={1}>
            <Box
              sx={{
                width: 32,
                height: 32,
                flex: '0 0 auto',
                borderRadius: 2.1,
                display: 'grid',
                placeItems: 'center',
                color: theme.palette.primary.main,
                bgcolor: alpha(theme.palette.primary.main, 0.1),
              }}
            >
              <AccountTreeRoundedIcon sx={{ fontSize: 19 }} />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="subtitle1" noWrap title={node.name} sx={{ fontWeight: 800, lineHeight: 1.2 }}>
                {node.name}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {node.description || (node.packageNames.length > 0 ? node.packageNames.join(' · ') : t('waves.workspaceLabel'))}
              </Typography>
            </Box>
          </Stack>

          <Stack direction="row" spacing={0.55} alignItems="center" sx={{ minHeight: 24, overflow: 'hidden' }}>
            <Typography variant="overline" sx={{ lineHeight: 1, fontSize: '0.59rem', fontWeight: 800, opacity: 0.54 }}>
              {t('flows.guided.when').toLocaleUpperCase()}
            </Typography>
            {node.executions.length === 0 ? (
              <Chip size="small" variant="outlined" label={t('waves.usedManually')} sx={{ height: 22, fontSize: '0.67rem' }} />
            ) : (
              visibleExecutions.map((execution) => {
                const active = Boolean(node.activeWaveId && execution.waveIds.includes(node.activeWaveId));
                return (
                  <Tooltip
                    key={execution.executionId}
                    title={`${execution.name} · ${describeMapTrigger(execution, t)}`}
                    arrow
                  >
                    <Box component="span" className="nodrag nopan" sx={{ display: 'inline-flex', minWidth: 0, maxWidth: triggerChipMaxWidth }}>
                      <Chip
                        component="button"
                        clickable
                        size="small"
                        icon={<PlayArrowRoundedIcon />}
                        color={active ? 'primary' : 'default'}
                        variant={active ? 'filled' : 'outlined'}
                        disabled={!execution.enabled}
                        label={describeMapTrigger(execution, t)}
                        onClick={(event) => {
                          event.stopPropagation();
                          node.onExecutionClick?.(execution.executionId, execution.waveIds);
                        }}
                        sx={{ maxWidth: triggerChipMaxWidth, height: 22, fontSize: '0.67rem', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                      />
                    </Box>
                  </Tooltip>
                );
              })
            )}
            {remainingExecutions.length > 0 && (
              <Tooltip
                title={remainingExecutions.map((execution) => (
                  `${execution.name} · ${describeMapTrigger(execution, t)}`
                )).join('\n')}
                arrow
              >
                <Chip
                  size="small"
                  variant="outlined"
                  label={`+${remainingExecutions.length}`}
                  sx={{ flex: '0 0 auto', height: 22, minWidth: 34, fontSize: '0.67rem' }}
                />
              </Tooltip>
            )}
          </Stack>

          <Stack direction="row" spacing={0.6} alignItems="center" sx={{ minHeight: 30, overflow: 'hidden' }}>
            {steps.length === 0 ? (
              <Typography variant="caption" color="text.secondary">{t('waves.flowCompletes')}</Typography>
            ) : (
              steps.map((label, index) => (
                <React.Fragment key={`${label}:${index}`}>
                  {index > 0 && <Typography variant="caption" color="text.disabled">→</Typography>}
                  <Box
                    sx={{
                      minWidth: 0,
                      maxWidth: 94,
                      px: 0.85,
                      py: 0.5,
                      borderRadius: 1.6,
                      bgcolor: alpha(theme.palette.text.primary, 0.055),
                      border: '1px solid',
                      borderColor: alpha(theme.palette.divider, 0.75),
                    }}
                  >
                    <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 650 }}>
                      {label}
                    </Typography>
                  </Box>
                </React.Fragment>
              ))
            )}
            {remainingSteps > 0 && (
              <Typography variant="caption" color="text.secondary">+{remainingSteps}</Typography>
            )}
          </Stack>

          <Stack direction="row" spacing={0.55} alignItems="center" sx={{ mt: 'auto !important', minHeight: 23 }}>
            <Typography variant="overline" sx={{ lineHeight: 1, fontSize: '0.59rem', fontWeight: 800, opacity: 0.54 }}>
              {t('flows.guided.then').toLocaleUpperCase()}
            </Typography>
            {signals.map((topic) => (
              <Tooltip key={topic} title={topic} arrow>
                <Chip
                  size="small"
                  icon={<BoltRoundedIcon />}
                  label={topic}
                  sx={{
                    height: 22,
                    maxWidth: remainingSignals.length > 0 || node.subflowCount > 0 ? 72 : 112,
                    fontSize: '0.66rem',
                    color: '#7c3aed',
                    bgcolor: alpha('#8b5cf6', 0.09),
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                  }}
                />
              </Tooltip>
            ))}
            {remainingSignals.length > 0 && (
              <Tooltip title={remainingSignals.join('\n')} arrow>
                <Chip
                  size="small"
                  label={`+${remainingSignals.length}`}
                  sx={{ flex: '0 0 auto', height: 22, minWidth: 34, fontSize: '0.66rem', color: '#7c3aed' }}
                />
              </Tooltip>
            )}
            {node.subflowCount > 0 && (
              <Chip
                size="small"
                icon={<SubdirectoryArrowRightRoundedIcon />}
                label={tp('waves.subflowCount', node.subflowCount)}
                sx={{ height: 22, fontSize: '0.66rem', color: '#0e7490', bgcolor: alpha('#06b6d4', 0.09) }}
              />
            )}
            {signals.length === 0 && node.subflowCount === 0 && (
              <Typography variant="caption" color="text.secondary">{t('waves.flowCompletes')}</Typography>
            )}
          </Stack>
        </Stack>
      </Box>
      <Handle
        id="relation-out-right"
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ width: 9, height: 9, border: 0, background: '#8b5cf6', opacity: node.dimmed ? 0.2 : 0.76 }}
      />
      <Handle id="relation-out-left" type="source" position={Position.Left} isConnectable={false} style={{ opacity: 0 }} />
      <Handle id="relation-out-top" type="source" position={Position.Top} isConnectable={false} style={{ opacity: 0 }} />
      <Handle id="relation-out-bottom" type="source" position={Position.Bottom} isConnectable={false} style={{ opacity: 0 }} />
    </>
  );
}

function PlaygroundTriggerNodeComponent({ data }: NodeProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const node = data as unknown as PlaygroundTriggerData & PlaygroundNodeActions;
  const active = Boolean(node.activeWaveId && node.execution.waveIds.includes(node.activeWaveId));
  return (
    <>
      <Handle
        id="relation-in"
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ opacity: 0 }}
      />
      <Box
        className="nodrag nopan"
        component="button"
        type="button"
        onClick={() => node.onExecutionClick?.(node.execution.executionId, node.execution.waveIds)}
        sx={{
          width: '100%',
          height: '100%',
          borderRadius: 2.5,
          border: '1px solid',
          borderColor: active ? theme.palette.primary.main : alpha(theme.palette.primary.main, 0.3),
          bgcolor: alpha(theme.palette.background.paper, 0.96),
          color: 'text.primary',
          px: 1.25,
          py: 0.9,
          textAlign: 'left',
          cursor: 'pointer',
          opacity: node.dimmed ? 0.22 : 1,
          boxShadow: active ? `0 8px 22px ${alpha(theme.palette.primary.main, 0.2)}` : 'none',
        }}
      >
        <Typography variant="overline" sx={{ display: 'block', lineHeight: 1.15, fontSize: '0.58rem', opacity: 0.58 }}>
          {t('waves.triggerLabel').toLocaleUpperCase()}
        </Typography>
        <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 800 }}>
          {node.execution.name}
        </Typography>
        <Typography variant="caption" noWrap color="text.secondary" sx={{ display: 'block', fontSize: '0.65rem' }}>
          {describeMapTrigger(node.execution, t)}
        </Typography>
      </Box>
      <Handle
        id="trigger-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0.72, background: theme.palette.primary.main, border: 0 }}
      />
    </>
  );
}

function PlaygroundRelationAnchorNodeComponent({ data }: NodeProps) {
  const node = data as unknown as PlaygroundRelationAnchorData;
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={node.targetPosition}
        isConnectable={false}
        style={{ width: 2, height: 2, minWidth: 0, minHeight: 0, border: 0, opacity: 0 }}
      />
      <Handle
        id="out"
        type="source"
        position={node.sourcePosition}
        isConnectable={false}
        style={{ width: 2, height: 2, minWidth: 0, minHeight: 0, border: 0, opacity: 0 }}
      />
    </>
  );
}

export const PlaygroundPackageNode = memo(PlaygroundPackageNodeComponent);
export const PlaygroundFlowFrameNode = memo(PlaygroundFlowFrameNodeComponent);
export const PlaygroundSimpleFlowNode = memo(PlaygroundSimpleFlowNodeComponent);
export const PlaygroundTriggerNode = memo(PlaygroundTriggerNodeComponent);
export const PlaygroundRelationAnchorNode = memo(PlaygroundRelationAnchorNodeComponent);

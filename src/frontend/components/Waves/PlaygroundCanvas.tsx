'use client';

import React, { useCallback, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Box,
  Chip,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import type { AutomationMapResponse } from '@/shared/types/waves/automationMap';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { nodeTypes as flowBuilderNodeTypes, edgeTypes as flowBuilderEdgeTypes } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/Canvas';
import { FlowNamesContext } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes/flowNamesContext';
import {
  PlaygroundFlowFrameNode,
  PlaygroundPackageNode,
  PlaygroundRelationAnchorNode,
  PlaygroundSimpleFlowNode,
  PlaygroundTriggerNode,
} from './PlaygroundNodes';
import {
  buildExpertPlaygroundGraph,
  buildSimplePlaygroundGraph,
  type PlaygroundMode,
} from './playgroundGraph';

const playgroundNodeTypes = {
  ...flowBuilderNodeTypes,
  playgroundPackage: PlaygroundPackageNode,
  playgroundFlowFrame: PlaygroundFlowFrameNode,
  playgroundSimpleFlow: PlaygroundSimpleFlowNode,
  playgroundTrigger: PlaygroundTriggerNode,
  playgroundRelationAnchor: PlaygroundRelationAnchorNode,
};

// Older persisted flows may still use the historical `flowEdge` key. The
// builder's canonical renderer is the same custom edge, so keep the alias on
// this read-only aggregate canvas instead of falling back with a React Flow warning.
const playgroundEdgeTypes = {
  ...flowBuilderEdgeTypes,
  flowEdge: flowBuilderEdgeTypes.custom,
};

interface PlaygroundCanvasProps {
  data: AutomationMapResponse;
  mode: PlaygroundMode;
  activeWaveId: string | null;
  onActiveWaveChange: (waveId: string | null) => void;
  visiblePackageNames?: ReadonlySet<string>;
}

function PlaygroundCanvasInner({
  data,
  mode,
  activeWaveId,
  onActiveWaveChange,
  visiblePackageNames,
}: PlaygroundCanvasProps) {
  const theme = useTheme();
  const { t, tp } = useI18n();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const instanceRef = useRef<ReactFlowInstance | null>(null);
  const largeMap = data.flows.length > 24;

  const graph = useMemo(
    () => mode === 'simple'
      ? buildSimplePlaygroundGraph(data, activeWaveId, visiblePackageNames, {
          workspaceLabel: t('waves.workspaceLabel'),
          workspaceDescription: t('waves.workspaceDescription'),
          sharedContentLabel: t('waves.sharedContent'),
          flowCount: (count) => tp('waves.flowCount', count),
          relationThen: t('waves.relationThen'),
          relationOnError: t('waves.relationOnError'),
          relationCompletedOrError: t('waves.relationCompletedOrError'),
          relationSubflow: t('waves.legendSubflow'),
          relationParallelSubflow: t('waves.relationParallelSubflow'),
        })
      : buildExpertPlaygroundGraph(data, activeWaveId, visiblePackageNames, {
          workspaceLabel: t('waves.workspaceLabel'),
          workspaceDescription: t('waves.workspaceDescription'),
          sharedContentLabel: t('waves.sharedContent'),
          flowCount: (count) => tp('waves.flowCount', count),
          relationThen: t('waves.relationThen'),
          relationOnError: t('waves.relationOnError'),
          relationCompletedOrError: t('waves.relationCompletedOrError'),
          relationSubflow: t('waves.legendSubflow'),
          relationParallelSubflow: t('waves.relationParallelSubflow'),
        }),
    [activeWaveId, data, mode, t, tp, visiblePackageNames],
  );

  const handleExecutionClick = useCallback((_: string, waveIds: string[]) => {
    const next = waveIds[0] ?? null;
    onActiveWaveChange(next === activeWaveId ? null : next);
  }, [activeWaveId, onActiveWaveChange]);

  const nodes = useMemo(
    () => graph.nodes.map((node) => {
      if (node.type !== 'playgroundSimpleFlow' && node.type !== 'playgroundTrigger') return node;
      return {
        ...node,
        data: {
          ...node.data,
          activeWaveId,
          onExecutionClick: handleExecutionClick,
        },
      };
    }),
    [activeWaveId, graph.nodes, handleExecutionClick],
  );

  const edges = useMemo(
    () => reducedMotion
      ? graph.edges.map((edge) => ({ ...edge, animated: false }))
      : graph.edges,
    [graph.edges, reducedMotion],
  );

  const flowNames = useMemo(
    () => new Map(data.flows.map((entry) => [entry.flow.id, entry.flow.name])),
    [data.flows],
  );

  const activeWaveName = useMemo(() => {
    if (!activeWaveId) return null;
    const wave = data.waves.find((candidate) => candidate.id === activeWaveId);
    if (!wave) return t('waves.selectedWave');
    const roots = new Set(wave.rootExecutionIds);
    const names = data.executions.filter((execution) => roots.has(execution.executionId)).map((execution) => execution.name);
    return names.length > 0 ? names.join(', ') : t('waves.selectedWave');
  }, [activeWaveId, data.executions, data.waves, t]);

  const fit = useCallback(() => {
    window.setTimeout(() => {
      if (largeMap) {
        void instanceRef.current?.setViewport(
          { x: 28, y: 52, zoom: mode === 'expert' ? 0.58 : 0.7 },
          { duration: reducedMotion ? 0 : 260 },
        );
        return;
      }
      void instanceRef.current?.fitView({ padding: mode === 'expert' ? 0.08 : 0.13, duration: reducedMotion ? 0 : 320 });
    }, 30);
  }, [largeMap, mode, reducedMotion]);

  const miniMapColor = useCallback((node: Node) => {
    if (node.type === 'playgroundPackage') return alpha(theme.palette.primary.main, 0.1);
    if (node.type === 'playgroundSimpleFlow' || node.type === 'playgroundFlowFrame') return theme.palette.primary.main;
    if (node.type === 'signal') return '#8b5cf6';
    if (node.type === 'subflow') return '#0891b2';
    return theme.palette.text.secondary;
  }, [theme.palette.primary.main, theme.palette.text.secondary]);

  return (
    <FlowNamesContext.Provider value={flowNames}>
      <ReactFlow
        key={mode}
        nodes={nodes}
        edges={edges}
        nodeTypes={playgroundNodeTypes}
        edgeTypes={playgroundEdgeTypes}
        onInit={(instance) => {
          instanceRef.current = instance;
          fit();
        }}
        onPaneClick={() => activeWaveId && onActiveWaveChange(null)}
        fitView={!largeMap}
        fitViewOptions={{ padding: mode === 'expert' ? 0.08 : 0.13 }}
        minZoom={mode === 'expert' ? 0.035 : 0.08}
        maxZoom={mode === 'expert' ? 1.45 : 1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        elevateEdgesOnSelect
        panOnScroll
        selectionOnDrag={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        colorMode={theme.palette.mode}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: !reducedMotion,
          style: { stroke: theme.palette.text.secondary, strokeWidth: 2 },
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color={alpha(theme.palette.text.secondary, theme.palette.mode === 'dark' ? 0.2 : 0.16)}
        />

        <Panel position="top-left">
          <Paper
            elevation={0}
            sx={{
              px: 1,
              py: 0.75,
              borderRadius: 2.5,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: alpha(theme.palette.background.paper, 0.9),
              backdropFilter: 'blur(10px)',
              maxWidth: compact ? 260 : 440,
            }}
          >
            {activeWaveName ? (
              <Chip
                color="primary"
                size="small"
                icon={<HubRoundedIcon />}
                label={t('waves.followingWave', { name: activeWaveName })}
                onDelete={() => onActiveWaveChange(null)}
                sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
              />
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {mode === 'simple'
                  ? t('waves.followTriggerHelp')
                  : t('waves.expertHelp')}
              </Typography>
            )}
          </Paper>
        </Panel>

        {!compact && (
          <Panel position="top-right">
            <Paper
              elevation={0}
              sx={{
                px: 1.2,
                py: 0.75,
                borderRadius: 2.5,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: alpha(theme.palette.background.paper, 0.86),
                backdropFilter: 'blur(10px)',
              }}
            >
              <Stack direction="row" spacing={1.25} alignItems="center">
                <Stack direction="row" spacing={0.35} alignItems="center">
                  <BoltRoundedIcon sx={{ fontSize: 15, color: '#8b5cf6' }} />
                  <Typography variant="caption">{t('waves.legendSignal')}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.35} alignItems="center">
                  <CallSplitRoundedIcon sx={{ fontSize: 15, color: '#0891b2' }} />
                  <Typography variant="caption">{t('waves.legendSubflow')}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.35} alignItems="center">
                  <CheckCircleOutlineRoundedIcon sx={{ fontSize: 15, color: '#16a34a' }} />
                  <Typography variant="caption">{t('waves.legendCompletion')}</Typography>
                </Stack>
              </Stack>
            </Paper>
          </Panel>
        )}

        <Controls showInteractive={false} position="bottom-left" />
        {!compact && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={miniMapColor}
            nodeStrokeWidth={2}
            maskColor={alpha(theme.palette.background.default, 0.62)}
            style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${theme.palette.divider}` }}
          />
        )}
      </ReactFlow>
    </FlowNamesContext.Provider>
  );
}

export default function PlaygroundCanvas(props: PlaygroundCanvasProps) {
  const { t } = useI18n();
  if (props.data.flows.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', p: 4 }}>
        <Stack spacing={1} alignItems="center" sx={{ maxWidth: 380, textAlign: 'center' }}>
          <HubRoundedIcon color="primary" sx={{ fontSize: 42, opacity: 0.7 }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>{t('waves.emptyPlaygroundTitle')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('waves.emptyPlaygroundDescription')}
          </Typography>
        </Stack>
      </Box>
    );
  }
  return (
    <ReactFlowProvider>
      <PlaygroundCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

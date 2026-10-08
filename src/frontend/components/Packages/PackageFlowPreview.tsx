'use client';

// PackageFlowPreview (issue #407)
// -----------------------------------------------------------------------------
// Safe, READ-ONLY browsing of a flow that ships inside a package the user has
// not installed yet. It renders the manifest's graph with the same FlowBuilder
// node/edge components the Chat panels reuse (ExecutedFlowPanel / DebuggerCanvas
// pattern) but with every mutation affordance switched off: no dragging, no
// connecting, no selection, no persistence callbacks and no execution.
//
// A textual outline is always available (and is the automatic fallback for a
// malformed or unrenderable graph) so the preview stays usable for keyboard and
// screen-reader users, and never turns a bad package into a broken wizard.

import React, { useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import {
  StartNode,
  ProcessNode,
  FinishNode,
  MCPNode,
  SubflowNode,
  ResourceNode,
  SignalNode,
  TriggerNode,
  StaticNode,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge, ResourceEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { PackageFlowInfo } from '@/backend/services/packages/installPackage';

// Every builder node type must be registered — an unregistered type falls back
// to React Flow's default node, which lacks the named handles the edges
// reference and would silently drop them.
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
  subflow: SubflowNode,
  resource: ResourceNode,
  signal: SignalNode,
  trigger: TriggerNode,
  static: StaticNode,
};

const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
  resourceEdge: ResourceEdge,
};

/** Hard cap: past this a package graph is outlined textually, never rendered. */
const MAX_PREVIEW_NODES = 400;

interface Props {
  flow: PackageFlowInfo;
  /** Start collapsed to the textual outline (large packages stay responsive). */
  defaultTextual?: boolean;
}

export default function PackageFlowPreview({ flow, defaultTextual = false }: Props) {
  const { t, formatNumber } = useI18n();

  const prepared = useMemo(() => {
    if (!flow.graph) {
      return { nodes: [] as Node[], edges: [] as Edge[], error: flow.graphError ?? 'no graph' };
    }
    if (flow.nodeCount > MAX_PREVIEW_NODES) {
      return { nodes: [] as Node[], edges: [] as Edge[], error: 'too many nodes' };
    }
    try {
      const nodes = (flow.graph.nodes ?? [])
        .filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === 'object')
        .map((n) => ({
          ...(n as unknown as Node),
          draggable: false,
          selectable: false,
          connectable: false,
        })) as Node[];
      const edges = (flow.graph.edges ?? [])
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map((e) => ({ ...(e as unknown as Edge), selectable: false })) as Edge[];
      return { nodes, edges, error: null as string | null };
    } catch (err) {
      return {
        nodes: [] as Node[],
        edges: [] as Edge[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [flow]);

  const canRenderGraph = prepared.error === null && prepared.nodes.length > 0;
  const [textual, setTextual] = useState(defaultTextual || !canRenderGraph);
  const showGraph = canRenderGraph && !textual;

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
        sx={{ mb: 1 }}
      >
        <Typography variant="caption" color="text.secondary">
          {t('packages.install.nodesEdges', {
            nodes: formatNumber(flow.nodeCount),
            edges: formatNumber(flow.edgeCount),
          })}
        </Typography>
        {canRenderGraph && (
          <Button
            size="small"
            startIcon={textual ? <AccountTreeOutlinedIcon /> : <FormatListBulletedIcon />}
            onClick={() => setTextual((current) => !current)}
          >
            {textual ? t('packages.install.showGraph') : t('packages.install.showList')}
          </Button>
        )}
      </Stack>

      {!canRenderGraph && flow.nodeCount > 0 && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('packages.install.graphUnavailable')}
        </Alert>
      )}

      {showGraph ? (
        <Box
          role="img"
          aria-label={t('packages.install.graphAria', { name: flow.effectiveName || flow.name })}
          sx={{
            height: 340,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: 'background.default',
          }}
        >
          <ReactFlowProvider>
            <ReactFlow
              nodes={prepared.nodes}
              edges={prepared.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              attributionPosition="bottom-right"
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              onNodeClick={(event) => event.preventDefault()}
              onEdgeClick={(event) => event.preventDefault()}
            />
          </ReactFlowProvider>
        </Box>
      ) : (
        <Box
          component="ul"
          aria-label={t('packages.install.outlineAria', { name: flow.effectiveName || flow.name })}
          sx={{ m: 0, pl: 2, maxHeight: 340, overflow: 'auto' }}
        >
          {flow.nodeSummary.length === 0 && (
            <Typography component="li" variant="body2" color="text.secondary" sx={{ listStyle: 'none', ml: -2 }}>
              {t('packages.install.emptyFlow')}
            </Typography>
          )}
          {flow.nodeSummary.map((node, index) => (
            <Box component="li" key={`${node.id}-${index}`} sx={{ mb: 0.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" variant="outlined" label={node.type} />
                <Typography variant="body2">{node.label || node.id}</Typography>
              </Stack>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

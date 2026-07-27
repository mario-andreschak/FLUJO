"use client";

// ExecutedFlowPanel (issue #213)
// -----------------------------------------------------------------------------
// A lightweight, read-only "path view" for the Chat UI: it renders the flow of
// the current conversation and highlights the nodes that were actually executed
// (green) while de-emphasising the ones that were not (dimmed). It is a
// stripped-down cousin of the Debugger's canvas — no execution-tracker list, no
// step/detail inspector, no conversation-plumbing view, no stepping controls.
//
// Data-flow is intentionally trivial: the caller derives `executedNodeIds`
// (from the execution tracker / trace / per-message processNodeId) and passes
// them in. For a branching flow only the branch actually taken is highlighted
// because only visited node ids appear in that set.

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Typography, CircularProgress, Alert, IconButton, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { useTheme } from '@mui/material/styles';
import { ReactFlow, useNodesState, useEdgesState, Node, Edge, ReactFlowProvider } from '@xyflow/react';
import { Flow } from '@/shared/types/flow';
import { flowService } from '@/frontend/services/flow';
import { createLogger } from '@/utils/logger';
import { StartNode, ProcessNode, FinishNode, MCPNode, SubflowNode, ResourceNode, SignalNode } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';
import { CustomEdge, MCPEdge, ResourceEdge } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges';
import { LiveActivity, LIVE_HIGHLIGHT_TTL_MS } from '@/utils/shared/liveActivity';

const log = createLogger('frontend/components/Chat/ExecutedFlowPanel');

// Every builder node type must be registered — an unregistered type falls back
// to React Flow's default node, which lacks the named handles the edges
// reference, silently dropping those edges (same rationale as DebuggerCanvas).
const nodeTypes = {
  start: StartNode,
  process: ProcessNode,
  finish: FinishNode,
  mcp: MCPNode,
  subflow: SubflowNode,
  resource: ResourceNode,
  signal: SignalNode,
};

const edgeTypes = {
  custom: CustomEdge,
  mcpEdge: MCPEdge,
  resourceEdge: ResourceEdge,
};

interface ExecutedFlowPanelProps {
  /** Flow id of the current conversation (used when there is no snapshot). */
  flowId: string | null;
  /** Self-contained flow snapshot (quick chats have no saved flow to fetch). */
  flowSnapshot?: Flow | null;
  /** Node ids that were actually executed in this conversation. */
  executedNodeIds: string[];
  /** Optional live activity from the SSE stream: briefly pulses the currently
   *  running node while a run is in progress. Absent ⇒ post-hoc summary only. */
  liveActivity?: LiveActivity;
  /** Hide the panel. */
  onClose: () => void;
}

const ExecutedFlowPanel: React.FC<ExecutedFlowPanelProps> = ({
  flowId,
  flowSnapshot,
  executedNodeIds,
  liveActivity,
  onClose,
}) => {
  const theme = useTheme();
  const [flowDefinition, setFlowDefinition] = useState<Flow | null>(null);
  const [flowLoading, setFlowLoading] = useState<boolean>(true);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Load the flow definition. Prefer the conversation's snapshot when present
  // (quick chats have no persisted flow to fetch), else fetch by id.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setFlowLoading(true);
      setFlowError(null);
      try {
        if (flowSnapshot && Array.isArray(flowSnapshot.nodes)) {
          if (!cancelled) setFlowDefinition(flowSnapshot);
          return;
        }
        if (!flowId) {
          throw new Error('No flow is associated with this conversation yet.');
        }
        log.debug(`Loading flow definition for ID: ${flowId}`);
        const flow = await flowService.getFlow(flowId);
        if (!flow) throw new Error(`Flow with ID ${flowId} not found.`);
        if (!cancelled) setFlowDefinition(flow);
      } catch (err) {
        log.error('Error loading flow definition:', err);
        if (!cancelled) {
          setFlowError(err instanceof Error ? err.message : 'Failed to load flow definition.');
          setFlowDefinition(null);
        }
      } finally {
        if (!cancelled) setFlowLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [flowId, flowSnapshot]);

  // Feed the flow into React Flow with all interactivity disabled (read-only).
  useEffect(() => {
    if (flowDefinition) {
      setNodes(flowDefinition.nodes.map(node => ({
        ...node,
        draggable: false,
        selectable: false,
        connectable: false,
      })));
      setEdges(flowDefinition.edges.map(edge => ({ ...edge, selectable: false })));
    }
  }, [flowDefinition, setNodes, setEdges]);

  const executedSet = useMemo(() => new Set(executedNodeIds), [executedNodeIds]);

  // Decay repaint for the optional live pulse: while any live-activity node
  // entry is younger than the TTL, a low-frequency interval bumps `now` so the
  // pulse fades; it self-stops once everything has aged out.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!liveActivity) return;
    const hasYoung = () =>
      Object.values(liveActivity.byNode).some(e => Date.now() - e.ts < LIVE_HIGHLIGHT_TTL_MS);
    if (!hasYoung()) return;
    const interval = setInterval(() => {
      setNow(Date.now());
      if (!hasYoung()) clearInterval(interval);
    }, 350);
    return () => clearInterval(interval);
  }, [liveActivity]);

  // Derived nodes for display: executed nodes get a green border + soft glow;
  // the currently-running node (live) pulses in the primary colour; every other
  // node is dimmed so the taken path stands out. Computed, not stateful, to
  // avoid render loops (same pattern as DebuggerCanvas).
  const displayNodes = useMemo(() => {
    return nodes.map((node: Node) => {
      const isExecuted = executedSet.has(node.id);
      const liveEntry = liveActivity?.byNode[node.id];
      const isLive = !!liveEntry && now - liveEntry.ts < LIVE_HIGHLIGHT_TTL_MS;
      return {
        ...node,
        style: {
          ...node.style,
          opacity: isExecuted || isLive ? 1 : 0.4,
          border: isLive
            ? `2px solid ${theme.palette.primary.main}`
            : isExecuted
              ? `2px solid ${theme.palette.success.main}`
              : `1px solid ${theme.palette.divider}`,
          boxShadow: isLive
            ? `0 0 10px ${theme.palette.primary.light}`
            : isExecuted
              ? `0 0 8px ${theme.palette.success.light}`
              : undefined,
        },
      };
    });
  }, [nodes, executedSet, liveActivity, now, theme]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: 1, borderColor: 'divider', minWidth: 0 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <AccountTreeOutlinedIcon fontSize="small" color="action" />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          Executed Steps
        </Typography>
        <Tooltip title="Hide panel">
          <IconButton size="small" onClick={onClose} aria-label="Hide executed steps panel">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {flowLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <CircularProgress />
          </Box>
        ) : flowError ? (
          <Alert severity="info" sx={{ m: 2 }}>{flowError}</Alert>
        ) : (
          <ReactFlowProvider>
            <ReactFlow
              nodes={displayNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
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
            />
          </ReactFlowProvider>
        )}
      </Box>
    </Box>
  );
};

export default ExecutedFlowPanel;

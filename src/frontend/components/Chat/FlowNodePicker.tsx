"use client";

import React, { useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
} from '@mui/material';
import AutoModeIcon from '@mui/icons-material/AutoMode';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Edge,
  MarkerType,
  ConnectionLineType,
} from '@xyflow/react';
import { useTheme } from '@mui/material/styles';
import { Flow, FlowNode } from '@/shared/types/flow';
import { nodeTypes, edgeTypes } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/Canvas';

// Only these node kinds can host a chat turn — the rest (mcp, finish, resource,
// signal) are rendered for context but are not clickable, and edges are never
// selectable. Keep in sync with the run engine's notion of a "runnable" node.
const PICKABLE_TYPES = new Set(['start', 'process', 'subflow']);

// Node kind lives on the top-level ReactFlow `type` and is mirrored on
// `data.type`; read the top-level first, matching getStartNode's convention.
const nodeKind = (n: { type?: string; data?: { type?: string } }): string | undefined =>
  n.type ?? n.data?.type;

interface FlowNodePickerProps {
  open: boolean;
  /** The conversation's flow, pre-rendered so the user picks a node visually. */
  flow?: Flow | null;
  /** The currently-selected node id (highlighted with a ring). */
  selectedNodeId?: string | null;
  /** When true, offer an "Automatic" choice (chat input). Edit mode omits it. */
  allowAutomatic?: boolean;
  /** Called with a node id, or null for "Automatic". */
  onSelect: (nodeId: string | null) => void;
  onClose: () => void;
}

const FlowNodePickerInner: React.FC<Omit<FlowNodePickerProps, 'open'>> = ({
  flow,
  selectedNodeId,
  onSelect,
  onClose,
}) => {
  const theme = useTheme();

  // Dim non-pickable nodes and ring the selected one. Styling is applied to the
  // ReactFlow node wrapper so the custom node components render unchanged.
  const nodes = useMemo(
    () =>
      (flow?.nodes || []).map((n) => {
        const pickable = PICKABLE_TYPES.has(nodeKind(n) || '');
        const selected = n.id === selectedNodeId;
        return {
          ...n,
          draggable: false,
          selectable: false,
          style: {
            ...(n.style || {}),
            opacity: pickable ? 1 : 0.35,
            cursor: pickable ? 'pointer' : 'default',
            borderRadius: 8,
            boxShadow: selected ? `0 0 0 3px ${theme.palette.primary.main}` : undefined,
            transition: 'box-shadow 120ms ease',
          },
        } as FlowNode;
      }),
    [flow?.nodes, selectedNodeId, theme.palette.primary.main]
  );

  // Same edge-validity filter the builder applies on load.
  const edges = useMemo(
    () =>
      (flow?.edges || []).filter(
        (edge) => edge.source && edge.target && edge.sourceHandle && edge.targetHandle
      ) as Edge[],
    [flow?.edges]
  );

  const defaultEdgeOptions = useMemo(
    () => ({
      type: 'custom',
      animated: false,
      style: { stroke: theme.palette.text.secondary, strokeWidth: 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 20,
        height: 20,
        color: theme.palette.text.secondary,
      },
    }),
    [theme.palette.text.secondary]
  );

  const handleNodeClick = (_event: React.MouseEvent, node: FlowNode) => {
    if (!PICKABLE_TYPES.has(nodeKind(node) || '')) return; // ignore mcp/finish/etc.
    onSelect(node.id);
    onClose();
  };

  return (
    <ReactFlow<FlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
      minZoom={0.1}
      maxZoom={2}
      onNodeClick={handleNodeClick}
      // Read-only apart from click-to-pick.
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
    </ReactFlow>
  );
};

/**
 * A visual node picker for the chat: pre-renders the conversation's flow using
 * the exact builder node components (via FlowPreview's nodeTypes) and lets the
 * user click a Start, Process, or Subflow node to choose where the next turn
 * runs. MCP/Finish/Resource/Signal nodes and edges are shown for context but
 * are not selectable. Replaces the old flat dropdown, which listed every node
 * with no visual structure.
 */
export const FlowNodePicker: React.FC<FlowNodePickerProps> = ({
  open,
  flow,
  selectedNodeId,
  allowAutomatic,
  onSelect,
  onClose,
}) => {
  const hasFlow = !!(flow && (flow.nodes?.length ?? 0) > 0);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Pick a node to run on</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            Click a <strong>Start</strong>, <strong>Process</strong>, or{' '}
            <strong>Subflow</strong> node. Other nodes and edges can&apos;t be picked.
          </Typography>
        </Box>
        <Box sx={{ height: '62vh', width: '100%' }}>
          {hasFlow ? (
            <ReactFlowProvider>
              <FlowNodePickerInner
                flow={flow}
                selectedNodeId={selectedNodeId}
                onSelect={onSelect}
                onClose={onClose}
              />
            </ReactFlowProvider>
          ) : (
            <Box
              sx={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography variant="body2" color="text.secondary">
                No flow to display.
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {allowAutomatic && (
          <Button
            startIcon={<AutoModeIcon />}
            onClick={() => {
              onSelect(null);
              onClose();
            }}
          >
            Automatic
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
};

export default FlowNodePicker;

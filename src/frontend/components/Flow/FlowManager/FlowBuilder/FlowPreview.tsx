"use client";

import React, { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Edge, MarkerType, ConnectionLineType } from '@xyflow/react';
import { useTheme } from '@mui/material/styles';
import { Flow, FlowNode } from '@/shared/types/flow';
import { nodeTypes, edgeTypes } from './Canvas/Canvas';

interface FlowPreviewProps {
  flow: Flow;
}

/**
 * A faithful, read-only render of a flow definition — reuses the exact custom
 * node/edge components from the builder canvas (nodeTypes/edgeTypes) so a
 * previewed version looks identical to how it would look when opened for
 * editing. All interaction is disabled: no dragging, connecting, selecting, or
 * context menus. Used by the version-history dialog to preview an archived
 * version before restoring it.
 *
 * Wrapped in its own ReactFlowProvider so its store is isolated from the live
 * builder canvas mounted elsewhere on the page.
 */
const FlowPreviewInner: React.FC<FlowPreviewProps> = ({ flow }) => {
  const theme = useTheme();

  // Same edge-validity filter the builder applies on load — a stored edge
  // missing source/target handles can't be rendered.
  const edges = useMemo(
    () =>
      (flow.edges || []).filter(
        (edge) => edge.source && edge.target && edge.sourceHandle && edge.targetHandle
      ) as Edge[],
    [flow.edges]
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

  return (
    <ReactFlow<FlowNode, Edge>
      nodes={(flow.nodes || []) as FlowNode[]}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
      minZoom={0.1}
      maxZoom={2}
      // Read-only: no editing, connecting, selecting, or delete.
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

export const FlowPreview: React.FC<FlowPreviewProps> = (props) => (
  <ReactFlowProvider>
    <FlowPreviewInner {...props} />
  </ReactFlowProvider>
);

export default FlowPreview;

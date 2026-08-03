"use client";

import React, { useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Edge,
  MarkerType,
  ConnectionLineType,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useTheme } from '@mui/material/styles';
import { Flow, FlowNode } from '@/shared/types/flow';
import { nodeTypes, edgeTypes } from './Canvas/Canvas';
import { computeAutoLayout } from './Canvas/utils/autoLayout';

interface FlowPreviewProps {
  flow: Flow;
  /** Recompute the same top-to-bottom layout used by Expert mode's Auto-align. */
  autoLayout?: boolean;
  /** Reframe the graph whenever its streamed definition changes. */
  fitViewOnChange?: boolean;
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
const FlowPreviewInner: React.FC<FlowPreviewProps> = ({
  flow,
  autoLayout = false,
  fitViewOnChange = false,
}) => {
  const theme = useTheme();
  const instanceRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);

  // Same edge-validity filter the builder applies on load — a stored edge
  // missing source/target handles can't be rendered.
  const edges = useMemo(
    () =>
      (flow.edges || []).filter(
        (edge) => edge.source && edge.target && edge.sourceHandle && edge.targetHandle
      ) as Edge[],
    [flow.edges]
  );

  const nodes = useMemo(
    () => autoLayout
      ? computeAutoLayout((flow.nodes || []) as FlowNode[], edges)
      : (flow.nodes || []) as FlowNode[],
    [autoLayout, edges, flow.nodes],
  );

  useEffect(() => {
    if (!fitViewOnChange || !instanceRef.current) return;
    const timer = window.setTimeout(() => {
      void instanceRef.current?.fitView({ padding: 0.18, duration: 260 });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [fitViewOnChange, nodes]);

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
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      connectionLineType={ConnectionLineType.SmoothStep}
      onInit={(instance) => { instanceRef.current = instance; }}
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

'use client';

/**
 * Read-only React Flow canvas for one conversation chain (issue #405).
 *
 * Purely presentational: it receives already-projected chain nodes, turns them
 * into a deterministic node/edge model with the shared pure adapter, and
 * renders them. No dragging, connecting, selecting or deleting — the graph is
 * a map, not an editor.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { ConversationChainNode } from '@/shared/types/conversationChain';
import { buildChainGraphModel } from '@/utils/shared/conversationChainGraph';
import ChainNodeBubble, { type ChainBubbleData } from './ChainNodeBubble';

// Declared once at module scope: a fresh object on every render makes React
// Flow re-create its internal node registry (and warn) on each pass.
const nodeTypes = { chainBubble: ChainNodeBubble };

export interface ChainGraphCanvasProps {
  nodes: ConversationChainNode[];
  onOpenConversation: (conversationId: string) => void;
  /** Disables entrance/edge/hover motion for `prefers-reduced-motion: reduce`. */
  reducedMotion?: boolean;
  height?: number | string;
}

function ChainGraphCanvasInner({
  nodes,
  onOpenConversation,
  reducedMotion = false,
  height = '100%',
}: ChainGraphCanvasProps) {
  const theme = useTheme();
  const { t } = useI18n();

  const model = useMemo(() => buildChainGraphModel(nodes), [nodes]);

  const flowNodes = useMemo<Node[]>(
    () =>
      model.nodes.map((node, index) => ({
        id: node.id,
        type: 'chainBubble',
        position: node.position,
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        data: {
          conversation: node.conversation,
          detached: node.detached,
          reducedMotion,
          index,
          onOpen: onOpenConversation,
        } satisfies ChainBubbleData,
      })),
    [model, reducedMotion, onOpenConversation]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      model.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: !reducedMotion,
        style: { stroke: theme.palette.primary.main, strokeWidth: 1.6, opacity: 0.55 },
      })),
    [model, reducedMotion, theme.palette.primary.main]
  );

  const [renderedNodes, setRenderedNodes, onNodesChange] = useNodesState<Node>(flowNodes);
  const [renderedEdges, setRenderedEdges, onEdgesChange] = useEdgesState<Edge>(flowEdges);

  // Layout only moves when the DATA changes (issue #405: no animated relayout
  // on every render, which would make the canvas jitter while polling).
  useEffect(() => {
    setRenderedNodes(flowNodes);
  }, [flowNodes, setRenderedNodes]);

  useEffect(() => {
    setRenderedEdges(flowEdges);
  }, [flowEdges, setRenderedEdges]);

  const noop = useCallback(() => undefined, []);

  return (
    <Box
      role="application"
      aria-label={t('chainChat.canvasLabel')}
      sx={{
        height,
        width: '100%',
        minHeight: 320,
        borderRadius: 3,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        '& .react-flow__edge-path': reducedMotion ? { animation: 'none' } : undefined,
      }}
    >
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onConnect={noop}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: false }}
        attributionPosition="bottom-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </Box>
  );
}

export function ChainGraphCanvas(props: ChainGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <ChainGraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default ChainGraphCanvas;

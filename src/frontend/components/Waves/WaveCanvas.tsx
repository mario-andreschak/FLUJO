'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box } from '@mui/material';
import type { Wave, WaveChainNode } from '@/shared/types/waves/waves';
import TriggerChainNode from './TriggerChainNode';
import {
  computeWaveLayout,
  timelineDriftX,
  BASE_X,
  BASE_Y,
  COLUMN_WIDTH,
  ROW_HEIGHT,
} from './waveLayout';

const nodeTypes = { trigger: TriggerChainNode };

interface WaveCanvasProps {
  wave: Wave;
  height?: number;
}

/**
 * Read-only React Flow canvas for a single wave. Cron/MCP-poll/URL-watch roots
 * drift right→left as their next run approaches (re-computed on a 1s tick);
 * webhook/file-watch roots stay pinned left.
 */
function WaveCanvasInner({ wave, height = 360 }: WaveCanvasProps) {
  const [now, setNow] = useState(() => Date.now());

  // 1s tick drives the timeline drift + "until next run" labels.
  useEffect(() => {
    const hasTimeline = wave.nodes.some((n) => n.timing.mode === 'timeline');
    if (!hasTimeline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wave]);

  const layout = useMemo(() => computeWaveLayout(wave), [wave]);
  const chainById = useMemo(() => {
    const m = new Map<string, WaveChainNode>();
    for (const n of wave.nodes) m.set(n.executionId, n);
    return m;
  }, [wave]);

  const nodes: Node[] = useMemo(() => {
    return layout.nodes.map((ln) => {
      const root = chainById.get(ln.rootExecutionId);
      const drift =
        root && root.timing.mode === 'timeline' ? timelineDriftX(root.timing.nextRun, now) : 0;
      return {
        id: ln.chainNode.executionId,
        type: 'trigger',
        position: { x: BASE_X + ln.column * COLUMN_WIDTH + drift, y: BASE_Y + ln.row * ROW_HEIGHT },
        data: { chainNode: ln.chainNode, now },
        draggable: false,
        connectable: false,
      };
    });
  }, [layout, chainById, now]);

  const edges: Edge[] = useMemo(() => {
    return wave.edges.map((e) => {
      const label =
        e.via === 'signal'
          ? `signal: ${e.topic ?? ''}`
          : e.on && e.on.length > 0
            ? e.on.join(' / ')
            : 'on completion';
      return {
        id: `${e.fromExecutionId}->${e.toExecutionId}-${e.via}-${e.topic ?? ''}`,
        source: e.fromExecutionId,
        target: e.toExecutionId,
        label,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: e.via === 'signal' ? '#7b1fa2' : '#616161' },
      };
    });
  }, [wave]);

  return (
    <Box sx={{ height, width: '100%', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 1 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}

export default function WaveCanvas(props: WaveCanvasProps) {
  return (
    <ReactFlowProvider>
      <WaveCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

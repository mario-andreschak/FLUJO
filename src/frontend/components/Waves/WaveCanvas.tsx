'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  MarkerType,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { Wave } from '@/shared/types/waves/waves';
import TriggerChainNode from './TriggerChainNode';
import ClockAnchorNode from './ClockAnchorNode';
import { buildWaveGraph, edgeLabel, CLOCK_X, BASE_Y } from './waveGraph';
import {
  DEFAULT_WAVE_WINDOW,
  WAVE_WINDOWS,
  WAVE_WINDOW_KEYS,
  type WaveWindowKey,
} from './waveTimeline';

const nodeTypes = { trigger: TriggerChainNode, clock: ClockAnchorNode };

interface WaveCanvasProps {
  wave: Wave;
  height?: number;
}

/**
 * Read-only React Flow canvas for a single wave (#144). A left clock anchor marks
 * "now"; timeline roots are placed by time-to-next-run (right = further out) and a
 * recurring schedule expands into one card per upcoming run in the window. The
 * chain is revealed lazily: hover a card to drop its next level below it and keep
 * following to arbitrary depth. The canvas never hijacks page scroll.
 */
function WaveCanvasInner({ wave, height = 460 }: WaveCanvasProps) {
  const [now, setNow] = useState(() => Date.now());
  const [windowKey, setWindowKey] = useState<WaveWindowKey>(DEFAULT_WAVE_WINDOW);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasTimeline = useMemo(() => wave.nodes.some((n) => n.timing.mode === 'timeline'), [wave]);

  // 30s tick keeps the "in Xh Ym" labels + drift fresh without thrashing.
  useEffect(() => {
    if (!hasTimeline) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hasTimeline]);

  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
  }, []);

  const windowMs = WAVE_WINDOWS[windowKey];

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of wave.nodes) m.set(n.executionId, n.name);
    return m;
  }, [wave]);

  const graph = useMemo(
    () => buildWaveGraph({ wave, now, windowMs, hoveredKey }),
    [wave, now, windowMs, hoveredKey],
  );

  const nodes: Node[] = useMemo(() => {
    const clock: Node = {
      id: '__clock__',
      type: 'clock',
      position: { x: CLOCK_X, y: BASE_Y },
      data: {},
      draggable: false,
      selectable: false,
      connectable: false,
    };
    const cards: Node[] = graph.nodes.map((gn) => ({
      id: gn.key,
      type: 'trigger',
      position: { x: gn.x, y: gn.y },
      data: {
        chainNode: gn.chainNode,
        now,
        runAt: gn.runAt,
        isRoot: gn.isRoot,
        hasSuccessors: gn.hasSuccessors,
        expanded: gn.expanded,
      },
      draggable: false,
      connectable: false,
    }));
    return [clock, ...cards];
  }, [graph, now]);

  const edges: Edge[] = useMemo(() => {
    return graph.edges.map((ge) => {
      const stroke = ge.recursive ? '#ed6c02' : ge.chainEdge.via === 'signal' ? '#7b1fa2' : '#616161';
      const label = `${ge.recursive ? '↻ ' : ''}${edgeLabel(ge.chainEdge, nameById.get(ge.chainEdge.fromExecutionId))}`;
      return {
        id: ge.id,
        source: ge.source,
        target: ge.target,
        sourceHandle: 'down',
        targetHandle: 'up',
        label,
        animated: !ge.recursive,
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: { stroke, strokeDasharray: ge.recursive ? '6 4' : undefined },
        labelStyle: { fontSize: 10, fill: stroke },
        labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
      };
    });
  }, [graph, nameById]);

  return (
    <Box sx={{ height, width: '100%', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 1 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Never swallow the page's wheel scroll (#144).
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        preventScrolling={false}
        panOnDrag
        onNodeMouseEnter={(_e, node) => {
          if (clearTimer.current) clearTimeout(clearTimer.current);
          setHoveredKey(node.type === 'clock' ? null : node.id);
        }}
        onNodeMouseLeave={() => {
          if (clearTimer.current) clearTimeout(clearTimer.current);
          // Grace period so the mouse can travel to a freshly-revealed child.
          clearTimer.current = setTimeout(() => setHoveredKey(null), 260);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        {hasTimeline && (
          <Panel position="top-right">
            <ToggleButtonGroup
              size="small"
              exclusive
              value={windowKey}
              onChange={(_e, v) => v && setWindowKey(v as WaveWindowKey)}
              sx={{ bgcolor: 'background.paper', boxShadow: 1 }}
            >
              {WAVE_WINDOW_KEYS.map((k) => (
                <ToggleButton key={k} value={k} sx={{ px: 1, py: 0.25 }}>
                  {k}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Panel>
        )}
        <Panel position="bottom-right">
          <Typography variant="caption" sx={{ opacity: 0.55, bgcolor: 'background.paper', px: 0.5, borderRadius: 0.5 }}>
            hover a card to follow its chain
          </Typography>
        </Panel>
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

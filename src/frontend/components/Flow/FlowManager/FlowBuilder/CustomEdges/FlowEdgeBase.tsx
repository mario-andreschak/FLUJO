"use client";

import React, { FC, useRef, useState } from 'react';
import {
  EdgeProps,
  getSmoothStepPath,
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  useReactFlow
} from '@xyflow/react';
import { styled, useTheme } from '@mui/material/styles';

// Fired by the waypoint grip when the user finishes dragging (or
// double-clicks to reset). The Canvas listens and commits the change through
// the controlled edge store, so it lands in undo history exactly once per
// gesture.
export const EDGE_WAYPOINT_EVENT = 'flowEdgeWaypoint';
export interface EdgeWaypointEventDetail {
  edgeId: string;
  /** Flow coordinates, or null to reset to automatic routing. */
  waypoint: { x: number; y: number } | null;
}

const EdgeButton = styled('button')(({ theme }) => ({
  background: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  cursor: 'pointer',
  borderRadius: '50%',
  fontSize: '10px',
  width: '20px',
  height: '20px',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  color: theme.palette.text.secondary,
  boxShadow: theme.palette.mode === 'dark'
    ? '0 2px 4px rgba(0,0,0,0.3)'
    : '0 2px 4px rgba(0,0,0,0.1)',
  // Turn red on hover to signal the destructive (delete) action.
  '&:hover': {
    background: theme.palette.error.main,
    borderColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
  }
}));

// Grip the user drags to re-route the edge through a custom waypoint.
const EdgeGrip = styled('button')(({ theme }) => ({
  background: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  cursor: 'move',
  borderRadius: '50%',
  fontSize: '9px',
  width: '20px',
  height: '20px',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  color: theme.palette.text.secondary,
  boxShadow: theme.palette.mode === 'dark'
    ? '0 2px 4px rgba(0,0,0,0.3)'
    : '0 2px 4px rgba(0,0,0,0.1)',
  touchAction: 'none',
  '&:hover': {
    background: theme.palette.action.hover,
  }
}));

const EdgePath = styled(BaseEdge)({
  '&.animated': {
    strokeDasharray: 5,
    animation: 'flowPathAnimation 0.5s infinite linear',
  },
  // Bidirectional: the dashes swing back and forth instead of flowing one way.
  '&.animated-both': {
    strokeDasharray: 5,
    animation: 'flowPathAnimation 0.75s infinite linear alternate',
  },
  '@keyframes flowPathAnimation': {
    '0%': {
      strokeDashoffset: 10,
    },
    '100%': {
      strokeDashoffset: 0,
    },
  }
});

interface FlowEdgeBaseProps extends EdgeProps {
  variant: 'standard' | 'mcp';
}

/**
 * The single edge renderer behind CustomEdge (flow control) and MCPEdge
 * (tool wiring). Differences live in the variant: stroke color, default
 * handle positions, and animation (flow-control edges animate in their
 * travel direction; bidirectional ones swing both ways; MCP wiring is
 * static).
 *
 * Shared behavior:
 * - the delete button and the waypoint grip appear only while the edge is
 *   hovered or selected
 * - dragging the grip routes the edge through a custom waypoint (stored in
 *   edge.data.waypoint, so it persists with the flow); double-clicking the
 *   grip resets to automatic routing
 */
const FlowEdgeBase: FC<FlowEdgeBaseProps> = ({
  variant,
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  markerStart,
  data,
  selected
}) => {
  const theme = useTheme();
  const { deleteElements, screenToFlowPosition } = useReactFlow();

  const [hovered, setHovered] = useState(false);
  // Waypoint being dragged right now — rendered live, committed on release.
  const [previewWaypoint, setPreviewWaypoint] = useState<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);

  const storedWaypoint = (data as { waypoint?: { x: number; y: number } } | undefined)?.waypoint;
  const waypoint = previewWaypoint ?? storedWaypoint;
  const bidirectional = variant === 'standard' && !!(data as { bidirectional?: boolean } | undefined)?.bidirectional;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition || (variant === 'mcp' ? Position.Left : Position.Bottom),
    targetX,
    targetY,
    targetPosition: targetPosition || (variant === 'mcp' ? Position.Right : Position.Top),
    borderRadius: 16,
    centerX: waypoint?.x,
    centerY: waypoint?.y,
  });

  const edgeStyle = {
    ...style,
    strokeWidth: selected ? 3 : 2,
    stroke: variant === 'mcp'
      ? (selected ? theme.palette.info.light : theme.palette.info.main)
      : (selected ? theme.palette.primary.main : theme.palette.text.secondary),
  };

  const animationClass = variant === 'mcp'
    ? ''
    : bidirectional
      ? 'animated-both'
      : (data as { animated?: boolean } | undefined)?.animated !== false
        ? 'animated'
        : '';

  const commitWaypoint = (value: { x: number; y: number } | null) => {
    document.dispatchEvent(
      new CustomEvent<EdgeWaypointEventDetail>(EDGE_WAYPOINT_EVENT, {
        detail: { edgeId: id, waypoint: value },
      })
    );
  };

  const onGripPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    dragActiveRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onGripPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragActiveRef.current) return;
    setPreviewWaypoint(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const onGripPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const finalWaypoint = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Commit and clear the preview in the same batch — the committed data
    // arrives with the same render, so the edge doesn't flicker.
    commitWaypoint(finalWaypoint);
    setPreviewWaypoint(null);
  };

  const controlsVisible = selected || hovered;

  return (
    <>
      <EdgePath
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={edgeStyle}
        id={id}
        className={animationClass}
      />
      {/* Invisible wide path so hovering anywhere near the edge reveals the
          controls (the visible path is only 2px). */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: controlsVisible ? 'all' : 'none',
            opacity: controlsVisible ? 1 : 0,
            transition: 'opacity 120ms ease',
            zIndex: 1000,
            display: 'flex',
            gap: '4px',
          }}
          className="nodrag nopan"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <EdgeGrip
            title="Drag to re-route this connection; double-click to reset"
            onPointerDown={onGripPointerDown}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setPreviewWaypoint(null);
              commitWaypoint(null);
            }}
          >⣿</EdgeGrip>
          <EdgeButton
            title="Delete connection"
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
          >×</EdgeButton>
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

export default FlowEdgeBase;

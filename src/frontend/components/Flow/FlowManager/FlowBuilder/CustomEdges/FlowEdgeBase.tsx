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
import {
  Point,
  axisFromPosition,
  buildOrthogonalPath,
  nearestGap,
} from './orthogonalPath';

// Fired when the user finishes a re-route gesture (bend drag, waypoint move,
// or waypoint removal). The Canvas listens and commits the change through
// the controlled edge store, so it lands in undo history exactly once per
// gesture.
export const EDGE_WAYPOINT_EVENT = 'flowEdgeWaypoint';
export interface EdgeWaypointEventDetail {
  edgeId: string;
  /** Flow coordinates, or null to reset to automatic routing. */
  waypoints: Point[] | null;
}

// Movement (px) before a pointer-down on the edge counts as a bend drag
// instead of a click — plain clicks select the edge / hit the delete button
// without ever moving the route.
const DRAG_THRESHOLD = 4;

// The delete button sits diagonally off the path midpoint so it never covers
// the line or a bend dot (the path is always axis-aligned, so a diagonal
// offset clears it in every orientation).
const DELETE_OFFSET = { x: 16, y: -16 };

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

// The doubled `&&` bumps specificity above ReactFlow's built-in
// `.react-flow__edge.animated path` rule, which otherwise wins (edges carry
// animated: true) and forces its own one-way dash animation — visibly
// breaking the bidirectional back-and-forth.
const EdgePath = styled(BaseEdge)({
  '&&.animated': {
    strokeDasharray: 5,
    animation: 'flowPathAnimation 0.5s infinite linear',
  },
  // Bidirectional: the dashes swing back and forth instead of flowing one way.
  '&&.animated-both': {
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

interface DragState {
  /** Index of the waypoint being dragged within the working array. */
  index: number;
  pointerId: number;
  /** Where the pointer went down, in screen coordinates. */
  startClient: Point;
  /** The waypoint array the gesture started from. */
  base: Point[];
  /** True once DRAG_THRESHOLD is exceeded and the gesture edits the route. */
  active: boolean;
  /** For a bend drag on the path: gesture is discarded if never activated. */
  fromPath: boolean;
}

/**
 * The single edge renderer behind CustomEdge (flow control) and MCPEdge
 * (tool wiring). Differences live in the variant: stroke color, default
 * handle positions, and animation (flow-control edges animate in their
 * travel direction; bidirectional ones swing both ways; MCP wiring is
 * static).
 *
 * Routing works like draw.io: grab the edge anywhere and drag to bend it —
 * a waypoint is created under the cursor and the edge becomes an orthogonal
 * polyline that always passes through its waypoints (edge.data.waypoints,
 * persisted with the flow). While the edge is hovered or selected, each
 * waypoint shows a small dot: drag to move it, double-click to remove it.
 * The delete button sits at the path midpoint and only reacts to genuine
 * clicks (a drag that starts on it bends the route instead).
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
  // Waypoints being edited right now — rendered live, committed on release.
  const [previewWaypoints, setPreviewWaypoints] = useState<Point[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Set when a gesture turned into a drag so the click that browsers fire
  // after pointer-up doesn't also trigger the delete button.
  const suppressClickRef = useRef(false);

  const edgeData = data as
    | { waypoints?: Point[]; waypoint?: Point; bidirectional?: boolean; animated?: boolean }
    | undefined;
  // (data.waypoint is the single-waypoint shape from the first iteration of
  // this feature — treat it as a one-entry array.)
  const storedWaypoints = edgeData?.waypoints ?? (edgeData?.waypoint ? [edgeData.waypoint] : []);
  const waypoints = previewWaypoints ?? storedWaypoints;
  const bidirectional = variant === 'standard' && !!edgeData?.bidirectional;

  const sourcePos = sourcePosition || (variant === 'mcp' ? Position.Left : Position.Bottom);
  const targetPos = targetPosition || (variant === 'mcp' ? Position.Right : Position.Top);

  // Without waypoints the edge keeps ReactFlow's default smoothstep route;
  // with waypoints it becomes an orthogonal polyline through them.
  let edgePath: string;
  let controlsPoint: Point;
  let routed: ReturnType<typeof buildOrthogonalPath> | null = null;
  if (waypoints.length > 0) {
    routed = buildOrthogonalPath(
      { x: sourceX, y: sourceY },
      axisFromPosition(sourcePos),
      { x: targetX, y: targetY },
      axisFromPosition(targetPos),
      waypoints,
      16
    );
    edgePath = routed.d;
    controlsPoint = routed.midpoint;
  } else {
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition: sourcePos,
      targetX,
      targetY,
      targetPosition: targetPos,
      borderRadius: 16,
    });
    edgePath = path;
    controlsPoint = { x: labelX, y: labelY };
  }

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
      : edgeData?.animated !== false
        ? 'animated'
        : '';

  const commitWaypoints = (value: Point[] | null) => {
    document.dispatchEvent(
      new CustomEvent<EdgeWaypointEventDetail>(EDGE_WAYPOINT_EVENT, {
        detail: { edgeId: id, waypoints: value && value.length > 0 ? value : null },
      })
    );
  };

  // --- Bend gesture: pointer-down on the edge path drags out a new waypoint
  const onPathPointerDown = (e: React.PointerEvent<Element>) => {
    // Only the primary button bends; leave right-click for the context menu.
    if (e.button !== 0) return;
    const grabPoint = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const gap = routed ? nearestGap(grabPoint, routed.segments) : 0;
    const base = [...waypoints];
    base.splice(gap, 0, grabPoint);
    dragRef.current = {
      index: gap,
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      base,
      active: false,
      fromPath: true,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
    // No preventDefault/stopPropagation: an un-moved click must still bubble
    // so ReactFlow selects the edge as usual.
  };

  // --- Move gesture: pointer-down on a waypoint dot moves that waypoint
  const onDotPointerDown = (index: number) => (e: React.PointerEvent<Element>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = {
      index,
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      base: [...waypoints],
      active: false,
      fromPath: false,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onDragPointerMove = (e: React.PointerEvent<Element>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      const moved = Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y);
      if (moved < DRAG_THRESHOLD) return;
      drag.active = true;
    }
    const next = [...drag.base];
    next[drag.index] = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setPreviewWaypoints(next);
  };

  const onDragPointerUp = (e: React.PointerEvent<Element>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
    suppressClickRef.current = drag.active;
    if (!drag.active) {
      // Never moved: it was a click, not a re-route — change nothing.
      return;
    }
    const next = [...drag.base];
    next[drag.index] = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Commit and clear the preview in the same batch — the committed data
    // arrives with the same render, so the edge doesn't flicker.
    commitWaypoints(next);
    setPreviewWaypoints(null);
  };

  const removeWaypoint = (index: number) => {
    const next = waypoints.filter((_, i) => i !== index);
    setPreviewWaypoints(null);
    commitWaypoints(next);
  };

  const dragging = previewWaypoints !== null;
  const controlsVisible = selected || hovered || dragging;

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
      {/* Invisible wide path: hovering it reveals the controls, and grabbing
          it anywhere bends the edge (draw.io-style). */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onPointerDown={onPathPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      />
      <EdgeLabelRenderer>
        {/* Waypoint dots — on the path, drag to move, double-click to remove */}
        {controlsVisible && waypoints.map((wp, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${wp.x}px,${wp.y}px)`,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: theme.palette.primary.main,
              border: `2px solid ${theme.palette.background.paper}`,
              boxShadow: theme.shadows[1],
              cursor: 'move',
              pointerEvents: 'all',
              touchAction: 'none',
              zIndex: 1001,
            }}
            className="nodrag nopan"
            title="Drag to move; double-click to remove this bend"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onPointerDown={onDotPointerDown(i)}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removeWaypoint(i);
            }}
          />
        ))}
        {/* Delete button diagonally offset from the path midpoint (hidden
            while re-routing) so it never overlaps the line or a bend dot.
            A genuine click deletes; dragging from it still bends the edge
            like grabbing the path itself. */}
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${controlsPoint.x + DELETE_OFFSET.x}px,${controlsPoint.y + DELETE_OFFSET.y}px)`,
            pointerEvents: controlsVisible && !dragging ? 'all' : 'none',
            opacity: controlsVisible && !dragging ? 1 : 0,
            transition: 'opacity 120ms ease',
            zIndex: 1000,
          }}
          className="nodrag nopan"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <EdgeButton
            title="Delete connection (drag to re-route)"
            style={{ touchAction: 'none' }}
            onPointerDown={onPathPointerDown}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerUp}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              deleteElements({ edges: [{ id }] });
            }}
          >×</EdgeButton>
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

export default FlowEdgeBase;

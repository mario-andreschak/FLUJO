import { Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';

/**
 * Shared geometry helpers for the FlowBuilder's two auto-align modes
 * (`computeAutoLayout` — full re-layout, `computeTidyLayout` — position-
 * preserving de-overlap). Extracted so both algorithms measure nodes and
 * detect collisions identically (issue #373).
 *
 * Every FlowBuilder node type renders through the single `CustomNode`
 * component (`CustomNodes/index.tsx`) at a FIXED width of 210px — widths do
 * not vary by type. Heights vary with content (summary lines; the technical
 * details accordion defaults to collapsed), so the per-type fallback below is
 * only a rough estimate of a *typical* unmeasured node's rendered height,
 * used before React Flow has actually measured the node (fresh/generated/
 * pasted flows — see `FlowPreview`).
 */
const NODE_WIDTH_FALLBACK = 210;

export const NODE_SIZE_FALLBACK: Record<string, { width: number; height: number }> = {
  start: { width: NODE_WIDTH_FALLBACK, height: 84 },
  process: { width: NODE_WIDTH_FALLBACK, height: 104 },
  finish: { width: NODE_WIDTH_FALLBACK, height: 84 },
  // MCP nodes typically list the connected server plus its tools in the
  // summary block — noticeably taller than a plain process node.
  mcp: { width: NODE_WIDTH_FALLBACK, height: 148 },
  subflow: { width: NODE_WIDTH_FALLBACK, height: 104 },
  // Resource nodes show a URI/description summary — taller than start/finish.
  resource: { width: NODE_WIDTH_FALLBACK, height: 120 },
  signal: { width: NODE_WIDTH_FALLBACK, height: 92 },
  trigger: { width: NODE_WIDTH_FALLBACK, height: 84 },
  static: { width: NODE_WIDTH_FALLBACK, height: 104 },
};

export const DEFAULT_NODE_SIZE = { width: NODE_WIDTH_FALLBACK, height: 104 };

/** Uniform padding added around a node's measured box before overlap checks. */
export const NODE_PADDING = 24;

export function nodeSize(node: FlowNode): { width: number; height: number } {
  const measured = (node as { measured?: { width?: number; height?: number } }).measured;
  const fallback = NODE_SIZE_FALLBACK[(node as { type?: string }).type ?? ''] ?? DEFAULT_NODE_SIZE;
  const width = measured?.width ?? (node as { width?: number }).width ?? fallback.width;
  const height = measured?.height ?? (node as { height?: number }).height ?? fallback.height;
  return { width, height };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned padded bounding box for a node (position is its top-left). */
export function nodeBox(node: FlowNode, pad: number = NODE_PADDING): Box {
  const { width, height } = nodeSize(node);
  return {
    x: node.position.x - pad,
    y: node.position.y - pad,
    w: width + pad * 2,
    h: height + pad * 2,
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * True if any pair of (padded) node boxes intersects. Used by tests to
 * enforce the "no two nodes overlap" invariant, and by the UI to treat an
 * already-tidy graph as a cheap no-op.
 */
export function hasOverlaps(nodes: FlowNode[], pad: number = NODE_PADDING): boolean {
  const boxes = nodes.map(n => nodeBox(n, pad));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) return true;
    }
  }
  return false;
}

function edgeTypeOf(edge: Edge): string | undefined {
  return (edge.data as { edgeType?: string } | undefined)?.edgeType;
}
export function isMcpEdge(edge: Edge): boolean {
  return edgeTypeOf(edge) === 'mcp';
}
export function isResourceEdge(edge: Edge): boolean {
  return edgeTypeOf(edge) === 'resource';
}
/** Attachment (mcp/resource) edges are config wiring, not flow control. */
export function isAttachmentEdge(edge: Edge): boolean {
  return isMcpEdge(edge) || isResourceEdge(edge);
}

/**
 * Resolve each satellite (MCP/resource) node to the single flow node it is
 * wired to — the first matching attachment edge wins. Shared by both layout
 * modes so a node's satellites always move together with it.
 */
export function resolveSatelliteParents(
  satellites: FlowNode[],
  edges: Edge[],
  isSatelliteEdge: (e: Edge) => boolean,
): Map<string, string> {
  const satIds = new Set(satellites.map(n => n.id));
  const parent = new Map<string, string>();
  for (const edge of edges) {
    if (!isSatelliteEdge(edge)) continue;
    const sourceIsSat = satIds.has(edge.source);
    const targetIsSat = satIds.has(edge.target);
    let satId: string | undefined;
    let flowId: string | undefined;
    if (sourceIsSat && !targetIsSat) {
      satId = edge.source;
      flowId = edge.target;
    } else if (targetIsSat && !sourceIsSat) {
      satId = edge.target;
      flowId = edge.source;
    }
    if (satId && flowId && !parent.has(satId)) {
      parent.set(satId, flowId);
    }
  }
  return parent;
}

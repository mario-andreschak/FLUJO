import { Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import {
  Box,
  NODE_PADDING,
  boxesOverlap,
  isMcpEdge,
  isResourceEdge,
  nodeBox,
  nodeSize,
  resolveSatelliteParents,
} from './layoutGeometry';

/**
 * Options for {@link computeTidyLayout}. All optional.
 */
export interface TidyLayoutOptions {
  /** Padding added around each node's measured box for collision checks. */
  padding?: number;
  /** Hard cap on relaxation passes (termination guarantee). Default 60. */
  maxPasses?: number;
  /** Clamp on how far a single node may move in a single pass. Default 200. */
  maxStepPerPass?: number;
  /** Snap resolved positions to an 8px grid. Default true. */
  snapToGrid?: boolean;
  /** Subtract the mean displacement so the graph doesn't drift. Default true. */
  preserveCentroid?: boolean;
}

const GRID = 8;

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * Position-preserving "tidy up" layout (issue #373): a bounded, deterministic
 * overlap-resolution pass that keeps every node roughly where the user put it
 * and only pushes apart what actually collides. MCP/resource satellites are
 * dragged along with their parent's displacement instead of being treated as
 * independent bodies.
 *
 * Guarantees:
 *  - Idempotent: if the input has no overlaps, the output has the exact same
 *    positions (a cheap no-op).
 *  - Deterministic: repeated calls on the same input produce identical output.
 *  - Terminating: bounded by `maxPasses`.
 *  - Pure: only `position` fields change; a new array/objects are returned.
 */
export function computeTidyLayout(
  nodes: FlowNode[],
  edges: Edge[],
  options: TidyLayoutOptions = {},
): FlowNode[] {
  const {
    padding = NODE_PADDING,
    maxPasses = 60,
    maxStepPerPass = 200,
    snapToGrid = true,
    preserveCentroid = true,
  } = options;

  if (nodes.length <= 1) return nodes;

  const mcpNodes = nodes.filter(n => n.type === 'mcp');
  const resourceNodes = nodes.filter(n => n.type === 'resource');
  const mcpParent = resolveSatelliteParents(mcpNodes, edges, isMcpEdge);
  const resourceParent = resolveSatelliteParents(resourceNodes, edges, isResourceEdge);
  const parentOf = new Map<string, string>([...mcpParent, ...resourceParent]);

  // Followers move by exactly their parent's delta; only "leaders" (anything
  // that isn't a satellite with a resolved parent) participate in relaxation.
  const leaderIds = nodes.filter(n => !parentOf.has(n.id)).map(n => n.id);
  const followersOf = new Map<string, string[]>();
  for (const [satId, parentId] of parentOf) {
    const bucket = followersOf.get(parentId);
    if (bucket) bucket.push(satId);
    else followersOf.set(parentId, [satId]);
  }

  const originalX = new Map<string, number>();
  const originalY = new Map<string, number>();
  for (const n of nodes) {
    originalX.set(n.id, n.position.x);
    originalY.set(n.id, n.position.y);
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) pos.set(n.id, { x: n.position.x, y: n.position.y });

  const sizeOf = new Map<string, { width: number; height: number }>();
  for (const n of nodes) sizeOf.set(n.id, nodeSize(n));

  const boxFor = (id: string): Box => {
    const p = pos.get(id)!;
    const { width, height } = sizeOf.get(id)!;
    return { x: p.x - padding, y: p.y - padding, w: width + padding * 2, h: height + padding * 2 };
  };

  // Only nodes actually displaced by the relaxation are grid-snapped, so a
  // clean, already non-overlapping (and possibly off-grid) layout is
  // returned byte-identical — the idempotency guarantee.
  const movedIds = new Set<string>();
  const moveLeader = (id: string, dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    const p = pos.get(id)!;
    pos.set(id, { x: p.x + dx, y: p.y + dy });
    movedIds.add(id);
    for (const followerId of followersOf.get(id) ?? []) {
      const fp = pos.get(followerId)!;
      pos.set(followerId, { x: fp.x + dx, y: fp.y + dy });
      movedIds.add(followerId);
    }
  };

  // Deterministic, stable ordering for the relaxation sweep.
  const ordered = [...leaderIds].sort((a, b) => {
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    return pa.y - pb.y || pa.x - pb.x || a.localeCompare(b);
  });

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const idA = ordered[i];
        const idB = ordered[j];
        const boxA = boxFor(idA);
        const boxB = boxFor(idB);
        if (!boxesOverlap(boxA, boxB)) continue;

        const overlapX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
        const overlapY = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y);

        const centerAX = boxA.x + boxA.w / 2;
        const centerBX = boxB.x + boxB.w / 2;
        const centerAY = boxA.y + boxA.h / 2;
        const centerBY = boxB.y + boxB.h / 2;

        // Push apart along the axis with the SMALLER overlap — this keeps
        // rows/columns intact instead of scattering nodes diagonally.
        let dx = 0;
        let dy = 0;
        if (overlapX <= overlapY) {
          const dir = centerAX <= centerBX ? -1 : 1;
          const step = Math.min(overlapX / 2 + 1, maxStepPerPass);
          dx = dir * step;
        } else {
          const dir = centerAY <= centerBY ? -1 : 1;
          const step = Math.min(overlapY / 2 + 1, maxStepPerPass);
          dy = dir * step;
        }

        moveLeader(idA, dx, dy);
        moveLeader(idB, -dx, -dy);
        moved = true;
      }
    }
    if (!moved) break;
  }

  if (preserveCentroid) {
    let sumDx = 0;
    let sumDy = 0;
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      sumDx += p.x - originalX.get(n.id)!;
      sumDy += p.y - originalY.get(n.id)!;
    }
    const meanDx = sumDx / nodes.length;
    const meanDy = sumDy / nodes.length;
    if (meanDx !== 0 || meanDy !== 0) {
      for (const n of nodes) {
        const p = pos.get(n.id)!;
        pos.set(n.id, { x: p.x - meanDx, y: p.y - meanDy });
      }
    }
  }

  if (snapToGrid) {
    for (const id of movedIds) {
      const p = pos.get(id)!;
      pos.set(id, { x: snap(p.x), y: snap(p.y) });
    }
  }

  return nodes.map(n => {
    const p = pos.get(n.id)!;
    if (p.x === n.position.x && p.y === n.position.y) return n;
    return { ...n, position: p };
  });
}

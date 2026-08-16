import { Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import {
  Box,
  NODE_PADDING,
  boxesOverlap,
  isMcpEdge,
  isResourceEdge,
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

/** Union of two axis-aligned boxes (the smallest box containing both). */
function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Compute the minimum-translation separation vector between two overlapping
 * boxes, pushing apart along whichever axis has the smaller overlap (keeps
 * rows/columns intact instead of scattering nodes diagonally). Returns the
 * HALF-step vector to apply to `boxA` (and its negation to `boxB`) so that,
 * applied to both sides, the overlap on the chosen axis closes. Returns
 * `null` when the boxes do not overlap.
 */
function computeSeparation(
  boxA: Box,
  boxB: Box,
  maxStep: number,
): { dx: number; dy: number } | null {
  if (!boxesOverlap(boxA, boxB)) return null;

  const overlapX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
  const overlapY = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y);

  const centerAX = boxA.x + boxA.w / 2;
  const centerBX = boxB.x + boxB.w / 2;
  const centerAY = boxA.y + boxA.h / 2;
  const centerBY = boxB.y + boxB.h / 2;

  let dx = 0;
  let dy = 0;
  if (overlapX <= overlapY) {
    const dir = centerAX <= centerBX ? -1 : 1;
    const step = Math.min(overlapX / 2 + 1, maxStep);
    dx = dir * step;
  } else {
    const dir = centerAY <= centerBY ? -1 : 1;
    const step = Math.min(overlapY / 2 + 1, maxStep);
    dy = dir * step;
  }
  return { dx, dy };
}

/**
 * Resolve overlaps *within* a single parent + satellite cluster, keeping the
 * parent (leader) anchored in place and only adjusting the satellites'
 * offsets relative to it. This is what guarantees a cluster is internally
 * overlap-free (satellite-vs-satellite and satellite-vs-parent) regardless
 * of how the satellites were originally parked.
 */
function resolveClusterInternally(
  leaderId: string,
  followerIds: string[],
  pos: Map<string, { x: number; y: number }>,
  sizeOf: Map<string, { width: number; height: number }>,
  padding: number,
): void {
  if (followerIds.length === 0) return;
  const members = [leaderId, ...followerIds];

  const boxFor = (id: string): Box => {
    const p = pos.get(id)!;
    const { width, height } = sizeOf.get(id)!;
    return { x: p.x - padding, y: p.y - padding, w: width + padding * 2, h: height + padding * 2 };
  };

  const hasInternalOverlap = () => {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (boxesOverlap(boxFor(members[i]), boxFor(members[j]))) return true;
      }
    }
    return false;
  };
  // Already overlap-free: leave every position exactly as-is (idempotency).
  if (!hasInternalOverlap()) return;

  // Deterministic re-parking: the leader stays exactly where it is; each
  // follower is placed in a fixed lane on its original side (right for a
  // positive x offset, left for negative — mirroring the MCP/resource
  // parking convention) and stacked top-to-bottom in its original relative
  // order, far enough from the leader (and from every other follower in the
  // same lane) that no box in the cluster can possibly overlap another,
  // regardless of measured sizes.
  const GAP = 16;
  const leaderPos = pos.get(leaderId)!;
  const leaderSize = sizeOf.get(leaderId)!;
  const sides: Record<'left' | 'right', string[]> = { left: [], right: [] };
  for (const id of followerIds) {
    const p = pos.get(id)!;
    (p.x - leaderPos.x < 0 ? sides.left : sides.right).push(id);
  }
  for (const side of ['left', 'right'] as const) {
    const lane = sides[side];
    if (lane.length === 0) continue;
    lane.sort((a, b) => {
      const pa = pos.get(a)!;
      const pb = pos.get(b)!;
      return pa.y - pb.y || pa.x - pb.x || a.localeCompare(b);
    });
    const sign = side === 'right' ? 1 : -1;
    let y = leaderPos.y;
    for (const id of lane) {
      const { width, height } = sizeOf.get(id)!;
      const laneOffset =
        leaderSize.width / 2 + width / 2 + padding * 2 + GAP;
      pos.set(id, { x: leaderPos.x + sign * laneOffset, y });
      y += height + padding * 2 + GAP;
    }
  }
}

/**
 * Position-preserving "tidy up" layout (issue #373): a bounded, deterministic
 * overlap-resolution pass that keeps every node roughly where the user put it
 * and only pushes apart what actually collides.
 *
 * A flow node (leader) together with its attached MCP/resource satellites is
 * treated as a single rigid CLUSTER during relaxation: the cluster's union
 * bounding box participates in collision checks against other clusters and
 * foreign nodes, and the whole cluster moves as one unit so the parent's
 * exact offset to each satellite is preserved bit-for-bit. Any overlaps
 * *within* a cluster (satellite-vs-satellite or satellite-vs-parent) are
 * resolved first, relative to the (fixed) parent, so a cluster starts out —
 * and stays — internally overlap-free.
 *
 * Guarantees:
 *  - Idempotent: if the input has no overlaps, the output has the exact same
 *    positions (a cheap no-op).
 *  - Deterministic: repeated calls on the same input produce identical output.
 *  - Terminating: bounded by `maxPasses`.
 *  - Pure: only `position` fields change; a new array/objects are returned.
 *  - No two (padded) node boxes overlap in the result, MCP/resource
 *    satellites included.
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

  // Followers move rigidly with their parent's cluster; only "leaders"
  // (anything that isn't a satellite with a resolved parent) participate
  // directly in cross-cluster relaxation.
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

  // Step 1: make every cluster internally overlap-free BEFORE cross-cluster
  // relaxation, keeping the leader fixed as the cluster's anchor. This fixes
  // satellite-vs-satellite (and satellite-vs-parent) overlaps regardless of
  // how the satellites were originally parked.
  for (const [leaderId, followerIds] of followersOf) {
    resolveClusterInternally(leaderId, followerIds, pos, sizeOf, padding);
  }

  // Record each satellite's offset from its leader now that intra-cluster
  // overlaps are resolved. This offset is treated as fixed for the rest of
  // the algorithm — the cluster always moves as a single rigid unit, which
  // both preserves the exact parent->satellite delta and lets the
  // relaxation pass reason about a cluster's combined footprint.
  const offsetOf = new Map<string, { x: number; y: number }>();
  for (const [satId, leaderId] of parentOf) {
    const lp = pos.get(leaderId)!;
    const sp = pos.get(satId)!;
    offsetOf.set(satId, { x: sp.x - lp.x, y: sp.y - lp.y });
  }

  // A cluster's collision footprint is the union of the leader's box and all
  // of its followers' boxes, so satellites participate fully in cross-
  // cluster (and cluster-vs-foreign-node) overlap resolution.
  const clusterBoxFor = (leaderId: string): Box => {
    let box = boxFor(leaderId);
    for (const followerId of followersOf.get(leaderId) ?? []) {
      box = unionBox(box, boxFor(followerId));
    }
    return box;
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
    // Followers move by the exact same delta so the cluster stays rigid;
    // their final position is re-derived from `offsetOf` at the end anyway,
    // but keeping them in sync here matters for subsequent-pass box checks.
    for (const followerId of followersOf.get(id) ?? []) {
      const fp = pos.get(followerId)!;
      pos.set(followerId, { x: fp.x + dx, y: fp.y + dy });
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
        const boxA = clusterBoxFor(idA);
        const boxB = clusterBoxFor(idB);
        const sep = computeSeparation(boxA, boxB, maxStepPerPass);
        if (!sep) continue;

        moveLeader(idA, sep.dx, sep.dy);
        moveLeader(idB, -sep.dx, -sep.dy);
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
      // Satellites are re-derived from their leader's (post-snap) position
      // below, so snapping them independently here would re-break the exact
      // parent->satellite offset (issue #373 regression: the offset isn't
      // generally a multiple of the grid).
      if (parentOf.has(id)) continue;
      const p = pos.get(id)!;
      pos.set(id, { x: snap(p.x), y: snap(p.y) });
    }
  }

  // Satellites always follow their leader's final position by the fixed
  // offset established during intra-cluster resolution — never snapped or
  // moved independently — so the parent->satellite delta is exact.
  for (const [satId, leaderId] of parentOf) {
    const lp = pos.get(leaderId)!;
    const off = offsetOf.get(satId)!;
    pos.set(satId, { x: lp.x + off.x, y: lp.y + off.y });
  }

  return nodes.map(n => {
    const p = pos.get(n.id)!;
    if (p.x === n.position.x && p.y === n.position.y) return n;
    return { ...n, position: p };
  });
}

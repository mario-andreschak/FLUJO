import type { Wave, WaveChainNode } from '@/shared/types/waves/waves';

/** Horizontal spacing between chain depth columns (px). */
export const COLUMN_WIDTH = 300;
/** Vertical spacing between stacked siblings (px). */
export const ROW_HEIGHT = 170;
/** Left margin / fixed-left anchor (px). */
export const BASE_X = 40;
export const BASE_Y = 40;
/** Max horizontal drift band for a timeline root (px). */
export const TIMELINE_SPAN = 260;
/** Look-ahead window mapped across the drift band (ms). Default 6h. */
export const TIMELINE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Deterministic per-node layout coordinates within a wave. */
export interface WaveLayoutNode {
  chainNode: WaveChainNode;
  /** Chain depth (longest path from a root). */
  column: number;
  /** Stacking row within the column. */
  row: number;
  /** The root this node descends from (drives timeline drift). */
  rootExecutionId: string;
}

export interface WaveLayout {
  nodes: WaveLayoutNode[];
}

/**
 * Compute a deterministic column/row layout for a wave: roots on the left
 * (column 0), each downstream node one column right of its deepest predecessor.
 * Siblings in a column are stacked by execution id. The caller turns
 * column/row into pixel coordinates, applying live timeline drift for roots.
 */
export function computeWaveLayout(wave: Wave): WaveLayout {
  const nodeById = new Map<string, WaveChainNode>();
  for (const n of wave.nodes) nodeById.set(n.executionId, n);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of wave.nodes) {
    preds.set(n.executionId, []);
    succs.set(n.executionId, []);
  }
  for (const e of wave.edges) {
    if (nodeById.has(e.fromExecutionId) && nodeById.has(e.toExecutionId)) {
      preds.get(e.toExecutionId)!.push(e.fromExecutionId);
      succs.get(e.fromExecutionId)!.push(e.toExecutionId);
    }
  }

  const roots = wave.nodes
    .filter((n) => (preds.get(n.executionId)?.length ?? 0) === 0)
    .map((n) => n.executionId)
    .sort();
  const rootSet = roots.length > 0 ? roots : wave.rootExecutionIds;

  // Longest-path depth via BFS with a visited-cap so cycles terminate.
  const depth = new Map<string, number>();
  const rootOf = new Map<string, string>();
  for (const id of rootSet) {
    depth.set(id, 0);
    rootOf.set(id, id);
  }
  // Relax edges up to node-count times (Bellman-Ford style longest path on a
  // DAG; cycles are bounded by the iteration cap).
  const iterations = wave.nodes.length + 1;
  for (let i = 0; i < iterations; i++) {
    let changed = false;
    for (const e of wave.edges) {
      const from = depth.get(e.fromExecutionId);
      if (from === undefined) continue;
      const candidate = from + 1;
      const cur = depth.get(e.toExecutionId);
      if (cur === undefined || candidate > cur) {
        depth.set(e.toExecutionId, candidate);
        rootOf.set(e.toExecutionId, rootOf.get(e.fromExecutionId) ?? rootSet[0] ?? e.fromExecutionId);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Any unreached node (isolated) sits at column 0 under itself.
  for (const n of wave.nodes) {
    if (!depth.has(n.executionId)) {
      depth.set(n.executionId, 0);
      rootOf.set(n.executionId, n.executionId);
    }
  }

  // Stack siblings by column, ordered by execution id for determinism.
  const byColumn = new Map<number, string[]>();
  for (const n of wave.nodes) {
    const col = depth.get(n.executionId) ?? 0;
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(n.executionId);
  }

  const rowOf = new Map<string, number>();
  for (const [, ids] of byColumn) {
    ids.sort();
    ids.forEach((id, idx) => rowOf.set(id, idx));
  }

  const nodes: WaveLayoutNode[] = wave.nodes.map((chainNode) => ({
    chainNode,
    column: depth.get(chainNode.executionId) ?? 0,
    row: rowOf.get(chainNode.executionId) ?? 0,
    rootExecutionId: rootOf.get(chainNode.executionId) ?? chainNode.executionId,
  }));

  return { nodes };
}

/**
 * Horizontal drift offset (px) for a timeline node: far right when the next run
 * is a full window away, sliding to the left anchor as it approaches. Clamped
 * to the drift band.
 */
export function timelineDriftX(nextRun: string | null, now: number): number {
  if (!nextRun) return 0;
  const remaining = new Date(nextRun).getTime() - now;
  if (Number.isNaN(remaining) || remaining <= 0) return 0;
  const fraction = Math.min(1, remaining / TIMELINE_WINDOW_MS);
  return Math.round(fraction * TIMELINE_SPAN);
}

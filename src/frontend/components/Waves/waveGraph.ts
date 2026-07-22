/**
 * Pure layout/graph builder for the redesigned Waves canvas (#144).
 *
 * The canvas is a hover-driven, right→left timeline:
 *   - ROOTS sit on the top lane, positioned horizontally by how soon they fire
 *     (near the clock = soon, far right = a window away). A recurring schedule is
 *     expanded into one root INSTANCE per upcoming run in the window, each with
 *     its own downstream chain.
 *   - The chain is revealed LAZILY: only root cards show until the user hovers.
 *     Hovering a node drops its next level (connected downstream executions) into
 *     a lane below it; hovering one of those expands the next level, and so on to
 *     arbitrary depth. Cycles (recursion) terminate because a node is only ever
 *     placed once and the repeated link is drawn back to the existing card as a
 *     visibly distinct dashed edge.
 *
 * This module is pure (no React, no I/O) so the expansion + occurrence layout can
 * be unit-tested deterministically.
 */

import type { Wave, WaveChainEdge, WaveChainNode } from '@/shared/types/waves/waves';
import { buildWaveAdjacency } from '@/utils/shared/waveHierarchy';
import { enumerateOccurrences, timelineFraction } from './waveTimeline';

/* --------------------------------------------------------------------- */
/* Layout constants                                                       */
/* --------------------------------------------------------------------- */

export const CLOCK_X = 16;
export const BASE_Y = 24;
/** Vertical distance between chain levels. */
export const LANE_H = 150;
/** Left edge of the timeline band (right of the clock). */
export const TIMELINE_X0 = 160;
/** Width of the timeline band the window is mapped across. */
export const TIMELINE_W = 620;
/** Horizontal spacing between sibling cards in an expanded level. */
export const CHILD_SPACING = 250;

/* --------------------------------------------------------------------- */
/* Public shapes                                                          */
/* --------------------------------------------------------------------- */

export interface WaveGraphNode {
  /** Occurrence-namespaced key (`${executionId}#${occ}`). Unique per card. */
  key: string;
  /** The underlying execution id (shared across occurrences). */
  baseId: string;
  /** Occurrence index (0 for non-recurring / pinned roots). */
  occ: number;
  chainNode: WaveChainNode;
  isRoot: boolean;
  /** Fire time (ms) for a root instance, when known. */
  runAt: number | null;
  level: number;
  x: number;
  y: number;
  /** Has downstream successors that could be revealed on hover. */
  hasSuccessors: boolean;
  /** Its next level is currently shown. */
  expanded: boolean;
}

export interface WaveGraphEdge {
  id: string;
  source: string;
  target: string;
  chainEdge: WaveChainEdge;
  /** The link points back to an already-shown ancestor/peer (recursion). */
  recursive: boolean;
}

export interface WaveGraph {
  nodes: WaveGraphNode[];
  edges: WaveGraphEdge[];
}

export interface BuildWaveGraphInput {
  wave: Wave;
  now: number;
  windowMs: number;
  /** Occurrence-namespaced key currently hovered (drives lazy expansion). */
  hoveredKey: string | null;
  timezone?: string;
}

/* --------------------------------------------------------------------- */
/* Key helpers                                                            */
/* --------------------------------------------------------------------- */

export function makeKey(baseId: string, occ: number): string {
  return `${baseId}#${occ}`;
}
export function baseOf(key: string): string {
  const i = key.lastIndexOf('#');
  return i >= 0 ? key.slice(0, i) : key;
}
export function occOf(key: string): number {
  const i = key.lastIndexOf('#');
  return i >= 0 ? Number(key.slice(i + 1)) : 0;
}

/* --------------------------------------------------------------------- */
/* Builder                                                                */
/* --------------------------------------------------------------------- */

export function buildWaveGraph(input: BuildWaveGraphInput): WaveGraph {
  const { wave, now, windowMs, hoveredKey, timezone } = input;

  // Adjacency + canonical spanning-tree parent are shared with the Chat sidebar
  // wave hierarchy (#214) so the canvas and sidebar can never drift.
  const { nodeById, succ, edgeByPair, rootIds, parentOf } = buildWaveAdjacency(wave);

  /* -- Root instances (timeline occurrences) ------------------------- */
  interface RootInstance { baseId: string; occ: number; runAt: number | null; }
  const rootInstances: RootInstance[] = [];
  for (const rootId of rootIds) {
    const node = nodeById.get(rootId)!;
    if (node.timing.mode === 'timeline') {
      const occs = enumerateOccurrences(node.timing.cron, now, windowMs, undefined, timezone);
      if (occs.length > 0) {
        occs.forEach((runAt, i) => rootInstances.push({ baseId: rootId, occ: i, runAt }));
      } else {
        // No cron enumeration: fall back to the live nextRun (or a single card).
        const nextRun = node.timing.nextRun ? Date.parse(node.timing.nextRun) : NaN;
        rootInstances.push({ baseId: rootId, occ: 0, runAt: Number.isFinite(nextRun) ? nextRun : null });
      }
    } else {
      rootInstances.push({ baseId: rootId, occ: 0, runAt: null });
    }
  }

  /* -- Which occurrence is being explored, and its expanded path ----- */
  const hoveredBase = hoveredKey ? baseOf(hoveredKey) : null;
  const hoveredOcc = hoveredKey ? occOf(hoveredKey) : null;

  // Expanded base ids = hovered node + its spanning-tree ancestors (so the whole
  // followed path stays open while descendants are revealed).
  const expandedBase = new Set<string>();
  if (hoveredBase) {
    let cur: string | undefined = hoveredBase;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      expandedBase.add(cur);
      cur = parentOf.get(cur);
    }
  }

  /* -- Placement (top lane roots, then lazy descent for hovered occ) - */
  const placed = new Map<string, WaveGraphNode>();

  const rootFraction = (inst: RootInstance): number => {
    const node = nodeById.get(inst.baseId)!;
    if (node.timing.mode !== 'timeline') return 0; // pinned left
    if (inst.runAt == null) return 1; // unknown next run → far right
    return timelineFraction(inst.runAt, now, windowMs);
  };

  const addNode = (
    baseId: string,
    occ: number,
    level: number,
    x: number,
    runAt: number | null,
    isRoot: boolean,
  ): void => {
    const key = makeKey(baseId, occ);
    if (placed.has(key)) return;
    const chainNode = nodeById.get(baseId)!;
    placed.set(key, {
      key,
      baseId,
      occ,
      chainNode,
      isRoot,
      runAt,
      level,
      x,
      y: BASE_Y + level * LANE_H,
      hasSuccessors: (succ.get(baseId)?.length ?? 0) > 0,
      expanded: expandedBase.has(baseId) && occ === hoveredOcc,
    });
  };

  // Recursively drop the next level for expanded nodes of the hovered occurrence.
  const descend = (baseId: string, occ: number, level: number, parentX: number): void => {
    if (!(expandedBase.has(baseId) && occ === hoveredOcc)) return;
    const kids = (succ.get(baseId) ?? []).filter((c) => !placed.has(makeKey(c, occ)));
    if (kids.length === 0) return;
    const totalW = (kids.length - 1) * CHILD_SPACING;
    kids.forEach((childBase, i) => {
      const x = parentX - totalW / 2 + i * CHILD_SPACING;
      addNode(childBase, occ, level + 1, x, null, false);
      descend(childBase, occ, level + 1, x);
    });
  };

  for (const inst of rootInstances) {
    const x = TIMELINE_X0 + rootFraction(inst) * TIMELINE_W;
    addNode(inst.baseId, inst.occ, 0, x, inst.runAt, true);
    descend(inst.baseId, inst.occ, 0, x);
  }

  /* -- Edges among placed cards -------------------------------------- */
  const edges: WaveGraphEdge[] = [];
  for (const [key, node] of placed) {
    const occ = node.occ;
    for (const childBase of succ.get(node.baseId) ?? []) {
      const childKey = makeKey(childBase, occ);
      const childNode = placed.get(childKey);
      if (!childNode) continue;
      const chainEdge = edgeByPair.get(`${node.baseId}->${childBase}`);
      if (!chainEdge) continue;
      edges.push({
        id: `${key}->${childKey}`,
        source: key,
        target: childKey,
        chainEdge,
        // A link that does not go strictly deeper is a back/peer edge (recursion).
        recursive: childNode.level <= node.level,
      });
    }
  }

  return { nodes: [...placed.values()], edges };
}

/** Concrete, human-readable label for a chain edge (#144 — replaces the old
 *  unhelpful "on upstream completion"). */
export function edgeLabel(edge: WaveChainEdge, fromName: string | undefined): string {
  if (edge.via === 'signal') return `⚡ ${edge.topic ?? 'signal'}`;
  const on = edge.on && edge.on.length > 0 ? edge.on.join(' / ') : 'completes';
  const who = fromName ? `${fromName} ` : '';
  return `when ${who}${on}`;
}

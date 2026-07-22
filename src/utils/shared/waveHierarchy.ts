/**
 * Pure wave-adjacency helper (issue #144 / #214).
 *
 * The Waves canvas (`waveGraph.ts`) derives a parent→child hierarchy BETWEEN
 * planned executions from the wave graph. This module extracts that adjacency +
 * root resolution + deterministic spanning-tree logic into a single, reusable,
 * framework-free source of truth.
 *
 * NOTE: the Chat sidebar's "Group by wave" mode does NOT use this planned-
 * execution graph to nest conversations. A wave node is a planned-execution
 * (configuration) — there is exactly one `ap-01` node, one `ap-02`, etc. —
 * so nesting runs under it collapses every run of a stage onto a single node.
 * Instead the sidebar nests by the RUNTIME parent chain (`parentConversationId`,
 * recorded by the scheduler when a flow-event/signal fire threads the upstream
 * run as `parentRunId`), giving a real per-run tree (ap-01 run → ap-02 run →
 * ap-03 run). See `ChatHistory.tsx` + `conversationChains.ts`.
 *
 * Kept free of React/MUI so it is unit-testable in the node-env Jest harness.
 */
import type { Wave, WaveChainEdge, WaveChainNode } from '@/shared/types/waves/waves';

/**
 * Deterministic adjacency + spanning-tree derived from a wave's nodes/edges.
 * Consumed by the Waves canvas (`buildWaveGraph`).
 */
export interface WaveAdjacency {
  /** executionId -> chain node. */
  nodeById: Map<string, WaveChainNode>;
  /** executionId -> sorted successor executionIds (dangling edges skipped). */
  succ: Map<string, string[]>;
  /** executionId -> predecessor executionIds (dangling edges skipped). */
  preds: Map<string, string[]>;
  /** "from->to" -> the edge (dangling edges skipped). */
  edgeByPair: Map<string, WaveChainEdge>;
  /** Resolved, sorted root execution ids. */
  rootIds: string[];
  /** BFS spanning-tree parent pointing TOWARD a root (cycle-safe: each node
   *  has at most one parent, and walking `parentOf` always terminates). */
  parentOf: Map<string, string>;
}

/**
 * Build the adjacency + canonical spanning tree for a wave. Deterministic:
 * successors are sorted, roots are the declared roots present in the wave (else
 * the predecessor-less nodes), sorted; the spanning tree is a BFS from the
 * roots so a node is only ever attached under a single parent even through a
 * recursion cycle.
 */
export function buildWaveAdjacency(wave: Wave): WaveAdjacency {
  const nodeById = new Map<string, WaveChainNode>();
  for (const n of wave.nodes) nodeById.set(n.executionId, n);

  const succ = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  for (const n of wave.nodes) {
    succ.set(n.executionId, []);
    preds.set(n.executionId, []);
  }
  const edgeByPair = new Map<string, WaveChainEdge>();
  for (const e of wave.edges) {
    if (!nodeById.has(e.fromExecutionId) || !nodeById.has(e.toExecutionId)) continue;
    succ.get(e.fromExecutionId)!.push(e.toExecutionId);
    preds.get(e.toExecutionId)!.push(e.fromExecutionId);
    edgeByPair.set(`${e.fromExecutionId}->${e.toExecutionId}`, e);
  }
  for (const [, arr] of succ) arr.sort();

  // Roots: declared roots present in the wave, else nodes without preds.
  let rootIds = wave.rootExecutionIds.filter((id) => nodeById.has(id));
  if (rootIds.length === 0) {
    rootIds = wave.nodes
      .filter((n) => (preds.get(n.executionId)?.length ?? 0) === 0)
      .map((n) => n.executionId);
  }
  rootIds = [...rootIds].sort();

  // BFS spanning-tree parent pointing TOWARD a root, so walking `parentOf`
  // always terminates at a root even through recursion cycles.
  const parentOf = new Map<string, string>();
  {
    const seen = new Set<string>(rootIds);
    const queue = [...rootIds];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const v of succ.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v);
          parentOf.set(v, u);
          queue.push(v);
        }
      }
    }
  }

  return { nodeById, succ, preds, edgeByPair, rootIds, parentOf };
}

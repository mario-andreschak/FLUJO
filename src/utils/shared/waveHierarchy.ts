/**
 * Pure wave-hierarchy helpers (issue #214).
 *
 * The Chat Sidebar's "Group by wave" mode (issue #181) buckets conversations by
 * the wave their `plannedExecutionId` belongs to, but renders each bucket FLAT.
 * The Waves canvas (`waveGraph.ts`), by contrast, derives a real parent→child
 * hierarchy BETWEEN planned executions from the wave graph. This module extracts
 * that adjacency + root resolution + deterministic spanning-tree logic into a
 * single, reusable, framework-free source of truth so BOTH the canvas and the
 * sidebar tree agree, and turns a `Wave` into an execution tree the sidebar can
 * render (executions as internal nodes, conversations as leaves).
 *
 * Kept free of React/MUI so it is unit-testable in the node-env Jest harness
 * (mirrors `waveGrouping.ts` / `cardGrouping.ts`).
 */
import type {
  Wave,
  WaveChainEdge,
  WaveChainNode,
  WavesResponse,
} from '@/shared/types/waves/waves';

/**
 * Deterministic adjacency + spanning-tree derived from a wave's nodes/edges.
 * Shared source of truth for the Waves canvas (`buildWaveGraph`) and the Chat
 * sidebar wave hierarchy (`buildWaveExecutionTree`).
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
 * recursion cycle. This is the block previously inline in `buildWaveGraph`.
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

/** A wave rendered as a tree of executions (internal nodes) — issue #214. */
export interface WaveExecutionTree {
  /** The owning wave's deterministic id. */
  waveId: string;
  /** Human-readable label (same rule as `buildWaveLookup`). */
  label: string;
  /** Ordered root execution ids. */
  rootExecutionIds: string[];
  /** parent executionId -> ordered child executionIds (spanning tree). */
  childrenByExecution: Map<string, string[]>;
  /** Stable pre-order (roots, then descendants) for rendering. */
  orderedExecutionIds: string[];
  /** executionId -> chain node (name / triggerKind / flowName for rendering). */
  nodeById: Map<string, WaveChainNode>;
}

/**
 * Wave display label — prefers the (organic) root node's name, then its flow
 * name, then the wave id. IDENTICAL to `buildWaveLookup`'s rule so the sidebar
 * section header and the hierarchy agree.
 */
function waveLabel(wave: Wave): string {
  const rootId = wave.rootExecutionIds?.[0];
  const rootNode =
    (rootId && wave.nodes.find((n) => n.executionId === rootId)) || wave.nodes[0];
  return rootNode?.name || rootNode?.flowName || wave.id;
}

/**
 * Turn one `Wave` into a {@link WaveExecutionTree}: a parent→child tree of
 * executions derived from the wave's spanning tree. Deterministic and
 * cycle-safe (each node appears under exactly one parent; the pre-order walk is
 * guarded so a recursion cycle terminates).
 */
export function buildWaveExecutionTree(wave: Wave): WaveExecutionTree {
  const { rootIds, parentOf, succ, nodeById } = buildWaveAdjacency(wave);

  // childrenByExecution from the spanning tree: each node hangs off its single
  // parent. Ordered by the (sorted) successor order for stable rendering.
  const childrenByExecution = new Map<string, string[]>();
  for (const n of wave.nodes) {
    const parent = parentOf.get(n.executionId);
    if (parent === undefined) continue; // a root, or unreachable (see below)
    const arr = childrenByExecution.get(parent) ?? [];
    arr.push(n.executionId);
    childrenByExecution.set(parent, arr);
  }
  for (const [parent, arr] of childrenByExecution) {
    const order = succ.get(parent) ?? [];
    arr.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  // Pre-order DFS from the roots for a stable render order; visited-guarded so
  // a corrupt/cyclic tree terminates. Any node not reached from a root is
  // appended so nothing is ever dropped.
  const orderedExecutionIds: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    orderedExecutionIds.push(id);
    for (const child of childrenByExecution.get(id) ?? []) walk(child);
  };
  for (const r of rootIds) walk(r);
  for (const n of wave.nodes) {
    if (!visited.has(n.executionId)) {
      visited.add(n.executionId);
      orderedExecutionIds.push(n.executionId);
    }
  }

  return {
    waveId: wave.id,
    label: waveLabel(wave),
    rootExecutionIds: rootIds,
    childrenByExecution,
    orderedExecutionIds,
    nodeById,
  };
}

/**
 * Build a `waveId -> WaveExecutionTree` map from a `WavesResponse`. Tolerates
 * null/undefined/empty input (returns an empty map), matching `buildWaveLookup`.
 */
export function buildWaveExecutionTrees(
  waves: WavesResponse | null | undefined,
): Map<string, WaveExecutionTree> {
  const map = new Map<string, WaveExecutionTree>();
  if (!waves?.waves) return map;
  for (const wave of waves.waves) map.set(wave.id, buildWaveExecutionTree(wave));
  return map;
}

/** The result of attaching conversations to a wave's execution tree. */
export interface WaveConversationAttachment<T> {
  /** executionId -> conversations attached to it (caller order preserved). */
  conversationsByExecution: Map<string, T[]>;
  /** Executions that should be rendered: those whose subtree contains at least
   *  one conversation. Empty leaf executions are omitted; empty executions that
   *  merely connect to conversation-bearing descendants are kept. */
  renderableExecutionIds: Set<string>;
}

/**
 * Attach conversations to the executions of a {@link WaveExecutionTree} by
 * `plannedExecutionId`, and compute which executions are worth rendering.
 *
 * A conversation whose `plannedExecutionId` is not a node in this tree (e.g. the
 * node was pruned since the run) is promoted to the first root so it can never
 * silently disappear — mirroring `buildChainIndex`'s root-promotion safety net.
 */
export function attachConversationsToWaveTree<
  T extends { plannedExecutionId?: string | null },
>(
  tree: WaveExecutionTree,
  conversations: T[],
): WaveConversationAttachment<T> {
  const known = new Set(tree.orderedExecutionIds);
  const fallbackRoot = tree.rootExecutionIds[0] ?? tree.orderedExecutionIds[0];

  const conversationsByExecution = new Map<string, T[]>();
  const push = (execId: string, conv: T): void => {
    const arr = conversationsByExecution.get(execId) ?? [];
    arr.push(conv);
    conversationsByExecution.set(execId, arr);
  };
  for (const conv of conversations) {
    const execId = conv.plannedExecutionId ?? undefined;
    const target = execId && known.has(execId) ? execId : fallbackRoot;
    if (target) push(target, conv);
  }

  // Renderable = execution with a direct conversation OR a descendant with one.
  const renderableExecutionIds = new Set<string>();
  const hasSubtreeConversations = (execId: string, guard: Set<string>): boolean => {
    if (guard.has(execId)) return false;
    guard.add(execId);
    let any = (conversationsByExecution.get(execId)?.length ?? 0) > 0;
    for (const child of tree.childrenByExecution.get(execId) ?? []) {
      if (hasSubtreeConversations(child, guard)) any = true;
    }
    if (any) renderableExecutionIds.add(execId);
    return any;
  };
  for (const r of tree.rootExecutionIds) hasSubtreeConversations(r, new Set());
  // Defensive: also walk any execution not reachable from a root.
  for (const execId of tree.orderedExecutionIds) {
    if (!renderableExecutionIds.has(execId)) {
      hasSubtreeConversations(execId, new Set());
    }
  }

  return { conversationsByExecution, renderableExecutionIds };
}

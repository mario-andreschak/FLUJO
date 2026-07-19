/**
 * Waves resolver (#128) — a PURE, DETERMINISTIC function turning the current
 * set of Planned Executions + Flows into a `Wave[]` graph for visualization.
 *
 * IMPORTANT: this module performs NO I/O and has NO side effects. It never
 * arms, fires or persists anything — Waves is strictly a read-only picture of
 * how executions would chain together at runtime.
 *
 * The chain-edge matching here MIRRORS the authoritative runtime matcher in
 * `src/backend/services/scheduler/triggers/flowEvent.ts` so the visualization
 * cannot diverge from real linkage:
 *   - a `flow-event` `topic` source links from any execution whose bound flow
 *     (or a statically-reachable subflow) contains a `signal` node emitting
 *     that topic (`via: 'signal'`);
 *   - a `flow-event` `executionId` / `flowId` / `flowName` source links from
 *     the matching upstream execution(s) (`via: 'completion'`), with source
 *     precedence executionId > flowId > flowName (exactly one is set).
 * If either file changes, keep the two in sync.
 */

import type { Flow } from '@/shared/types/flow/flow';
import type {
  PlannedExecution,
  TriggerConfig,
} from '@/shared/types/plannedExecution';
// The pure topic/subflow-scan helpers live in a shared, dependency-free module
// so the frontend trigger editor (#165) and this resolver share ONE matcher
// implementation and cannot drift apart.
import {
  directSubflowIds,
  directTopics,
  reachableTopics,
} from '@/shared/utils/signalTopics';
import type {
  Wave,
  WaveChainEdge,
  WaveChainNode,
  WaveEmittedSignal,
  WaveGrouping,
  WaveNodeTiming,
  WaveSubflowRef,
  WaveTriggerKind,
  WavesResponse,
} from '@/shared/types/waves/waves';

/** Minimal execution entry the resolver needs (decoupled from the scheduler). */
export interface WaveResolverExecutionEntry {
  execution: PlannedExecution;
  /** Live status carrying the next scheduled run, when armed. */
  status?: { nextRun?: string | null };
}

export interface ResolveWavesInput {
  executions: WaveResolverExecutionEntry[];
  flows: Flow[];
  paused?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Depth cap for the nested subflow tree. */
  maxSubflowDepth?: number;
  /** Cap on chain traversal hops (mirrors flow-event default). */
  maxChainDepth?: number;
  /** How chains are grouped into waves. Default 'per-root'. */
  grouping?: WaveGrouping;
}

/** Default subflow-tree recursion cap. */
const DEFAULT_MAX_SUBFLOW_DEPTH = 10;
/** Default chain traversal cap (mirrors flowEvent DEFAULT_MAX_CHAIN_DEPTH). */
const DEFAULT_MAX_CHAIN_DEPTH = 5;

/** Map a trigger config to a Waves trigger kind. */
function triggerKind(trigger: TriggerConfig): WaveTriggerKind {
  return trigger.type;
}

/** True for organic triggers that START a chain (everything but flow-event). */
function isRootKind(kind: WaveTriggerKind): boolean {
  return kind !== 'flow-event';
}

/**
 * Build a recursive, depth-capped subflow tree for a flow. Cycles (a flow that
 * transitively calls itself) are flagged with `truncated: true` and not
 * re-expanded, so the tree always terminates.
 */
function buildSubflowTree(
  flowId: string,
  flowsById: Map<string, Flow>,
  maxDepth: number,
  ancestors: Set<string>,
  depth: number,
): WaveSubflowRef[] {
  const flow = flowsById.get(flowId);
  const childIds = directSubflowIds(flow);
  const refs: WaveSubflowRef[] = [];
  for (const childId of childIds) {
    const child = flowsById.get(childId);
    const ref: WaveSubflowRef = {
      flowId: childId,
      flowName: child?.name,
      children: [],
    };
    if (!child) {
      ref.missing = true;
    } else if (depth + 1 >= maxDepth || ancestors.has(childId)) {
      // Depth cap or a back-reference (recursion) — stop expanding.
      ref.truncated = true;
    } else {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(childId);
      ref.children = buildSubflowTree(childId, flowsById, maxDepth, nextAncestors, depth + 1);
    }
    refs.push(ref);
  }
  return refs;
}

/** Build the timing descriptor for a chain node from its trigger. */
function buildTiming(
  kind: WaveTriggerKind,
  trigger: TriggerConfig,
  nextRun: string | null,
): WaveNodeTiming {
  if (kind === 'schedule' || kind === 'mcp-poll' || kind === 'url-watch') {
    const cron = 'cron' in trigger ? trigger.cron : undefined;
    return { mode: 'timeline', nextRun, cron };
  }
  if (kind === 'flow-event') {
    const source = trigger.type === 'flow-event' ? trigger.source : {};
    const topic = typeof source.topic === 'string' && source.topic.trim() ? source.topic.trim() : undefined;
    return { mode: 'event', via: topic ? 'signal' : 'completion', topic };
  }
  return { mode: 'fixed' };
}

/**
 * Build the sorted, de-duped list of signal topics a node's bound flow can emit
 * (#144): its OWN `signal` nodes are `direct: true`; topics only reachable
 * through a statically-reachable subflow are `direct: false`. `topicsOf` is the
 * memoized reachable-topic set (own + subflow), so this stays deterministic and
 * consistent with the signal edge matcher.
 */
function emittedSignalsFor(
  flowId: string,
  flow: Flow | undefined,
  topicsOf: (flowId: string) => Set<string>,
): WaveEmittedSignal[] {
  const direct = new Set(directTopics(flow));
  const reachable = topicsOf(flowId);
  const topics = new Set<string>([...direct, ...reachable]);
  return [...topics]
    .sort()
    .map((topic) => ({ topic, direct: direct.has(topic) }));
}

/** Detect every execution id that participates in a directed cycle. */
function findCycleNodes(edges: WaveChainEdge[], nodeIds: string[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.fromExecutionId)) adj.set(e.fromExecutionId, []);
    adj.get(e.fromExecutionId)!.push(e.toExecutionId);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const inCycle = new Set<string>();
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // Back edge -> mark the whole cycle from v up to u on the stack.
        const idx = stack.lastIndexOf(v);
        if (idx >= 0) for (let i = idx; i < stack.length; i++) inCycle.add(stack[i]);
      } else if (c === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) dfs(id);
  }
  return inCycle;
}

/**
 * Resolve Planned Executions + Flows into a deterministic Wave graph.
 */
export function resolveWaves(input: ResolveWavesInput): WavesResponse {
  const maxSubflowDepth = input.maxSubflowDepth ?? DEFAULT_MAX_SUBFLOW_DEPTH;
  const maxChainDepth = input.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  const grouping: WaveGrouping = input.grouping ?? 'per-root';
  const generatedAt = new Date(input.now ?? Date.now()).toISOString();

  // Deterministic input ordering.
  const entries = [...input.executions].sort((a, b) =>
    a.execution.id < b.execution.id ? -1 : a.execution.id > b.execution.id ? 1 : 0,
  );

  const flowsById = new Map<string, Flow>();
  for (const flow of input.flows) flowsById.set(flow.id, flow);

  // Index executions.
  const entryById = new Map<string, WaveResolverExecutionEntry>();
  const entriesByFlowId = new Map<string, WaveResolverExecutionEntry[]>();
  const entriesByFlowName = new Map<string, WaveResolverExecutionEntry[]>();
  for (const entry of entries) {
    entryById.set(entry.execution.id, entry);
    const fid = entry.execution.flowId;
    if (!entriesByFlowId.has(fid)) entriesByFlowId.set(fid, []);
    entriesByFlowId.get(fid)!.push(entry);
    const fname = flowsById.get(fid)?.name;
    if (fname) {
      if (!entriesByFlowName.has(fname)) entriesByFlowName.set(fname, []);
      entriesByFlowName.get(fname)!.push(entry);
    }
  }

  // Cache reachable topics per flow id (used for signal-source matching).
  const topicCache = new Map<string, Set<string>>();
  const topicsOf = (flowId: string): Set<string> => {
    let t = topicCache.get(flowId);
    if (!t) {
      t = reachableTopics(flowId, flowsById, maxSubflowDepth);
      topicCache.set(flowId, t);
    }
    return t;
  };

  // Build a chain node per execution.
  const nodesById = new Map<string, WaveChainNode>();
  for (const entry of entries) {
    const exec = entry.execution;
    const kind = triggerKind(exec.trigger);
    const flow = flowsById.get(exec.flowId);
    const timing = buildTiming(kind, exec.trigger, entry.status?.nextRun ?? null);
    nodesById.set(exec.id, {
      executionId: exec.id,
      name: exec.name,
      enabled: exec.enabled,
      flowId: exec.flowId,
      flowName: flow?.name,
      triggerKind: kind,
      isRoot: isRootKind(kind),
      timing,
      subflows: buildSubflowTree(exec.flowId, flowsById, maxSubflowDepth, new Set([exec.flowId]), 0),
      emittedSignals: emittedSignalsFor(exec.flowId, flow, topicsOf),
    });
  }

  // Build chain edges + collect orphans (flow-event triggers matching nothing).
  const edges: WaveChainEdge[] = [];
  const orphanIds: string[] = [];
  for (const entry of entries) {
    const exec = entry.execution;
    if (exec.trigger.type !== 'flow-event') continue;
    const source = exec.trigger.source ?? {};
    const on = exec.trigger.on;
    const producers: WaveChainEdge[] = [];

    const topic = typeof source.topic === 'string' && source.topic.trim() ? source.topic.trim() : '';
    if (topic) {
      // Signal source: link from every execution whose flow (incl. subflows)
      // emits this topic. Exclude self-links (a flow emitting a topic its own
      // flow-event trigger also references would be a degenerate self loop).
      for (const producer of entries) {
        if (producer.execution.id === exec.id) continue;
        if (topicsOf(producer.execution.flowId).has(topic)) {
          producers.push({
            fromExecutionId: producer.execution.id,
            toExecutionId: exec.id,
            via: 'signal',
            topic,
          });
        }
      }
    } else if (source.executionId) {
      const producer = entryById.get(source.executionId);
      if (producer) {
        producers.push({ fromExecutionId: producer.execution.id, toExecutionId: exec.id, via: 'completion', on });
      }
    } else if (source.flowId) {
      for (const producer of entriesByFlowId.get(source.flowId) ?? []) {
        producers.push({ fromExecutionId: producer.execution.id, toExecutionId: exec.id, via: 'completion', on });
      }
    } else if (source.flowName) {
      for (const producer of entriesByFlowName.get(source.flowName) ?? []) {
        producers.push({ fromExecutionId: producer.execution.id, toExecutionId: exec.id, via: 'completion', on });
      }
    }

    if (producers.length === 0) {
      orphanIds.push(exec.id);
    } else {
      edges.push(...producers);
    }
  }

  // Deterministic edge ordering.
  edges.sort((a, b) => {
    if (a.fromExecutionId !== b.fromExecutionId) return a.fromExecutionId < b.fromExecutionId ? -1 : 1;
    if (a.toExecutionId !== b.toExecutionId) return a.toExecutionId < b.toExecutionId ? -1 : 1;
    return a.via < b.via ? -1 : a.via > b.via ? 1 : 0;
  });

  // Adjacency for traversal.
  const outgoing = new Map<string, WaveChainEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.fromExecutionId)) outgoing.set(e.fromExecutionId, []);
    outgoing.get(e.fromExecutionId)!.push(e);
  }

  const allNodeIds = entries.map((e) => e.execution.id);
  const cycleNodes = findCycleNodes(edges, allNodeIds);
  const orphanSet = new Set(orphanIds);

  // BFS reachable set from a start node (visited-set terminates on cycles).
  const reachableFrom = (startId: string): Set<string> => {
    const seen = new Set<string>([startId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxChainDepth) continue;
      for (const e of outgoing.get(id) ?? []) {
        if (!seen.has(e.toExecutionId)) {
          seen.add(e.toExecutionId);
          queue.push({ id: e.toExecutionId, depth: depth + 1 });
        }
      }
    }
    return seen;
  };

  const buildWave = (id: string, rootIds: string[], memberIds: Set<string>): Wave => {
    const members = [...memberIds].sort();
    const nodes = members.map((mid) => nodesById.get(mid)!).filter(Boolean);
    const waveEdges = edges.filter(
      (e) => memberIds.has(e.fromExecutionId) && memberIds.has(e.toExecutionId),
    );
    const hasCycle = members.some((mid) => cycleNodes.has(mid));
    return { id, rootExecutionIds: rootIds, nodes, edges: waveEdges, hasCycle };
  };

  const waves: Wave[] = [];

  if (grouping === 'connected-component') {
    // Undirected weakly-connected components over the chain graph.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let cur = x;
      while (parent.get(cur) !== r) {
        const next = parent.get(cur)!;
        parent.set(cur, r);
        cur = next;
      }
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const id of allNodeIds) if (!orphanSet.has(id)) parent.set(id, id);
    for (const e of edges) union(e.fromExecutionId, e.toExecutionId);
    const comps = new Map<string, Set<string>>();
    for (const id of allNodeIds) {
      if (orphanSet.has(id)) continue;
      // Only include nodes that are roots or participate in an edge.
      const isConnected = (outgoing.get(id)?.length ?? 0) > 0 || edges.some((e) => e.toExecutionId === id);
      const node = nodesById.get(id)!;
      if (!node.isRoot && !isConnected) continue;
      const root = find(id);
      if (!comps.has(root)) comps.set(root, new Set());
      comps.get(root)!.add(id);
    }
    const sortedComps = [...comps.values()].map((s) => [...s].sort());
    sortedComps.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const members of sortedComps) {
      const memberSet = new Set(members);
      const rootIds = members.filter((m) => nodesById.get(m)!.isRoot).sort();
      waves.push(buildWave(members.join('|'), rootIds, memberSet));
    }
  } else {
    // Default: one wave per organic root; wave = everything reachable from it.
    const rootIds = allNodeIds.filter((id) => nodesById.get(id)!.isRoot).sort();
    for (const rootId of rootIds) {
      const members = reachableFrom(rootId);
      waves.push(buildWave(rootId, [rootId], members));
    }
  }

  const orphans = orphanIds.sort().map((id) => nodesById.get(id)!);

  return {
    paused: input.paused ?? false,
    generatedAt,
    waves,
    orphans,
  };
}

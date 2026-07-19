/**
 * Signal-topic helpers (issues #163/#165) — PURE, DEPENDENCY-FREE utilities for
 * discovering which flows emit which signal topics.
 *
 * This module performs NO I/O and imports ONLY the shared `Flow`/`FlowNode`
 * types, so it is safe to bundle on BOTH the server (waves resolver) and the
 * browser (the planned-execution trigger editor). It is the single source of
 * truth for the topic-scan logic that previously lived inline in
 * `src/backend/services/waves/waveResolver.ts`.
 *
 * The topic matching here MIRRORS the authoritative runtime matcher in
 * `src/backend/services/scheduler/triggers/flowEvent.ts`. If that changes, keep
 * these helpers in sync.
 */

import type { Flow, FlowNode } from '@/shared/types/flow/flow';

/** Default recursion cap when walking the static subflow tree. */
export const DEFAULT_MAX_TOPIC_DEPTH = 10;

/** One flow that can emit a given topic. */
export interface TopicEmitter {
  /** Id of the flow that (directly or via a subflow) emits the topic. */
  flowId: string;
  /** Human-readable flow name, when resolvable. */
  flowName?: string;
  /** Number of the flow's OWN signal nodes emitting this topic (0 when the
   *  topic is only reachable through a subflow). */
  signalNodeCount: number;
  /** True when the flow emits the topic only through a statically-reachable
   *  subflow rather than one of its own signal nodes. */
  viaSubflow: boolean;
}

/** Collect the direct subflow ids a flow calls (single, map-over, fan-out). */
export function directSubflowIds(flow: Flow | undefined): string[] {
  if (!flow || !Array.isArray(flow.nodes)) return [];
  const ids: string[] = [];
  for (const node of flow.nodes as FlowNode[]) {
    if (node?.data?.type !== 'subflow') continue;
    const props = node.data.properties ?? {};
    if (typeof props.subflowId === 'string' && props.subflowId.trim()) {
      ids.push(props.subflowId.trim());
    }
    if (Array.isArray(props.parallelSubflowIds)) {
      for (const id of props.parallelSubflowIds) {
        if (typeof id === 'string' && id.trim()) ids.push(id.trim());
      }
    }
    // Dynamic fan-out (issue #130, `parallelSubflowIdsVar`) selects its targets
    // from a run variable AT RUNTIME, so the concrete set is unknowable here and
    // is intentionally skipped — there is nothing deterministic to draw/list.
  }
  // De-dupe while preserving first-seen order.
  return Array.from(new Set(ids));
}

/** Collect the topics emitted by a flow's own `signal` nodes (with duplicates
 *  when several nodes emit the same topic). */
export function directTopics(flow: Flow | undefined): string[] {
  if (!flow || !Array.isArray(flow.nodes)) return [];
  const topics: string[] = [];
  for (const node of flow.nodes as FlowNode[]) {
    if (node?.data?.type !== 'signal') continue;
    const topic = node.data.properties?.topic;
    if (typeof topic === 'string' && topic.trim()) topics.push(topic.trim());
  }
  return topics;
}

/**
 * Compute the full set of topics a flow can emit at runtime: its own signal
 * nodes plus those of every statically-reachable subflow (depth/cycle-capped).
 */
export function reachableTopics(
  flowId: string,
  flowsById: Map<string, Flow>,
  maxDepth: number = DEFAULT_MAX_TOPIC_DEPTH,
): Set<string> {
  const topics = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (visited.has(id) || depth > maxDepth) return;
    visited.add(id);
    const flow = flowsById.get(id);
    for (const t of directTopics(flow)) topics.add(t);
    for (const childId of directSubflowIds(flow)) walk(childId, depth + 1);
  };
  walk(flowId, 0);
  return topics;
}

/**
 * Build a topic → emitters index across a set of flows. For each topic it
 * records every flow that emits it, distinguishing direct emitters (one of the
 * flow's own signal nodes, `viaSubflow: false`, with a node count) from flows
 * that can only reach the topic through a statically-reachable subflow
 * (`viaSubflow: true`, `signalNodeCount: 0`).
 *
 * The union of the returned keys equals every topic reachable from any flow,
 * matching what the runtime `flow-event` topic matcher would fire on.
 */
export function buildTopicEmitterIndex(
  flows: Flow[],
  maxDepth: number = DEFAULT_MAX_TOPIC_DEPTH,
): Map<string, TopicEmitter[]> {
  const flowsById = new Map<string, Flow>();
  for (const flow of flows) {
    if (flow && typeof flow.id === 'string') flowsById.set(flow.id, flow);
  }

  const index = new Map<string, TopicEmitter[]>();
  const push = (topic: string, emitter: TopicEmitter): void => {
    if (!index.has(topic)) index.set(topic, []);
    index.get(topic)!.push(emitter);
  };

  for (const flow of flows) {
    if (!flow || typeof flow.id !== 'string') continue;

    // Direct emitters: count this flow's OWN signal nodes per topic.
    const directCounts = new Map<string, number>();
    for (const topic of directTopics(flow)) {
      directCounts.set(topic, (directCounts.get(topic) ?? 0) + 1);
    }
    for (const [topic, count] of directCounts) {
      push(topic, {
        flowId: flow.id,
        flowName: flow.name,
        signalNodeCount: count,
        viaSubflow: false,
      });
    }

    // Reachable-via-subflow: topics the flow can emit only through a subflow.
    const reachable = reachableTopics(flow.id, flowsById, maxDepth);
    for (const topic of reachable) {
      if (directCounts.has(topic)) continue; // already recorded as a direct emitter
      push(topic, {
        flowId: flow.id,
        flowName: flow.name,
        signalNodeCount: 0,
        viaSubflow: true,
      });
    }
  }

  return index;
}

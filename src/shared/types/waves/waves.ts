/**
 * Waves (#128): a read-only, deterministic visualization of how Planned
 * Executions link together into CHAINS.
 *
 * A chain starts at an ORGANIC (root) trigger — schedule/cron, mcp-poll,
 * url-watch, webhook, file-watch — and flows to downstream `flow-event`
 * triggers that react either to a source flow completing/erroring
 * (`via: 'completion'`) or to a `signal` node emission (`via: 'signal'`).
 * A Wave groups related chains for display.
 *
 * These types are produced by the pure resolver
 * (`src/backend/services/waves/waveResolver.ts`) and consumed by the
 * `/waves` frontend section. Nothing here arms, fires or persists anything —
 * the feature is strictly a visualization.
 */

/** Trigger kind as classified for the Waves canvas. */
export type WaveTriggerKind =
  /** Predictable next-run — rendered on a drifting right→left timeline. */
  | 'schedule'
  | 'mcp-poll'
  | 'url-watch'
  /** Unpredictable timing — pinned left. */
  | 'webhook'
  | 'file-watch'
  /** Never a root; always a chain link resolved from a signal/completion. */
  | 'flow-event';

/**
 * A signal topic a chain node's bound flow can emit at runtime. Surfaced on the
 * card next to the subflow tree so producers show their signals (e.g.
 * `plan-available`, `produce-improvement`) even when no consumer edge exists
 * (#144).
 */
export interface WaveEmittedSignal {
  /** The emitted signal topic. */
  topic: string;
  /** True when one of the flow's OWN `signal` nodes emits it; false when the
   *  topic is only reachable through a statically-reachable subflow. */
  direct: boolean;
}

/** A statically-resolved subflow call, nested under a chain node. */
export interface WaveSubflowRef {
  flowId: string;
  flowName?: string;
  /** The referenced flow could not be found. */
  missing?: boolean;
  /** Nested subflow calls (recursive, depth-capped). */
  children: WaveSubflowRef[];
  /** A depth/cycle cap was hit while expanding this subtree. */
  truncated?: boolean;
}

/** How a chain node is timed / positioned on the canvas. */
export type WaveNodeTiming =
  | { mode: 'timeline'; nextRun: string | null; cron?: string }
  | { mode: 'fixed' }
  | { mode: 'event'; via: 'completion' | 'signal'; topic?: string };

/** One planned execution as it appears in a chain. */
export interface WaveChainNode {
  executionId: string;
  name: string;
  enabled: boolean;
  flowId: string;
  flowName?: string;
  triggerKind: WaveTriggerKind;
  /** True when the trigger is organic (starts a chain). */
  isRoot: boolean;
  timing: WaveNodeTiming;
  /** Statically-resolved subflow calls of the bound flow. */
  subflows: WaveSubflowRef[];
  /** Signal topics this node's bound flow can emit (direct + via subflow),
   *  sorted and de-duped. Additive field (#144). */
  emittedSignals: WaveEmittedSignal[];
}

/** A directed link between two chain nodes. */
export interface WaveChainEdge {
  fromExecutionId: string;
  toExecutionId: string;
  via: 'completion' | 'signal';
  /** Set when `via === 'signal'`. */
  topic?: string;
  /** Set when `via === 'completion'` — the terminal statuses that fire it. */
  on?: Array<'completed' | 'error'>;
}

/** A wave = a set of chains grouped for one canvas. */
export interface Wave {
  /** Deterministic id (root execution id, or a stable component key). */
  id: string;
  rootExecutionIds: string[];
  nodes: WaveChainNode[];
  edges: WaveChainEdge[];
  /** A cycle was detected among this wave's nodes (recursion, capped). */
  hasCycle: boolean;
}

/** The `GET /api/waves` response. */
export interface WavesResponse {
  paused: boolean;
  generatedAt: string;
  waves: Wave[];
  /** `flow-event` triggers whose source resolves to no known producer. */
  orphans: WaveChainNode[];
}

/** How the resolver groups chains into waves. */
export type WaveGrouping = 'per-root' | 'connected-component';

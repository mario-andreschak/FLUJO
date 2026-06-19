import { SharedState, PrepResult, ExecResult } from '../types';
import { EmitFn } from '@/shared/types/execution/events';

/**
 * Opaque handle to the node the engine resolved for the next step.
 * The concrete shape is engine-private (PocketFlow's BaseNode today); callers
 * must treat `handle` as opaque so the engine stays swappable.
 */
export interface ResolvedNode {
  handle: unknown;
  id: string;
  type: string;
  name: string;
}

export interface RunNodeResult {
  action: string;
  prepResult: PrepResult | undefined;
  execResult: ExecResult | undefined;
}

export interface HandoffResolution {
  /** True if `action` is an outgoing edge of the current node (i.e. a handoff). */
  isSuccessorEdge: boolean;
  /** The target node id for the handoff, or null if it cannot be determined. */
  targetNodeId: string | null;
  /** The target node's type (e.g. 'finish'), or null if it cannot be determined. */
  targetNodeType?: string | null;
}

/**
 * The seam between FLUJO's orchestration/transport layers and the underlying
 * graph-execution framework. Today this is backed by PocketflowEngine; the
 * interface exists so it can be replaced without touching FlowExecutor, the
 * API routes, or the UI.
 */
export interface FlowEngine {
  /**
   * Resolve which node should run next for the given state (resume by
   * currentNodeId, fall back to the last message's processNodeId, else the
   * start node). Throws if no runnable node can be determined.
   */
  resolveNode(sharedState: SharedState): Promise<ResolvedNode>;

  /**
   * Execute a single node. Mutates `sharedState` in place and may emit
   * fine-grained model/tool/handoff events through `emit`.
   */
  runNode(node: ResolvedNode, sharedState: SharedState, emit?: EmitFn): Promise<RunNodeResult>;

  /**
   * Determine whether `action` corresponds to a handoff edge leaving the
   * current node, and if so which node it targets. Used by the orchestration
   * loop to advance between process nodes.
   */
  resolveHandoff(sharedState: SharedState, action: string): Promise<HandoffResolution>;

  /** Drop cached/compiled flow definitions (e.g. after a flow is edited). */
  clearCache(flowId?: string): void;
}

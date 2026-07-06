import { createLogger } from '@/utils/logger';
import { SharedState, ERROR_ACTION, DebugStep, PrepResult, ExecResult } from './types';
import cloneDeep from 'lodash/cloneDeep'; // Import cloneDeep for snapshots
import { FEATURES } from '@/config/features'; // Import feature flags
import { FlowEngine } from './engine/FlowEngine';
import { PocketflowEngine } from './engine/PocketflowEngine';
import { EmitFn } from '@/shared/types/execution/events';

// Create a logger instance for this file
const log = createLogger('backend/execution/flow/FlowExecutor');

// The execution engine (and its compiled-flow cache) is global-backed so every
// module instance shares ONE engine. `clearFlowCache()` runs on a flow edit via
// flowService.saveFlow(); with a per-instance `static` engine that invalidation
// never reached the scheduler/startup instance, so scheduled runs kept executing
// a stale compiled flow until a process restart. Same cross-instance-coherence
// reasoning as the global-backed scheduler and MCP recovery maps.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_flow_engine: FlowEngine | undefined;
  // eslint-disable-next-line no-var
  var __flujo_conversation_states: Map<string, SharedState> | undefined;
}

// --- Debug snapshot slimming -------------------------------------------------
// Each debug step records a before/after state snapshot plus prep/exec results.
// Naively deep-cloning the whole SharedState made the trace grow quadratically:
// every step re-embedded the entire `messages` array (twice), the MCP tool
// schemas, and the raw provider response. Those are large, already shown
// elsewhere (chat panel / live state), and rarely needed at per-step
// granularity. We keep the small, interesting bits and a `messageCount` marker
// instead, so each step is roughly constant size regardless of conversation
// length.

/** Bulky or non-serializable fields stripped from prep/exec result snapshots
 *  ('emit' is the transient event callback a SubflowNode captures in prep). */
const HEAVY_RESULT_KEYS = ['messages', 'availableTools', 'fullResponse', 'emit'] as const;

/** Lightweight state snapshot: everything except the conversation/tool payloads. */
function slimStateSnapshot(state: SharedState): Partial<SharedState> {
  // Pull out the heavy / non-serializable members; deep-clone only the rest.
  const { messages, executionTrace, emit, mcpContext, ...rest } = state;
  const snap = cloneDeep(rest) as Partial<SharedState> & { messageCount?: number };
  snap.messageCount = messages?.length ?? 0; // keep size context without the payload
  if (mcpContext) {
    // Keep which server was in context, drop the (potentially huge) tool schemas.
    snap.mcpContext = { server: mcpContext.server, availableTools: [] };
  }
  return snap;
}

/** Clone a prep/exec result without its bulky duplicated payloads. */
function slimResultSnapshot<T>(result: T | undefined): T | undefined {
  if (!result || typeof result !== 'object') return result;
  const copy = cloneDeep(result) as Record<string, unknown>;
  for (const key of HEAVY_RESULT_KEYS) {
    if (key in copy) delete copy[key];
  }
  return copy as T;
}

/**
 * Engine-agnostic facade for step-by-step flow execution.
 *
 * FlowExecutor owns the cross-cutting concerns that are independent of the
 * underlying execution framework: the in-memory conversation-state map, the
 * debug execution trace, and (optionally) emitting node lifecycle events.
 * The actual graph traversal/node execution is delegated to a FlowEngine
 * (PocketflowEngine today) so the framework can be swapped without touching
 * the API routes or UI that depend on this class.
 */
export class FlowExecutor {
  // Store conversation states globally - accessible for step-by-step execution.
  //
  // Global-backed (via globalThis) so the scheduler/startup instance, the API-
  // route instance, and the global event-bus log tap (conversationLog's
  // isPersistable) all read/write ONE map. A per-instance `static` diverged
  // across Next.js module instances — the same cross-instance-coherence problem
  // fixed for the engine cache and the scheduler/MCP maps in commit c824a5b.
  // That divergence made the conversation-log tap drop every bus event of a
  // planned (saveConversations) run, so its .jsonl held only the turn-start
  // reconcile line and the transcript vanished on reload (issue #49).
  static get conversationStates(): Map<string, SharedState> {
    if (!global.__flujo_conversation_states) {
      global.__flujo_conversation_states = new Map<string, SharedState>();
    }
    return global.__flujo_conversation_states;
  }

  // The active execution engine. Replace the constructed engine to swap
  // frameworks. Global-backed (see the declare global above) so its compiled
  // flow cache is shared across module instances and clearFlowCache() is
  // coherent everywhere.
  private static get engine(): FlowEngine {
    if (!global.__flujo_flow_engine) {
      global.__flujo_flow_engine = new PocketflowEngine();
    }
    return global.__flujo_flow_engine;
  }
  // Writable so the engine can be swapped for another framework, and so tests can
  // stub it. The setter writes through to the shared global to keep every module
  // instance pointing at the one engine.
  private static set engine(value: FlowEngine) {
    global.__flujo_flow_engine = value;
  }

  /** Invalidate cached/compiled flow definitions (e.g. after a flow is edited). */
  static clearFlowCache(flowId?: string): void {
    this.engine.clearCache(flowId);
  }

  /**
   * Determine whether the given action is a handoff edge leaving the current
   * node, and if so the target node id. Delegates to the active engine so the
   * orchestration loop never touches the underlying graph framework.
   */
  static resolveHandoff(sharedState: SharedState, action: string) {
    return this.engine.resolveHandoff(sharedState, action);
  }

  /**
   * Resolve which node the next step *would* run, without executing it. Used to
   * evaluate breakpoints before a step. Returns null if resolution fails.
   */
  static async peekNextNodeId(sharedState: SharedState): Promise<string | null> {
    try {
      const node = await this.engine.resolveNode(sharedState);
      return node.id;
    } catch {
      return null;
    }
  }

  /**
   * Executes a single step of the flow based on the provided shared state.
   * Updates the shared state in the conversationStates map.
   * Returns the updated shared state and the action determined by the executed node.
   *
   * @param emit Optional callback for fine-grained execution events. When
   *   omitted (e.g. legacy callers), execution behaves exactly as before.
   */
  static async executeStep(sharedState: SharedState, emit?: EmitFn): Promise<{ sharedState: SharedState, action: string }> {
    const { conversationId, flowId, currentNodeId } = sharedState;

    // Ensure conversationId is valid before proceeding
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      log.error("executeStep called without a valid conversationId in sharedState.");
      sharedState.lastResponse = { success: false, error: "Internal error: Missing conversationId." };
      return { sharedState, action: ERROR_ACTION };
    }

    log.debug(`executeStep called for conversation ${conversationId}`, { flowId, currentNodeId });

    // Build the execution trace when globally enabled OR when this conversation
    // is in debug mode (so the visual debugger has data without forcing every
    // normal run to pay the per-step snapshot cost).
    const traceEnabled = FEATURES.ENABLE_EXECUTION_TRACKER || !!sharedState.debugMode;

    // Declare for access in catch block
    let stateBefore: Partial<SharedState> | undefined = undefined;
    let prepResult: PrepResult | undefined = undefined;
    let execResult: ExecResult | undefined = undefined;
    // Track the node we attempted, for error reporting. Seeded with the
    // resume target so an error during resolution still names a node.
    let attemptedNodeId: string | undefined = currentNodeId;

    try {
      // Resolve the node to run (resume / start) via the engine.
      const node = await this.engine.resolveNode(sharedState);
      attemptedNodeId = node.id;
      sharedState.currentNodeId = node.id;
      log.info(`Executing step for node ${node.id} (${node.type}) in conversation ${conversationId}`);

      // --- Initialize trace if needed (only if debug mode is enabled) ---
      if (traceEnabled && !sharedState.executionTrace) {
        sharedState.executionTrace = [];
      }

      // --- Capture state BEFORE execution (slimmed; see slimStateSnapshot) ---
      stateBefore = slimStateSnapshot(sharedState);

      emit?.({ type: 'node:enter', node: { nodeId: node.id, nodeName: node.name, nodeType: node.type } });

      // --- Execute the node via the engine (mutates sharedState in place) ---
      const runResult = await this.engine.runNode(node, sharedState, emit);
      const action = runResult.action;
      prepResult = runResult.prepResult;
      execResult = runResult.execResult;

      emit?.({ type: 'node:exit', node: { nodeId: node.id, nodeName: node.name, nodeType: node.type }, action });

      log.debug(`Node ${node.id} finished with action: ${action} for conversation ${conversationId}`);

      // --- Capture state AFTER execution (slimmed; see slimStateSnapshot) ---
      const stateAfter = slimStateSnapshot(sharedState);

      // --- Create and append DebugStep (only if debug mode is enabled) ---
      if (traceEnabled && sharedState.executionTrace) {
        const stepIndex = sharedState.executionTrace.length;
        const debugStep: DebugStep = {
          stepIndex,
          nodeId: node.id,
          nodeType: node.type as DebugStep['nodeType'],
          nodeName: node.name,
          timestamp: new Date().toISOString(),
          actionTaken: action,
          stateBefore,
          stateAfter,
          prepResultSnapshot: slimResultSnapshot(prepResult),
          execResultSnapshot: slimResultSnapshot(execResult),
        };
        sharedState.executionTrace.push(debugStep);
        log.verbose(`Appended step ${stepIndex} to execution trace for conversation ${conversationId}`);
      }

      // Update state in map *after* successful execution and trace update
      this.conversationStates.set(conversationId, sharedState);

      log.debug(`[FlowExecutor] Returning from executeStep for node ${node.id} with action: "${action}"`);
      return { sharedState, action };

    } catch (error) {
      const nodeIdentifier = attemptedNodeId || 'unknown node';
      log.error(`Error during node execution step for ${nodeIdentifier} in conversation ${conversationId}`, { error });

      // Model errors thrown by ProcessNode carry a `.details` payload (HTTP
      // status, provider code/type, retry hints, the raw provider body). Merge
      // it into errorDetails so downstream response formatting reports the
      // *real* failure (e.g. a 429 rate limit) instead of collapsing everything
      // to a generic 500/internal_error.
      const modelDetails = (error as any)?.details;
      sharedState.lastResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              ...(modelDetails && typeof modelDetails === 'object' ? modelDetails : {}),
            }
          : { message: String(error) }
      };
      // Keep track of where the error occurred
      sharedState.currentNodeId = attemptedNodeId;

      emit?.({
        type: 'error',
        node: attemptedNodeId ? { nodeId: attemptedNodeId } : undefined,
        message: error instanceof Error ? error.message : String(error),
      });

      // --- Add error step to trace (only if debug mode is enabled) ---
      if (traceEnabled && sharedState.executionTrace) {
        const stepIndex = sharedState.executionTrace.length;
        const errorStep: DebugStep = {
          stepIndex,
          nodeId: nodeIdentifier,
          nodeType: 'unknown' as DebugStep['nodeType'],
          nodeName: 'Unknown Node',
          timestamp: new Date().toISOString(),
          actionTaken: ERROR_ACTION,
          stateBefore: stateBefore ?? slimStateSnapshot(sharedState),
          stateAfter: slimStateSnapshot(sharedState),
          prepResultSnapshot: prepResult ? slimResultSnapshot(prepResult) : null,
          execResultSnapshot: { success: false, error: sharedState.lastResponse } as ExecResult,
        };
        sharedState.executionTrace.push(errorStep);
        log.verbose(`Appended ERROR step ${stepIndex} to execution trace for conversation ${conversationId}`);
      }

      // Update state map with error state
      this.conversationStates.set(conversationId, sharedState);

      return { sharedState, action: ERROR_ACTION };
    }
  }
}

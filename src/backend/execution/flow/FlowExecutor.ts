import { createLogger } from '@/utils/logger';
import { SharedState, ERROR_ACTION, DebugStep, PrepResult, ExecResult } from './types';
import cloneDeep from 'lodash/cloneDeep'; // Import cloneDeep for snapshots
import { FEATURES } from '@/config/features'; // Import feature flags
import { FlowEngine } from './engine/FlowEngine';
import { PocketflowEngine } from './engine/PocketflowEngine';
import { EmitFn } from '@/shared/types/execution/events';

// Create a logger instance for this file
const log = createLogger('backend/execution/flow/FlowExecutor');

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
  // Store conversation states globally - accessible for step-by-step execution
  public static conversationStates = new Map<string, SharedState>();

  // The active execution engine. Replace this single line to swap frameworks.
  private static engine: FlowEngine = new PocketflowEngine();

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
      if (FEATURES.ENABLE_EXECUTION_TRACKER && !sharedState.executionTrace) {
        sharedState.executionTrace = [];
      }

      // --- Capture state BEFORE execution ---
      stateBefore = cloneDeep(sharedState);
      if (stateBefore) {
        delete stateBefore.executionTrace; // Avoid recursive trace in snapshot
      }

      emit?.({ type: 'node:enter', node: { nodeId: node.id, nodeName: node.name, nodeType: node.type } });

      // --- Execute the node via the engine (mutates sharedState in place) ---
      const runResult = await this.engine.runNode(node, sharedState, emit);
      const action = runResult.action;
      prepResult = runResult.prepResult;
      execResult = runResult.execResult;

      emit?.({ type: 'node:exit', node: { nodeId: node.id, nodeName: node.name, nodeType: node.type }, action });

      log.debug(`Node ${node.id} finished with action: ${action} for conversation ${conversationId}`);

      // --- Capture state AFTER execution ---
      const stateAfter = cloneDeep(sharedState);
      delete stateAfter.executionTrace; // Avoid recursive trace in snapshot

      // --- Create and append DebugStep (only if debug mode is enabled) ---
      if (FEATURES.ENABLE_EXECUTION_TRACKER && sharedState.executionTrace) {
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
          prepResultSnapshot: cloneDeep(prepResult),
          execResultSnapshot: cloneDeep(execResult),
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

      // Ensure sharedState reflects the error
      sharedState.lastResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
      };
      // Keep track of where the error occurred
      sharedState.currentNodeId = attemptedNodeId;

      emit?.({
        type: 'error',
        node: attemptedNodeId ? { nodeId: attemptedNodeId } : undefined,
        message: error instanceof Error ? error.message : String(error),
      });

      // --- Add error step to trace (only if debug mode is enabled) ---
      if (FEATURES.ENABLE_EXECUTION_TRACKER && sharedState.executionTrace) {
        const stepIndex = sharedState.executionTrace.length;
        const errorStep: DebugStep = {
          stepIndex,
          nodeId: nodeIdentifier,
          nodeType: 'unknown' as DebugStep['nodeType'],
          nodeName: 'Unknown Node',
          timestamp: new Date().toISOString(),
          actionTaken: ERROR_ACTION,
          stateBefore: stateBefore ? cloneDeep(stateBefore) : cloneDeep(sharedState),
          stateAfter: cloneDeep(sharedState),
          prepResultSnapshot: prepResult ? cloneDeep(prepResult) : null,
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

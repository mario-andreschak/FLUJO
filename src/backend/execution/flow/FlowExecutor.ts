import { Flow as PocketFlow, BaseNode } from './temp_pocket';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from './FlowConverter';
import { createLogger } from '@/utils/logger';
import { FlowExecutionResponse, SuccessResult, ErrorResult } from '@/shared/types/flow/response';
import { SharedState, FlowParams, STAY_ON_NODE_ACTION, TOOL_CALL_ACTION, FINAL_RESPONSE_ACTION, ERROR_ACTION } from './types'; // Import action constants
import OpenAI from 'openai';

// Create a logger instance for this file
const log = createLogger('backend/execution/flow/FlowExecutor');

export class FlowExecutor {
  // Store conversation states globally - accessible for step-by-step execution
  public static conversationStates = new Map<string, SharedState>();

  /**
   * Helper function to load React Flow and convert it to Pocket Flow.
   * Includes basic caching for the Pocket Flow conversion.
   */
  private static pocketFlowCache = new Map<string, PocketFlow>();
  private static async loadAndConvertFlow(flowId: string): Promise<PocketFlow> {
    if (this.pocketFlowCache.has(flowId)) {
      log.debug(`Using cached Pocket Flow for flowId: ${flowId}`);
      // Return a clone to prevent modification of the cached instance
      return this.pocketFlowCache.get(flowId)!.clone() as PocketFlow;
    }

    log.debug(`Loading and converting flow for flowId: ${flowId}`);
    const reactFlow = await flowService.getFlow(flowId);
    if (!reactFlow) {
      log.error(`Flow not found for flowId: ${flowId}`);
      throw new Error(`Flow not found: ${flowId}`);
    }

    log.info(`Found flow: ${reactFlow.name}`, {
      flowId: reactFlow.id,
      nodeCount: reactFlow.nodes.length,
      edgeCount: reactFlow.edges.length
    });

    const pocketFlow = FlowConverter.convert(reactFlow);
    this.pocketFlowCache.set(flowId, pocketFlow); // Cache the converted flow
    log.debug(`Flow ${flowId} converted and cached.`);
    // Return a clone for execution
    return pocketFlow.clone() as PocketFlow;
  }

  /**
   * Helper function to find a node within a Pocket Flow by its ID using BFS.
   * Expects a valid string nodeId as it's checked before calling.
   */
  private static async findNodeById(flow: PocketFlow, nodeId: string): Promise<BaseNode | undefined> { // Signature already expects string
    log.debug(`Searching for node ${nodeId} in flow ${flow.node_params?.id}`);
    const startNode = await flow.getStartNode();
    const queue: BaseNode[] = [startNode];
    const visited = new Set<string>();
    // Ensure startNode ID is valid before adding
    const startNodeId = startNode.node_params?.id;
    if (startNodeId) {
        visited.add(startNodeId);
    } else {
        log.warn("Start node is missing an ID in its parameters.");
        // Depending on requirements, might need to throw an error here
    }


    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      const currentId = currentNode.node_params?.id;

      if (currentId === nodeId) {
        log.debug(`Found node ${nodeId}`);
        return currentNode;
      }

      // Add successors to the queue
      if (currentNode.successors instanceof Map) {
        for (const successor of currentNode.successors.values()) {
          const successorId = successor.node_params?.id;
          // Ensure successorId is a valid string before adding
          if (typeof successorId === 'string' && successorId.length > 0 && !visited.has(successorId)) {
            visited.add(successorId);
            // Clone successor before adding to queue to maintain state isolation if needed later
            queue.push(successor.clone());
          }
        }
      }
    }

    log.warn(`Node ${nodeId} not found in flow.`);
    return undefined;
  }

  /**
   * Executes a single step of the flow based on the provided shared state.
   * Updates the shared state in the conversationStates map.
   * Returns the updated shared state and the action determined by the executed node.
   */
  static async executeStep(sharedState: SharedState): Promise<{ sharedState: SharedState, action: string }> {
    const { conversationId, flowId, currentNodeId } = sharedState;

    // Ensure conversationId is valid before proceeding
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
        log.error("executeStep called without a valid conversationId in sharedState.");
        // Cannot proceed without a conversationId to store state
        sharedState.lastResponse = { success: false, error: "Internal error: Missing conversationId." };
        // Cannot update map without ID, so just return the error state
        return { sharedState, action: ERROR_ACTION };
    }

    log.debug(`executeStep called for conversation ${conversationId}`, { flowId, currentNodeId });

    let currentNode: BaseNode | undefined;
    let pocketFlow: PocketFlow;

    try {
      pocketFlow = await this.loadAndConvertFlow(flowId);

      // Find the current node to execute
      if (currentNodeId) {
        currentNode = await this.findNodeById(pocketFlow, currentNodeId);
        if (!currentNode) {
          log.warn(`Resuming conversation ${conversationId}, but node ${currentNodeId} not found. Starting from beginning.`);
          // Fallback to start node if specified node not found
          currentNode = await pocketFlow.getStartNode();
        } else {
           log.info(`Resuming conversation ${conversationId} at node ${currentNodeId}`);
        }
      } else {
        // Start from the beginning if no currentNodeId is set
        currentNode = await pocketFlow.getStartNode();
        log.info(`Starting conversation ${conversationId} from the beginning.`);
      }

      if (!currentNode) {
        log.error(`Could not determine current node for execution in conversation ${conversationId}.`);
        sharedState.lastResponse = { success: false, error: "Execution error: Cannot find starting node." };
        this.conversationStates.set(conversationId, sharedState); // Update state map
        return { sharedState, action: ERROR_ACTION };
      }

      const nodeId = currentNode.node_params?.id;
      // Ensure nodeId is a valid string before assigning to state and logging
      if (typeof nodeId !== 'string' || nodeId.length === 0) {
          log.error(`Node ${currentNode.constructor.name} is missing a valid ID in its parameters.`);
          sharedState.lastResponse = { success: false, error: `Execution error: Node ${currentNode.constructor.name} is missing an ID.` };
          this.conversationStates.set(conversationId, sharedState);
          return { sharedState, action: ERROR_ACTION };
      }
      log.info(`Executing step for node ${nodeId} (${currentNode.constructor.name}) in conversation ${conversationId}`);
      sharedState.currentNodeId = nodeId; // Now guaranteed to be a string

      // --- Execute the node's run method ---
      const action = await currentNode.run(sharedState);
      // --- Node execution finished ---

      log.info(`Node ${nodeId} finished with action: ${action} for conversation ${conversationId}`);

      // Update state in map *after* successful execution
      this.conversationStates.set(conversationId, sharedState);

      return { sharedState, action };

    } catch (error) {
      const nodeIdentifier = currentNode?.node_params?.id || currentNodeId || 'unknown node';
      log.error(`Error during node execution step for ${nodeIdentifier} in conversation ${conversationId}`, { error });

      // Ensure sharedState reflects the error
      sharedState.lastResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
      };
      // Assign the ID of the node that was *attempted* (which is stored in the scope's currentNodeId)
      sharedState.currentNodeId = currentNodeId;

      // Update state map with error state (conversationId is guaranteed to be a string here)
      this.conversationStates.set(conversationId, sharedState);

      return { sharedState, action: ERROR_ACTION };
    }
  }

  // Optional: Keep executeFlow for potential backward compatibility or specific use cases,
  // but mark it as deprecated or adapt it to use executeStep internally if needed.
  /**
   * @deprecated Use the step-by-step execution via chatCompletionService.
   * Original method to execute a full flow.
   */
  static async executeFlow(flowName: string, options?: {
    messages?: OpenAI.ChatCompletionMessageParam[],
    conversationId?: string
  }): Promise<FlowExecutionResponse> {
     log.warn("DEPRECATED: FlowExecutor.executeFlow is called. Prefer step-by-step execution.");

     // Simplified implementation using the old logic for demonstration/fallback
     // This does NOT use the new executeStep logic.
     log.info(`Executing flow (Deprecated): ${flowName}`, { /* ... */ });
     // Pass flowName directly, assuming it acts as the ID for loading/conversion in this deprecated context.
     const pocketFlow = await this.loadAndConvertFlow(flowName);

     let sharedState: SharedState;
     const conversationId = options?.conversationId || crypto.randomUUID();

     if (options?.conversationId && this.conversationStates.has(options.conversationId)) {
       sharedState = this.conversationStates.get(options.conversationId)!;
       // Simplified state update - real implementation would need more care
       if (options?.messages) sharedState.messages.push(...options.messages);
     } else {
       sharedState = {
         trackingInfo: { executionId: crypto.randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
         messages: options?.messages || [],
         flowId: pocketFlow.node_params?.id || flowName, // Adjust as needed
         conversationId,
       };
       this.conversationStates.set(conversationId, sharedState);
     }

     try {
       await pocketFlow.run(sharedState); // Run the entire flow (old behavior)
       // Format and return success response based on final sharedState
       const hasError = typeof sharedState.lastResponse === 'object' && sharedState.lastResponse?.success === false;
       return {
         success: !hasError,
         result: sharedState.lastResponse as any, // Simplify result typing
         messages: sharedState.messages,
         executionTime: Date.now() - sharedState.trackingInfo.startTime,
         nodeExecutionTracker: sharedState.trackingInfo.nodeExecutionTracker,
         conversationId: sharedState.conversationId,
         // toolCalls: ... // Simplified, old logic might not populate this correctly
       };
     } catch (error) {
       // Format and return error response
       return {
         success: false,
         result: { success: false, error: error instanceof Error ? error.message : String(error) } as ErrorResult,
         messages: sharedState.messages,
         executionTime: Date.now() - sharedState.trackingInfo.startTime,
         nodeExecutionTracker: sharedState.trackingInfo.nodeExecutionTracker,
         conversationId: sharedState.conversationId,
       };
     }
   }
}

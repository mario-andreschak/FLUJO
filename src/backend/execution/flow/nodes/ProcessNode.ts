// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { ToolHandler } from '../handlers/ToolHandler';
import { ModelHandler } from '../handlers/ModelHandler';
import { FEATURES } from '@/config/features'; // Import feature flags
import {
  SharedState,
  ProcessNodeParams,
  ProcessNodePrepResult,
  ProcessNodeExecResult,
  ToolDefinition,
  HandoffToolInfo,
  STAY_ON_NODE_ACTION, // Keep for reference, but won't be returned directly by post
  TOOL_CALL_ACTION,    // Import new actions
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
  ToolCallInfo
} from '../types';
import { FlujoChatMessage } from '@/shared/types/chat'; // Import FlujoChatMessage
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid'; // Import uuid

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/ProcessNode');

export class ProcessNode extends BaseNode {
  /**
   * Generate handoff tools for each connected non-MCP node
   */
  private generateHandoffTools(): ToolDefinition[] {
    log.info('Generating handoff tools');

    const handoffTools: ToolDefinition[] = [];

    // Get all actions (edge IDs)
    const allActions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});

    // Filter out MCP edges - only keep standard edges for flow navigation
    const actions = allActions.filter(action =>
      !action.includes('-mcpEdge') &&
      !action.endsWith('mcpEdge') &&
      !action.includes('-mcp')
    );

    log.debug('Found standard actions for handoff tools', {
      actionsCount: actions.length,
      actions
    });

    // Create a handoff tool for each action
    actions.forEach(edgeId => {
      // Get the target node
      const targetNode = this.successors instanceof Map
        ? this.successors.get(edgeId)
        : (this.successors as any)[edgeId];

      if (!targetNode) {
        log.warn(`Target node not found for edge ${edgeId}`);
        return;
      }

      const targetNodeId = targetNode.node_params?.id || 'unknown';
      const targetNodeLabel = targetNode.node_params?.label || 'Unknown Node';
      const targetNodeType = targetNode.node_params?.type || 'unknown';

      // Create a handoff tool for this edge
      const handoffTool: ToolDefinition = {
        name: `handoff_to_${targetNodeId}`,
        description: `Hand off execution to ${targetNodeLabel} (${targetNodeType})`,
        inputSchema: {
          type: "object",
          properties: {}, // No parameters needed anymore
          required: []
        }
      };

      handoffTools.push(handoffTool);

      log.debug(`Created handoff tool for edge ${edgeId}`, {
        toolName: handoffTool.name,
        targetNodeId,
        targetNodeLabel
      });
    });

    // Removed the generic handoff tool creation block

    log.info('Generated handoff tools', {
      toolsCount: handoffTools.length
    });

    return handoffTools;
  }

  async prep(sharedState: SharedState, node_params?: ProcessNodeParams): Promise<ProcessNodePrepResult> {
    log.info('prep() started');

    // Extract properties from node_params
    const nodeId = node_params?.id;
    const flowId = sharedState.flowId;
    const boundModel = node_params?.properties?.boundModel;
    const excludeModelPrompt = node_params?.properties?.excludeModelPrompt || false;
    const excludeStartNodePrompt = node_params?.properties?.excludeStartNodePrompt || false;

    log.debug('Extracted properties', {
      nodeId,
      flowId,
      boundModel,
      excludeModelPrompt,
      excludeStartNodePrompt
    });

    if (!nodeId || !flowId) {
      log.error('Missing required node or flow ID', { nodeId, flowId });
      throw new Error("Process node requires node ID and flow ID");
    }

    if (!boundModel) {
      log.error('Missing bound model');
      throw new Error("Process node requires a bound model");
    }

    // Use the promptRenderer to build the complete prompt
    log.info('Using promptRenderer to build the complete prompt');
    const completePrompt = await promptRenderer.renderPrompt(flowId, nodeId, {
      renderMode: 'rendered',
      includeConversationHistory: false,
      excludeModelPrompt,
      excludeStartNodePrompt
    });

    log.debug('Prompt rendered successfully', {
      completePromptLength: completePrompt.length,
      completePromptPreview: completePrompt.length > 100 ?
        completePrompt.substring(0, 100) + '...' : completePrompt
    });

    // Set the current node ID in shared state
    sharedState.currentNodeId = nodeId;

    // Check if tools are already available in shared state
    let availableTools: ToolDefinition[] = [];

    if (sharedState.mcpContext && sharedState.mcpContext.availableTools && sharedState.mcpContext.availableTools.length > 0) {
      // Use tools already processed by MCPNode
      log.info('Using MCP tools from shared state', {
        toolsCount: sharedState.mcpContext.availableTools.length
      });
      availableTools = sharedState.mcpContext.availableTools;
    } else {
      // Only process MCP nodes if tools are not available in shared state
      const mcpNodes = node_params?.properties?.mcpNodes || [];

      if (mcpNodes.length > 0) {
        log.info('No MCP tools found in shared state, processing MCP nodes', {
          mcpNodesCount: mcpNodes.length
        });

        // Process MCP nodes using the ToolHandler
        const mcpResult = await ToolHandler.processMCPNodes({ mcpNodes });

        if (!mcpResult.success) {
          log.error('Failed to process MCP nodes', { error: mcpResult.error });
          throw new Error(`Failed to process MCP nodes: ${mcpResult.error.message}`);
        }

        availableTools = mcpResult.value.availableTools;
      }
    }

    // Generate handoff tools for each connected non-MCP node
    const handoffTools = this.generateHandoffTools();

    // Add handoff tools to available tools
    availableTools = [...availableTools, ...handoffTools];

  // Create a properly typed PrepResult
  const prepResult: ProcessNodePrepResult = {
    nodeId,
    nodeType: 'process',
    currentPrompt: completePrompt,
    boundModel,
    availableTools: availableTools,
    messages: [] // Will be populated after reordering
  };

    // Reorder messages to ensure system messages are at the top
    // Extract non-system messages (already FlujoChatMessage type from sharedState)
    const nonSystemMessages: FlujoChatMessage[] = [];

    // Copy and categorize messages
    sharedState.messages.forEach((msg: FlujoChatMessage) => { // Ensure msg is typed correctly
      if (msg.role !== 'system') {
        nonSystemMessages.push(msg);
      }
    });

    // Create our own system message with the current prompt as FlujoChatMessage
    const systemMessage: FlujoChatMessage = {
      id: uuidv4(), // Generate unique ID
      role: 'system',
      content: completePrompt,
      timestamp: Date.now() // Add timestamp
    };

    log.info('Added system message from prompt template', {
      contentLength: completePrompt.length,
      contentPreview: completePrompt.length > 100 ?
        completePrompt.substring(0, 100) + '...' : completePrompt
    });

    // Combine messages with our system message first, then non-system messages
    prepResult.messages = [systemMessage, ...nonSystemMessages];

    log.info('Reordered messages with system messages at the top', {
      systemMessageCount: 1, // We now have exactly one system message
      nonSystemMessageCount: nonSystemMessages.length,
      totalMessageCount: prepResult.messages.length
    });

    log.info('prep() completed', {
      completePromptLength: completePrompt.length,
      boundModel,
      hasTools: !!prepResult.availableTools?.length,
      toolsCount: prepResult.availableTools?.length || 0,
      messagesCount: prepResult.messages.length
    });

    return prepResult;
  }

  async execCore(prepResult: ProcessNodePrepResult, node_params?: ProcessNodeParams): Promise<ProcessNodeExecResult> {
    log.info('execCore() started', {
      boundModel: prepResult.boundModel,
      promptLength: prepResult.currentPrompt?.length,
      messagesCount: prepResult.messages?.length || 0
    });

    // Add verbose logging of the entire prepResult
    log.debug('execCore() prepResult', JSON.stringify(prepResult));

    try {
      // Prepare tools if available
      let tools = undefined;

      if (prepResult.availableTools && prepResult.availableTools.length > 0) {
        const toolsResult = ToolHandler.prepareTools({
          availableTools: prepResult.availableTools
        });

        if (!toolsResult.success) {
          log.error('Failed to prepare tools', { error: toolsResult.error });
          throw new Error(`Failed to prepare tools: ${toolsResult.error.message}`);
        }

        tools = toolsResult.value.tools;
      }

      // Get the node name for display
      const nodeName = node_params?.label || node_params?.properties?.name || 'Process Node';

      // Call the model with tool support
      const modelResult = await ModelHandler.callModel({
        modelId: prepResult.boundModel,
        prompt: prepResult.currentPrompt,
        messages: prepResult.messages,
        tools,
        iteration: 1, // Iteration is no longer handled by ModelHandler, but keep for now
        maxIterations: 30, // Max iterations no longer handled by ModelHandler
        nodeName, // Pass the node name to be included in the response header
        nodeId: prepResult.nodeId // Pass the node ID
      });

    if (!modelResult.success) {
      log.error('Model execution error', { error: modelResult.error });

      // CHANGE: Instead of returning an error result, throw a custom error
      const modelError = new Error(`Model execution failed: ${modelResult.error.message}`);

      // Add properties to the error object
      (modelError as any).isModelError = true;
      (modelError as any).details = {
        message: modelResult.error.message,
        type: modelResult.error.type,
        code: modelResult.error.code,
        // Only include modelId if it exists
        ...(modelResult.error.type === 'model' ? { modelId: modelResult.error.modelId } : {}),
        param: typeof modelResult.error.details?.param === 'string' ? modelResult.error.details.param : undefined,
        status: typeof modelResult.error.details?.status === 'number' ? modelResult.error.details.status : undefined,
        // Include all other details from the original error
        ...modelResult.error.details
      };

      // Log that we're throwing a critical error
      log.error('Throwing critical model error to abort flow execution', {
        error: modelResult.error.message,
        type: modelResult.error.type,
        code: modelResult.error.code
      });

      // Throw the error to abort execution
      throw modelError;
      }

      const result = modelResult.value;

      // Create a properly typed ExecResult
      const execResult: ProcessNodeExecResult = {
        success: true,
        content: result.content || '',
        messages: result.messages, // Messages updated during tool calls
        fullResponse: result.fullResponse,
        toolCalls: result.toolCalls
      };

      // Log tool calls if present
      if (result.toolCalls && result.toolCalls.length > 0) {
        log.info('Tool calls found in model response', {
          toolCallsCount: result.toolCalls.length,
          toolNames: result.toolCalls.map(tc => tc.name).join(', ')
        });
      }

      log.info('execCore() completed', {
        responseLength: execResult.content?.length || 0,
        messagesCount: execResult.messages?.length || 0,
        hasToolCalls: !!execResult.toolCalls?.length
      });

      // Add verbose logging of the entire execResult
      log.verbose('execCore() execResult', JSON.stringify(execResult));

      return execResult;
    } catch (error) {
    // For critical tool errors or model errors, we want to rethrow them
    // to abort the flow execution
    if (error && typeof error === 'object' &&
        ('isCriticalToolError' in error || 'isModelError' in error)) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.error('Critical error detected - propagating to abort flow:', {
        error: errorMessage,
        isModelError: 'isModelError' in error,
        isCriticalToolError: 'isCriticalToolError' in error
      });

      // Rethrow the error to stop execution and propagate to the frontend
      throw error;
      }

      // For other errors, create an error result
      const errorResult: ProcessNodeExecResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack
        } : { message: String(error) }
      };

      log.error('execCore() failed', {
        error: errorResult.error,
        errorDetails: errorResult.errorDetails
      });

      // Add verbose logging of the error result
      log.verbose('execCore() errorResult', JSON.stringify(errorResult));

      return errorResult;
    }
  }

  /**
   * Process tool calls to check for handoff requests
   */
  private processHandoffToolCalls(
    toolCalls: ToolCallInfo[] | undefined,
    sharedState: SharedState
  ): boolean {
    if (!toolCalls || toolCalls.length === 0) {
      return false;
    }

    log.info('Processing tool calls for handoff requests', {
      toolCallsCount: toolCalls.length
    });

    // Get all actions (edge IDs)
    const allActions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});

    // Filter out MCP edges - only keep standard edges for flow navigation
    const actions = allActions.filter(action =>
      !action.includes('-mcpEdge') &&
      !action.endsWith('mcpEdge') &&
      !action.includes('-mcp')
    );

    // Check for handoff tool calls
    for (const toolCall of toolCalls) {
      const { name } = toolCall; // Only need the name now

      // Check for specific handoff tools
      if (name.startsWith('handoff_to_')) {
        // Extract target node ID from tool name
        const targetNodeId = name.replace('handoff_to_', '');

        // Find the edge ID that leads to this node
        for (const edgeId of actions) {
          const targetNode = this.successors instanceof Map
            ? this.successors.get(edgeId)
            : (this.successors as any)[edgeId];

          if (targetNode && targetNode.node_params?.id === targetNodeId) {
            // Set handoff request in shared state
            sharedState.handoffRequested = {
              edgeId,
              targetNodeId
            };

            log.info(`Handoff requested to node ${targetNodeId}`, {
              edgeId,
              toolName: name
            });

            return true; // Handoff confirmed by calling the tool
          }
        } // End inner loop (edgeId)
      } // End if (name.startsWith...)
    } // End outer loop (toolCall)

    return false; // No handoff tool call found
  }

  async post(
    prepResult: ProcessNodePrepResult,
    execResult: ProcessNodeExecResult,
    sharedState: SharedState,
    node_params?: ProcessNodeParams
  ): Promise<string> {
    log.info('post() started', {
      execResultSuccess: execResult.success,
      execResultContentLength: execResult.content?.length || 0,
      messagesCount: execResult.messages?.length || 0,
      toolCallsCount: execResult.toolCalls?.length || 0
    });

    // Store the model response or error in shared state
    if (!execResult.success) {
      // Store error information in shared state
      sharedState.lastResponse = {
        success: false,
        error: execResult.error,
        errorDetails: execResult.errorDetails
      };
      // Add tracking info (as before)
      if (Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
        // ... (tracking logic remains the same) ...
      }
      log.warn(`Execution failed for node ${node_params?.id}. Returning ERROR_ACTION.`);
      return ERROR_ACTION; // Return error action
    } else {
       // Use the content from execResult which might include prefixes
       sharedState.lastResponse = execResult.content || '';
    }

    // Update shared state with messages from execResult
    if (execResult.messages && execResult.messages.length > 0) {
      // Replace messages in shared state with the updated messages
      sharedState.messages = execResult.messages;

      log.info('Updated messages in sharedState', {
        messagesCount: sharedState.messages.length
      });
    }

    // Add tracking information for the ProcessNode itself
    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'ProcessNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Process Node',
        modelDisplayName: prepResult.modelDisplayName || 'Unknown Model', // Note: modelDisplayName might not be in prepResult, adjust if needed
        modelTechnicalName: prepResult.boundModel || 'unknown',
        allowedTools: node_params?.properties?.allowedTools?.join(', '),
        timestamp: new Date().toISOString()
      });

      log.info('Added ProcessNode tracking information', {
        modelDisplayName: prepResult.modelDisplayName, // Adjust if needed
        modelTechnicalName: prepResult.boundModel
      });
    }

    // Process tool calls to check for handoff requests FIRST
    const handoffRequested = this.processHandoffToolCalls(execResult.toolCalls, sharedState); // Uses the modified processHandoffToolCalls
    if (handoffRequested && sharedState.handoffRequested) {
      const edgeId = sharedState.handoffRequested.edgeId;
      log.info(`Handoff requested via tool call, returning edge ID: ${edgeId}`);
      // The service layer will clear sharedState.handoffRequested after transition
      return edgeId; // Return the edgeId as the action for handoff
    }

    // If no handoff, check for other tool calls (excluding handoff tools already processed)
    const nonHandoffToolCalls = execResult.toolCalls?.filter(tc => !tc.name.startsWith('handoff_to_'));
    if (nonHandoffToolCalls && nonHandoffToolCalls.length > 0) {
      log.info('Non-handoff tool calls detected, returning TOOL_CALL_ACTION');
      return TOOL_CALL_ACTION; // Return tool call action
    }

    // If no error, no handoff, and no other tool calls, it's a final response for this step
    log.info('No tool calls or handoff requested, returning FINAL_RESPONSE_ACTION');
    return FINAL_RESPONSE_ACTION; // Return final response action
  }

  _clone(): BaseNode {
    return new ProcessNode();
  }
}

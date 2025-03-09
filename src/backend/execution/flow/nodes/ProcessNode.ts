// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { ProcessNodeToolHandler } from './handlers/ProcessNodeToolHandler';
import { ProcessNodeModelHandler } from './handlers/ProcessNodeModelHandler';
import { ProcessNodeUtility } from './util/ProcessNodeUtility';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/ProcessNode');

export class ProcessNode extends BaseNode {
  async prep(sharedState: any, node_params?: any): Promise<any> {
    log.info('prep() started');

    // Extract properties from node_params
    const nodeId = node_params?.id;
    const flowId = sharedState.flowId; // Flow ID should be available in shared state
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
    
    // Store in shared state
    sharedState.currentPrompt = completePrompt;
    sharedState.boundModel = boundModel;
    
    // Process MCP nodes if available
    const mcpNodes = node_params?.properties?.mcpNodes || [];
    await ProcessNodeToolHandler.processMCPNodes(mcpNodes, sharedState);
    
    log.info('prep() completed', { 
      completePromptLength: completePrompt.length,
      completePromptPreview: completePrompt.length > 100 ? 
        completePrompt.substring(0, 100) + '...' : completePrompt,
      boundModel,
      hasTools: !!sharedState.availableTools
    });
    
    // Initialize message history if it doesn't exist
    sharedState.messages = sharedState.messages || [];
    
    // Add system message if it doesn't exist
    ProcessNodeModelHandler.addMessageToState(
      sharedState,
      "system",
      completePrompt,
      "SystemMessage"
    );
    
    // Add user message if available
    if (sharedState.inputUserMessage) {
      ProcessNodeModelHandler.addMessageToState(
        sharedState,
        "user",
        sharedState.inputUserMessage,
        "UserMessage"
      );
    }
    
    return sharedState;
  }


  async execCore(prepResult: any, node_params?: any): Promise<any> {
    log.info('execCore() started', {
      boundModel: prepResult.boundModel,
      promptLength: prepResult.currentPrompt?.length,
      messagesCount: prepResult.messages?.length || 0
    });
    
    const boundModel = prepResult.boundModel;
    const prompt = prepResult.currentPrompt;
    const messages = prepResult.messages || [];
    
    if (!boundModel) {
      log.error('Missing bound model');
      throw new Error("Process node requires a bound model");
    }
    
    try {
      // Prepare tools if available
      const tools = ProcessNodeToolHandler.prepareTools(prepResult);
      
      // Call the model with tool support
      const result = await ProcessNodeModelHandler.callModelWithToolSupport(
        boundModel,
        prompt,
        messages,
        prepResult,
        tools,
        1, // Start with iteration 1
        30  // Maximum 30 iterations to prevent infinite loops
      );
      
      log.info('execCore() completed', {
        responseLength: result.content?.length || 0,
        messagesCount: prepResult.messages?.length || 0,
        hasToolCalls: !!prepResult.toolCalls
      });
      
      return result.content || '';
    } catch (error) {
      // For critical tool errors, we want to rethrow them with a special error type
      // that will be caught by the FlowExecutor and properly displayed to the user
      if (error && typeof error === 'object' && 'isCriticalToolError' in error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        log.error('Critical tool error detected - propagating to frontend:', {
          error: errorMessage
        });
        
        // Create a new error with a clear message that will be displayed to the user
        const criticalError = new Error(`CRITICAL TOOL ERROR: ${errorMessage}`);
        
        // Add tracking info before rethrowing
        if (Array.isArray(prepResult.nodeExecutionTracker)) {
          prepResult.nodeExecutionTracker.push({
            nodeType: 'CriticalToolError',
            error: errorMessage,
            timestamp: new Date().toISOString()
          });
        }
        
        // Rethrow the error to stop execution and propagate to the frontend
        throw criticalError;
      }
      
      // For other errors, rethrow
      throw error;
    }
  }

  async post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string> {
    log.info('post() started', { 
      prepResultKeys: Object.keys(prepResult || {}),
      execResultLength: execResult?.length || 0,
      prepResultMessagesCount: prepResult.messages?.length || 0
    });
    
    // Store the model response in shared state
    sharedState.lastResponse = execResult;
    
    // Update shared state with messages from prepResult
    if (prepResult.messages && prepResult.messages.length > 0) {
      // Initialize message history if it doesn't exist
      sharedState.messages = sharedState.messages || [];
      
      log.info('Merging messages from prepResult to sharedState', {
        prepResultMessagesCount: prepResult.messages.length,
        sharedStateMessagesCount: sharedState.messages.length
      });
      
      // Merge messages from prepResult that aren't already in sharedState
      for (const message of prepResult.messages) {
        // Simple check to avoid duplicates - this could be enhanced for more complex scenarios
        const messageExists = sharedState.messages.some(
          (m: any) => m.role === message.role && m.content === message.content
        );
        
        if (!messageExists) {
          sharedState.messages.push(message);
          log.debug('Added message to sharedState', {
            role: message.role,
            contentPreview: message.content.length > 50 ? 
              message.content.substring(0, 50) + '...' : message.content
          });
        }
      }
    }
    
    // Add tracking information for the ProcessNode itself
    ProcessNodeModelHandler.addNodeExecutionTracking(sharedState, node_params);
    
    log.info('post() completed', { 
      messagesCount: sharedState.messages?.length || 0
    });
    
    // Get the successors for this node
    
    // Log the successors object for debugging
    log.info('Successors object:', {
      hasSuccessors: !!this.successors,
      isMap: this.successors instanceof Map,
      type: typeof this.successors
    });
    
    // Handle successors as a Map (which is what PocketFlowFramework uses)
    const actions = this.successors instanceof Map 
      ? Array.from(this.successors.keys()) 
      : Object.keys(this.successors || {});
    
    // Log the actions for debugging
    log.info('Actions:', {
      actionsCount: actions.length,
      actions: actions
    });
    if (actions.length > 0) {
      // Return the first available action
      const action = actions[0];
      log.info(`Returning action: ${action}`);
      return action;
    }
    
    return "default"; // Default fallback
  }

  _clone(): BaseNode {
    return new ProcessNode();
  }
}

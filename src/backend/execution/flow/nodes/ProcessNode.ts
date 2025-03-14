// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { ToolHandler } from '../handlers/ToolHandler';
import { ModelHandler } from '../handlers/ModelHandler';
import { 
  SharedState, 
  ProcessNodeParams, 
  ProcessNodePrepResult, 
  ProcessNodeExecResult,
  ToolDefinition
} from '../types';
import OpenAI from 'openai';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/ProcessNode');

export class ProcessNode extends BaseNode {
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
    
    // Process MCP nodes if available
    const mcpNodes = node_params?.properties?.mcpNodes || [];
    
    // Process MCP nodes using the ToolHandler
    const mcpResult = await ToolHandler.processMCPNodes({ mcpNodes });
    
    if (!mcpResult.success) {
      log.error('Failed to process MCP nodes', { error: mcpResult.error });
      throw new Error(`Failed to process MCP nodes: ${mcpResult.error.message}`);
    }
    
    // Create a properly typed PrepResult
    const prepResult: ProcessNodePrepResult = {
      nodeId,
      nodeType: 'process',
      currentPrompt: completePrompt,
      boundModel,
      availableTools: mcpResult.value.availableTools,
      messages: [] // Will be populated after reordering
    };
    
    // Reorder messages to ensure system messages are at the top
    // First, extract all system messages and non-system messages
    const systemMessages: OpenAI.ChatCompletionMessageParam[] = [];
    const nonSystemMessages: OpenAI.ChatCompletionMessageParam[] = [];
    
    // Copy and categorize messages
    sharedState.messages.forEach(msg => {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystemMessages.push(msg);
      }
    });
    
    // Add our own system message if none exist
    if (systemMessages.length === 0) {
      systemMessages.push({
        role: 'system',
        content: completePrompt
      } as OpenAI.ChatCompletionMessageParam);
      
      log.info('Added system message from prompt template', {
        contentLength: completePrompt.length,
        contentPreview: completePrompt.length > 100 ?
          completePrompt.substring(0, 100) + '...' : completePrompt
      });
    }
    
    // Combine messages with system messages first, then non-system messages
    prepResult.messages = [...systemMessages, ...nonSystemMessages];
    
    log.info('Reordered messages with system messages at the top', {
      systemMessageCount: systemMessages.length,
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
      
      // Call the model with tool support
      const modelResult = await ModelHandler.callModel({
        modelId: prepResult.boundModel,
        prompt: prepResult.currentPrompt,
        messages: prepResult.messages,
        tools,
        iteration: 1,
        maxIterations: 30
      });
      
      if (!modelResult.success) {
        log.error('Model execution error', { error: modelResult.error });
        
        // Instead of throwing a new Error, return a properly structured error result
        // that preserves all the original error details
        const errorResult: ProcessNodeExecResult = {
          success: false,
          error: modelResult.error.message,
          errorDetails: {
            message: modelResult.error.message,
            name: modelResult.error.type,
            code: modelResult.error.code,
            type: modelResult.error.type,
            param: typeof modelResult.error.details?.param === 'string' ? modelResult.error.details.param : undefined,
            status: typeof modelResult.error.details?.status === 'number' ? modelResult.error.details.status : undefined,
            // Include all other details from the original error
            ...modelResult.error.details
          }
        };
        
        log.verbose('Preserving original error details from ModelHandler', JSON.stringify(errorResult));
        
        return errorResult;
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
      // For critical tool errors, we want to rethrow them with a special error type
      // that will be caught by the FlowExecutor and properly displayed to the user
      if (error && typeof error === 'object' && 'isCriticalToolError' in error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        log.error('Critical tool error detected - propagating to frontend:', {
          error: errorMessage
        });
        
        // Create a new error with a clear message that will be displayed to the user
        const criticalError = new Error(`CRITICAL TOOL ERROR: ${errorMessage}`);
        
        // Rethrow the error to stop execution and propagate to the frontend
        throw criticalError;
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

  async post(
    prepResult: ProcessNodePrepResult, 
    execResult: ProcessNodeExecResult, 
    sharedState: SharedState, 
    node_params?: ProcessNodeParams
  ): Promise<string> {
    log.info('post() started', { 
      execResultSuccess: execResult.success,
      execResultContentLength: execResult.content?.length || 0,
      messagesCount: execResult.messages?.length || 0
    });
    
    // Store the model response in shared state
    if (execResult.content) {
      sharedState.lastResponse = execResult.content;
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
    if (Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'ProcessNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Process Node',
        modelDisplayName: prepResult.modelDisplayName || 'Unknown Model',
        modelTechnicalName: prepResult.boundModel || 'unknown',
        allowedTools: node_params?.properties?.allowedTools?.join(', '),
        timestamp: new Date().toISOString()
      });
      
      log.info('Added ProcessNode tracking information', {
        modelDisplayName: prepResult.modelDisplayName,
        modelTechnicalName: prepResult.boundModel
      });
    }
    
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

  /**
   * Add message to state
   */
  private addMessageToState(
    prepResult: ProcessNodePrepResult, 
    role: string, 
    content: string
  ): void {
    // Check if we already have a message with this role
    const existingMessage = prepResult.messages?.find(
      (msg: OpenAI.ChatCompletionMessageParam) => msg.role === role
    );
    
    if (!existingMessage) {
      // Add the message to prepResult.messages
      if (!prepResult.messages) {
        prepResult.messages = [];
      }
      
      // Create a properly typed message based on role
      let message: OpenAI.ChatCompletionMessageParam;
      
      switch (role) {
        case 'system':
          message = {
            role: 'system',
            content: content
          };
          break;
        case 'user':
          message = {
            role: 'user',
            content: content
          };
          break;
        case 'assistant':
          message = {
            role: 'assistant',
            content: content
          };
          break;
        case 'tool':
          // Tool messages require a tool_call_id
          throw new Error("Tool messages require a tool_call_id");
        default:
          throw new Error(`Unsupported role: ${role}`);
      }
      
      prepResult.messages.push(message);
      
      log.info(`Added ${role} message`, {
        contentLength: content.length,
        contentPreview: content.length > 100 ?
          content.substring(0, 100) + '...' : content
      });
    } else {
      log.info(`${role} message already exists, not adding again`);
    }
  }

  _clone(): BaseNode {
    return new ProcessNode();
  }
}

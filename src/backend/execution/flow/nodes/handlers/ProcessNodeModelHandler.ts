// Model interaction and response handling for ProcessNode
import { createLogger } from '@/utils/logger';
import { ProcessNodeUtility } from '../util/ProcessNodeUtility';
import { parseToolCalls } from '../util/ProcessNodeParsingUtility';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/handlers/ProcessNodeModelHandler');

export class ProcessNodeModelHandler {
  /**
   * Call the model with tool support and handle recursive tool calls
   */
  static async callModelWithToolSupport(
    modelId: string,
    prompt: string,
    messages: any[],
    prepResult: any,
    tools: any[],
    currentIteration: number = 0,
    maxIterations: number = 30
  ): Promise<any> {
    log.info(`callModelWithToolSupport() - Iteration ${currentIteration}/${maxIterations}`, {
      modelId,
      messagesCount: messages.length
    });
    
    if (maxIterations > 0) {
      if (currentIteration > maxIterations) {
        log.warn(`Reached maximum iterations (${maxIterations}), stopping tool call processing`);
        return {
          success: true,
          content: "Maximum tool call iterations reached. Some tool calls may not have been processed."
        };
      }
    }
    
    // Call the model API with tools
    log.info(`Calling model API - Iteration ${currentIteration}`, {
      modelId,
      hasTools: tools.length > 0,
      toolsCount: tools.length
    });
    
    // Add detailed debug logging about the tools
    if (tools.length > 0) {
      log.debug('Tools being passed to model:', {
        toolNames: tools.map((tool: any) => {
          const availableTool = prepResult.availableTools?.find((t: any) => t.name === tool.function.name);
          return {
            formatted: tool.function.name,
            original: availableTool?.originalName || 'unknown'
          };
        }),
        toolsInSharedState: prepResult.availableTools?.length || 0,
        toolsInMcpContext: prepResult.mcpContext?.availableTools?.length || 0
      });
    }
    
    // Use ProcessNodeUtility.generateCompletion with or without tools
    const response = await ProcessNodeUtility.generateCompletion(
      modelId,
      prompt,
      messages,
      tools.length > 0 ? tools : undefined,
      prepResult.mcpContext
    );
    
    // Store the full response in prepResult for debugging
    prepResult.modelResponse = response;
    
    // Initialize messages array in prepResult if it doesn't exist
    prepResult.messages = prepResult.messages || [];
    
    // Handle error responses
    if (!response.success && response.error) {
      log.error('Model execution error:', {
        error: response.error,
        errorDetails: response.errorDetails || {}
      });
      
      // Add to tracking info
      if (Array.isArray(prepResult.nodeExecutionTracker)) {
        prepResult.nodeExecutionTracker.push({
          nodeType: 'ModelError',
          error: response.error,
          errorDetails: response.errorDetails || {},
          timestamp: new Date().toISOString()
        });
      }
      
      // Add error message to prepResult.messages
      const errorMessage = {
        role: "system",
        content: `Error: ${response.error}`
      };
      prepResult.messages.push(errorMessage);
      
      // Instead of returning the response, throw an error with detailed information
      const errorDetails = response.errorDetails ? 
        JSON.stringify(response.errorDetails) : 'No additional details';
      
      const enhancedError = new Error(`OpenAI API Error: ${response.error}`);
      (enhancedError as any).status = response.errorDetails?.status || 500;
      (enhancedError as any).code = response.errorDetails?.code || 'unknown_error';
      (enhancedError as any).type = response.errorDetails?.type || 'api_error';
      (enhancedError as any).param = response.errorDetails?.param;
      (enhancedError as any).errorDetails = response.errorDetails;
      
      throw enhancedError;
    }
    
    // Extract content from successful response
    const content = response.content || '';
    
    // Variable to track if the response has tool calls
    let hasToolCalls = false;
    
    // First check if the response already has structured tool calls
    if (response.fullResponse?.choices?.[0]?.message?.tool_calls &&
        response.fullResponse.choices[0].message.tool_calls.length > 0) {
      hasToolCalls = true;
    } 
    // If no structured tool calls and no tools were provided (potential retry scenario)
    else if (!tools || tools.length === 0) {
      // Potentially a response from the retry (no tools were sent, no structured tool calls were returned)
      log.info('Attempting to parse tool calls from text response');
      const parseResult = await parseToolCalls(content, modelId);

      if (parseResult.success && parseResult.toolCalls) {
        log.info(`Successfully parsed tool calls from text: ${parseResult.toolCalls.length}`);
        
        // Initialize the message object if it doesn't exist
        if (!response.fullResponse.choices[0].message) {
          response.fullResponse.choices[0].message = { content: content };
        }
        
        // Add the parsed tool calls to the response
        response.fullResponse.choices[0].message.tool_calls = parseResult.toolCalls;
        
        // Update hasToolCalls flag
        hasToolCalls = true;
        
        log.debug('Updated response with parsed tool calls', {
          toolCallsCount: parseResult.toolCalls.length,
          toolCalls: parseResult.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.function.name
          }))
        });
      } else if (parseResult.error) {
        log.warn(`Failed to parse tool calls from text response: ${parseResult.error}`);
      }
    }
    
    if (hasToolCalls) {
      log.info(`Response contains tool calls - Iteration ${currentIteration}`, {
        toolCallsCount: response.fullResponse.choices[0].message.tool_calls.length
      });
      
      // Add assistant message with tool calls to prepResult.messages
      const assistantMessage = {
        role: "assistant",
        content: content,
        tool_calls: response.fullResponse.choices[0].message.tool_calls
      };
      prepResult.messages.push(assistantMessage);
      
      log.info('Added assistant message with tool calls', {
        contentLength: content.length,
        contentPreview: content.length > 100 ? content.substring(0, 100) + '...' : content,
        toolCallsCount: response.fullResponse.choices[0].message.tool_calls.length
      });
      
      // Add to tracking info
      if (Array.isArray(prepResult.nodeExecutionTracker)) {
        prepResult.nodeExecutionTracker.push({
          nodeType: 'AssistantMessageWithToolCalls',
          content: typeof content === 'string' ?
            (content.substring(0, 100) + (content.length > 100 ? '...' : '')) :
            'Content is not a string',
          toolCallsCount: response.fullResponse.choices[0].message.tool_calls.length,
          timestamp: new Date().toISOString()
        });
      }
      
      // Process tool calls using ProcessNodeUtility
      const toolCallMessages = await ProcessNodeUtility.processToolCalls(response);
      
      log.info(`Processed tool calls - Iteration ${currentIteration}`, {
        toolCallMessagesCount: toolCallMessages.length
      });
      
      // Store tool calls in prepResult for use in post()
      const toolCalls = response.fullResponse.choices[0].message.tool_calls;
      prepResult.toolCalls = toolCalls.map((tc: any, index: number) => {
        // Find the corresponding tool result message
        const toolResultMessage = toolCallMessages.find(
          (m: any) => m.role === 'tool' && m.tool_call_id === tc.id
        );
        
        const toolCallInfo = {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments),
          id: tc.id,
          result: toolResultMessage && typeof toolResultMessage.content === 'string' ?
            toolResultMessage.content : 'No result available'
        };
        
        // Add to tracking info
        if (Array.isArray(prepResult.nodeExecutionTracker)) {
          prepResult.nodeExecutionTracker.push({
            nodeType: 'ToolCall',
            toolName: toolCallInfo.name,
            toolArgs: toolCallInfo.args,
            timestamp: new Date().toISOString()
          });
          
          prepResult.nodeExecutionTracker.push({
            nodeType: 'ToolResult',
            toolName: toolCallInfo.name,
            result: typeof toolCallInfo.result === 'string' ?
              (toolCallInfo.result.substring(0, 100) + (toolCallInfo.result.length > 100 ? '...' : '')) :
              String(toolCallInfo.result).substring(0, 100),
            timestamp: new Date().toISOString()
          });
        }
        
        return toolCallInfo;
      });
      
      // Add tool call messages to prepResult.messages
      for (const message of toolCallMessages) {
        prepResult.messages.push(message);
        
        log.debug('Added tool result message', {
          toolCallId: (message as any).tool_call_id,
          contentLength: message.content ?
            (typeof message.content === 'string' ? message.content.length : 'non-string content') :
            'no content'
        });
      }
      
      log.info(`Recursively calling model with updated messages - Iteration ${currentIteration}`, {
        messagesCount: prepResult.messages.length
      });
      
      // Recursively call the model with the updated messages
      return this.callModelWithToolSupport(
        modelId,
        prompt,
        prepResult.messages,
        prepResult,
        tools,
        currentIteration + 1,
        maxIterations
      );
    } else {
      // No tool calls, just add the assistant message and return
      const assistantMessage = {
        role: "assistant",
        content: content
      };
      prepResult.messages.push(assistantMessage);
      
      log.info('Added final assistant message', {
        contentLength: typeof content === 'string' ? content.length : 'non-string content',
        contentPreview: typeof content === 'string' ?
          (content.length > 100 ? content.substring(0, 100) + '...' : content) :
          'Content is not a string'
      });
      
      // Add to tracking info
      if (Array.isArray(prepResult.nodeExecutionTracker)) {
        prepResult.nodeExecutionTracker.push({
          nodeType: 'AssistantMessage',
          content: typeof content === 'string' ?
            (content.substring(0, 100) + (content.length > 100 ? '...' : '')) :
            'Content is not a string',
          timestamp: new Date().toISOString()
        });
      }
      
      return response;
    }
  }

  /**
   * Add message to shared state and tracking
   */
  static addMessageToState(
    sharedState: any, 
    role: string, 
    content: string, 
    nodeType: string
  ): void {
    // Check if we already have a message with this role
    const existingMessage = sharedState.messages?.find(
      (msg: { role: string; content: string }) => msg.role === role
    );
    
    if (!existingMessage) {
      // Add the message to sharedState.messages
      if (!sharedState.messages) {
        sharedState.messages = [];
      }
      
      sharedState.messages.push({
        role: role,
        content: content
      });
      
      log.info(`Added ${role} message`, {
        contentLength: content.length,
        contentPreview: content.length > 100 ?
          content.substring(0, 100) + '...' : content
      });
      
      // Add to tracking info
      if (Array.isArray(sharedState.nodeExecutionTracker)) {
        sharedState.nodeExecutionTracker.push({
          nodeType: nodeType,
          content: content.substring(0, 100) + 
            (content.length > 100 ? '...' : ''),
          timestamp: new Date().toISOString()
        });
      }
    } else {
      log.info(`${role} message already exists, not adding again`);
    }
  }

  /**
   * Add node execution tracking information
   */
  static addNodeExecutionTracking(
    sharedState: any,
    nodeParams: any
  ): void {
    if (!Array.isArray(sharedState.nodeExecutionTracker)) {
      return;
    }

    // Get model information
    const boundModel = sharedState.boundModel;
    const modelDisplayName = sharedState.modelDisplayName || 'Unknown Model';
    
    // Determine allowed tools (if available)
    let allowedTools = 'Not specified';
    if (nodeParams.properties?.allowedTools) {
      allowedTools = Array.isArray(nodeParams.properties.allowedTools) 
        ? nodeParams.properties.allowedTools.join(', ')
        : String(nodeParams.properties.allowedTools);
    }
    
    sharedState.nodeExecutionTracker.push({
      nodeType: 'ProcessNode',
      nodeId: nodeParams.id || 'unknown',
      nodeName: nodeParams.properties?.name || 'Process Node',
      modelDisplayName: modelDisplayName,
      modelTechnicalName: boundModel || 'unknown',
      allowedTools: allowedTools,
      timestamp: new Date().toISOString()
    });
    
    log.info('Added ProcessNode tracking information', {
      modelDisplayName,
      modelTechnicalName: boundModel
    });
  }
}

// Local implementation of PocketFlow for debugging
import { Flow as PocketFlow } from './temp_pocket';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from './FlowConverter';
import { createLogger } from '@/utils/logger';
import { FlowExecutionResponse, SuccessResult, ErrorResult } from '@/shared/types/flow/response';
import { SharedState, FlowParams } from './types';
import OpenAI from 'openai';

// Create a logger instance for this file
const log = createLogger('backend/execution/flow/FlowExecutor');

export class FlowExecutor {
  /**
   * Execute a flow by name
   */
  static async executeFlow(flowName: string, options?: { messages?: OpenAI.ChatCompletionMessageParam[] }): Promise<FlowExecutionResponse> {
    log.info(`Executing flow: ${flowName}`, {
      hasInitialInput: !!options?.messages?.length
    });
    
    // Add verbose logging of the input parameters
    log.verbose('executeFlow input', JSON.stringify({
      flowName,
      messagesCount: options?.messages?.length || 0
    }));
    
    // Load the flow from storage
    log.debug('Loading flows from storage');
    const flows = await flowService.loadFlows();
    log.debug(`Loaded ${flows.length} flows from storage`);
    
    const reactFlow = flows.find(flow => flow.name === flowName);
    
    if (!reactFlow) {
      log.error(`Flow not found: ${flowName}`);
      throw new Error(`Flow not found: ${flowName}`);
    }
    
    log.info(`Found flow: ${flowName}`, {
      flowId: reactFlow.id,
      nodeCount: reactFlow.nodes.length,
      edgeCount: reactFlow.edges.length
    });
    
    // Convert to Pocket Flow
    log.debug(`Converting flow to Pocket Flow: ${flowName}`);
    const pocketFlow = FlowConverter.convert(reactFlow);
    log.debug('Flow conversion completed');
    
    // Create minimal shared state with only tracking info
    const sharedState: SharedState = {
      trackingInfo: {
        executionId: crypto.randomUUID(),
        startTime: Date.now(),
        nodeExecutionTracker: []
      },
      messages: [],
      flowId: reactFlow.id // Add flowId to shared state for use by ProcessNode
    };
    

    // If messages are provided, add them directly to shared state
    if (options?.messages && Array.isArray(options.messages)) {
      log.debug("NOW WE'RE ADDING THE FUCKING MESSAGE", options?.messages);
      sharedState.messages = [...options.messages];
    }
    
    log.info('Starting flow execution', {
      flowName,
      flowId: reactFlow.id,
      hasInitialInput: !!options?.messages?.length,
      messageCount: sharedState.messages.length
    });
    
    // Add verbose logging of the shared state
    log.verbose('executeFlow sharedState', JSON.stringify(sharedState));
    
    // Execute the flow
    try {
      await pocketFlow.run(sharedState);
      log.info('Flow execution completed successfully', {
        flowName,
        executionTime: Date.now() - sharedState.trackingInfo.startTime,
        messagesCount: sharedState.messages?.length || 0
      });
    } catch (error) {
      log.error('Error during flow execution', {
        flowName,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // CHANGE HERE: Handle model errors specifically
      if (error && typeof error === 'object' && 'isModelError' in error) {
        // Create a structured error response
        const errorDetails = (error as any).details || {};
        const errorResponse: FlowExecutionResponse = {
          success: false,
          result: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            errorDetails: {
              message: errorDetails.message || (error instanceof Error ? error.message : String(error)),
              type: errorDetails.type || 'model_error',
              code: errorDetails.code,
              param: errorDetails.param,
              status: errorDetails.status,
              ...errorDetails
            }
          },
          messages: sharedState.messages || [],
          executionTime: Date.now() - sharedState.trackingInfo.startTime,
          nodeExecutionTracker: sharedState.trackingInfo.nodeExecutionTracker || []
        };
        
        // Cast result to ErrorResult to access error property
        const errorResult = errorResponse.result as ErrorResult;
        log.info('Returning model error response to frontend', {
          errorMessage: errorResult.error,
          errorType: errorResult.errorDetails?.type
        });
        
        return errorResponse;
      }
      
      // For other errors, create a generic error response
      const errorResponse: FlowExecutionResponse = {
        success: false,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorDetails: {
            message: error instanceof Error ? error.message : String(error),
            type: 'flow_execution_error'
          }
        },
        messages: sharedState.messages || [],
        executionTime: Date.now() - sharedState.trackingInfo.startTime,
        nodeExecutionTracker: sharedState.trackingInfo.nodeExecutionTracker || []
      };
      
      // Cast result to ErrorResult to access error property
      const errorResult = errorResponse.result as ErrorResult;
      log.info('Returning generic error response to frontend', {
        errorMessage: errorResult.error
      });
      
      return errorResponse;
    }
    
    // Check if there's an error in the shared state's last response
    const hasError = typeof sharedState.lastResponse === 'object' && 
                     sharedState.lastResponse !== null && 
                     'success' in sharedState.lastResponse && 
                     sharedState.lastResponse.success === false;
    
    // Return the final state with appropriate success/error flags
    const result: FlowExecutionResponse = {
      success: !hasError,
      result: typeof sharedState.lastResponse === 'string' 
        ? sharedState.lastResponse 
        : hasError 
          ? { 
              success: false, 
              error: (sharedState.lastResponse as any).error,
              errorDetails: (sharedState.lastResponse as any).errorDetails
            } 
          : { success: true, ...sharedState.lastResponse as object } as SuccessResult,
      messages: sharedState.messages, // Already using OpenAI.ChatCompletionMessageParam
      executionTime: Date.now() - sharedState.trackingInfo.startTime,
      nodeExecutionTracker: sharedState.trackingInfo.nodeExecutionTracker,
      // Include any tool calls from the last message if it's an assistant message with tool calls
      toolCalls: (() => {
        if (sharedState.messages.length > 0 && 
            sharedState.messages[sharedState.messages.length - 1].role === 'assistant') {
          const assistantMsg = sharedState.messages[sharedState.messages.length - 1] as OpenAI.ChatCompletionAssistantMessageParam;
          if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
            return assistantMsg.tool_calls.map(tc => ({
              name: tc.function.name,
              args: (() => {
                try {
                  return JSON.parse(tc.function.arguments);
                } catch (e) {
                  return {};
                }
              })(),
              id: tc.id,
              result: '' // Empty result since these haven't been processed yet
            }));
          }
        }
        return undefined;
      })()
    };
    
    log.debug('Returning flow execution result', {
      resultLength: typeof result.result === 'string' ? result.result.length : 0,
      messagesCount: result.messages.length,
      executionTime: result.executionTime
    });
    
    // Add verbose logging of the result
    log.verbose('executeFlow result', JSON.stringify({
      success: result.success,
      resultType: typeof result.result,
      messagesCount: result.messages.length,
      executionTime: result.executionTime,
      nodeExecutionTrackerLength: result.nodeExecutionTracker.length
    }));
    
    return result;
  }
}

// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { SharedState, FinishNodeParams, FinishNodePrepResult, FinishNodeExecResult } from '../types';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/FinishNode');

export class FinishNode extends BaseNode {
  async prep(sharedState: SharedState, node_params?: FinishNodeParams): Promise<FinishNodePrepResult> {
    log.info('prep() started');
    
    // Create a properly typed PrepResult
    const prepResult: FinishNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'finish',
      messages: sharedState.messages
    };
    
    log.info('prep() completed', { 
      messagesCount: prepResult.messages.length,
      hasSystemPrompt: prepResult.messages.some(msg => msg.role === 'system')
    });
    
    return prepResult;
  }

  async execCore(prepResult: FinishNodePrepResult, node_params?: FinishNodeParams): Promise<FinishNodeExecResult> {
    // Finish nodes don't typically perform operations
    log.info('execCore() started', { 
      messagesCount: prepResult.messages.length
    });
    
    // Add verbose logging of the entire prepResult
    log.verbose('execCore() prepResult', JSON.stringify(prepResult));
    
    // Return a properly typed ExecResult
    const execResult: FinishNodeExecResult = {
      success: true
    };
    
    // Add verbose logging of the entire execResult
    log.verbose('execCore() execResult', JSON.stringify(execResult));
    
    log.info('execCore() completed');
    return execResult;
  }

  async post(
    prepResult: FinishNodePrepResult, 
    execResult: FinishNodeExecResult, 
    sharedState: SharedState, 
    node_params?: FinishNodeParams
  ): Promise<string> {
    // Return the final response
    log.info('post() started', { 
      messagesCount: prepResult.messages.length
    });
    
    // Add verbose logging of the inputs
    log.verbose('post() inputs', JSON.stringify({
      prepResult,
      execResult,
      nodeParams: node_params
    }));
    
    // Add tracking information
    if (Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'FinishNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Finish Node',
        timestamp: new Date().toISOString()
      });
      log.info('Added FinishNode tracking information');
    }
    
    // Store the last message as the response if available
    const lastMessage = prepResult.messages[prepResult.messages.length - 1];
    if (lastMessage && lastMessage.role === 'assistant' && lastMessage.content) {
      if (typeof lastMessage.content === 'string') {
        sharedState.lastResponse = lastMessage.content;
      } else {
        // Handle non-string content
        sharedState.lastResponse = {
          content: lastMessage.content,
          role: lastMessage.role
        };
      }
    }
    
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
      log.info(`post() completed, returning action: ${action}`);
      return action;
    }
    
    log.info('post() completed, returning default action');
    return "default"; // Default fallback
  }

  _clone(): BaseNode {
    return new FinishNode();
  }
}

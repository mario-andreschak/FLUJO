// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { SharedState, StartNodeParams, StartNodePrepResult, StartNodeExecResult } from '../types';
import OpenAI from 'openai';

// Create a logger instance for this file
const log = createLogger('execution/nodes/StartNode.ts');

export class StartNode extends BaseNode {
  async prep(sharedState: SharedState, node_params?: StartNodeParams): Promise<StartNodePrepResult> {
    log.info('prep() started');

    // Extract prompt template from node properties
    const promptTemplate = node_params?.properties?.promptTemplate || '';
    log.info('Extracted promptTemplate', { 
      promptTemplateLength: promptTemplate.length,
      promptTemplatePreview: promptTemplate.length > 100 ? 
        promptTemplate.substring(0, 100) + '...' : promptTemplate
    });
    
    // Create a properly typed PrepResult
    const prepResult: StartNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'start',
      systemPrompt: promptTemplate
    };
    
    log.info('prep() completed');
    return prepResult;
  }

  async execCore(prepResult: StartNodePrepResult, node_params?: StartNodeParams): Promise<StartNodeExecResult> {
    // Start nodes don't typically perform operations
    log.info('execCore() started');
    
    // Add verbose logging of the entire prepResult
    log.verbose('execCore() prepResult', JSON.stringify(prepResult));
    
    // Return a properly typed ExecResult
    const execResult: StartNodeExecResult = {
      success: true
    };
    
    // Add verbose logging of the entire execResult
    log.verbose('execCore() execResult', JSON.stringify(execResult));
    
    log.info('execCore() completed');
    return execResult;
  }

  async post(
    prepResult: StartNodePrepResult, 
    execResult: StartNodeExecResult, 
    sharedState: SharedState, 
    node_params?: StartNodeParams
  ): Promise<string> {
    log.info('post() started');
    
    // Add verbose logging of the inputs
    log.verbose('post() inputs', JSON.stringify({
      prepResult,
      execResult,
      nodeParams: node_params
    }));
    
    // Add tracking information
    if (Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'StartNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Start Node',
        timestamp: new Date().toISOString()
      });
      log.info('Added StartNode tracking information');
    }
    
    // Add system message to messages array if it doesn't exist
    if (prepResult.systemPrompt) {
      const systemMessage: OpenAI.ChatCompletionSystemMessageParam = {
        role: 'system',
        content: prepResult.systemPrompt
      };
      
      // Check if we already have a system message
      const hasSystemMessage = sharedState.messages.some(msg => msg.role === 'system');
      
      if (!hasSystemMessage) {
        sharedState.messages.push(systemMessage);
        log.debug('Added system message', {
          contentLength: typeof systemMessage.content === 'string' ? systemMessage.content.length : 'non-string content',
          contentPreview: typeof systemMessage.content === 'string' && systemMessage.content.length > 50 ? 
            systemMessage.content.substring(0, 50) + '...' : systemMessage.content
        });
      }
    }
    
    // In pocketflowframework, we need to check the available actions
    // and return one of them to proceed to the next node
    
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
    return new StartNode();
  }
}

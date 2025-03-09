// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/FinishNode');

export class FinishNode extends BaseNode {
  async prep(sharedState: any, node_params?: any): Promise<any> {
    log.info('prep() started');
    
    log.info('prep() completed', { 
      sharedStateKeys: Object.keys(sharedState || {}),
      messagesCount: sharedState?.messages?.length || 0,
      hasSystemPrompt: !!sharedState?.systemPrompt,
      systemPromptLength: sharedState?.systemPrompt?.length || 0
    });
    return sharedState;
  }

  async execCore(prepResult: any, node_params?: any): Promise<any> {
    // Finish nodes don't typically perform operations
    log.info('execCore() started', { 
      prepResultKeys: Object.keys(prepResult || {})
    });
    log.info('execCore() completed', { 
      resultKeys: Object.keys(prepResult || {})
    });
    return prepResult;
  }

  async post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string> {
    // Return the final response
    log.info('post() started', { 
      prepResultKeys: Object.keys(prepResult || {}),
      execResultKeys: Object.keys(execResult || {}),
      sharedStateKeys: Object.keys(sharedState || {}),
      messagesCount: sharedState?.messages?.length || 0
    });
    
    // Add tracking information
    if (Array.isArray(sharedState.nodeExecutionTracker)) {
      sharedState.nodeExecutionTracker.push({
        nodeType: 'FinishNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Finish Node',
        timestamp: new Date().toISOString()
      });
      log.info('Added FinishNode tracking information');
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

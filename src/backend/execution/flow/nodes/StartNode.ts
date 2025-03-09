// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('execution/nodes/StartNode.ts');

export class StartNode extends BaseNode {
  async prep(sharedState: any, node_params?: any): Promise<any> {
    log.info('prep() started');

    // Extract prompt template from node properties using node_params
    const promptTemplate = node_params?.properties?.promptTemplate || '';
    log.info('Extracted promptTemplate', { 
      promptTemplateLength: promptTemplate.length,
      promptTemplatePreview: promptTemplate.length > 100 ? 
        promptTemplate.substring(0, 100) + '...' : promptTemplate
    });
    
    log.info('node params', { node_params });
    // Add the prompt to the shared state
    sharedState.systemPrompt = promptTemplate;
    sharedState.messages = sharedState.messages || [];
    
    // log.info('prep() completed', { sharedState });
    return sharedState;
  }

  async execCore(prepResult: any, node_params?: any): Promise<any> {
    // Start nodes don't typically perform operations
    // log.info('execCore() started', { prepResult });
    // log.info('execCore() completed', { result: prepResult });
    log.info('execCore() started');
    log.info('execCore() completed');
    return prepResult;
  }

  async post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string> {
    log.info('post() started');
    
    // Add tracking information
    if (Array.isArray(sharedState.nodeExecutionTracker)) {
      sharedState.nodeExecutionTracker.push({
        nodeType: 'StartNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Start Node',
        timestamp: new Date().toISOString()
      });
      log.info('Added StartNode tracking information');
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

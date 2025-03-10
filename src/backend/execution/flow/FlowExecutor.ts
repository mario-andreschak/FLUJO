// Local implementation of PocketFlow for debugging
import { Flow as PocketFlow } from './temp_pocket';
import { flowService } from '@/backend/services/flow';
import { FlowConverter } from './FlowConverter';
import { createLogger } from '@/utils/logger';
import { FlowExecutionResponse } from '@/shared/types/flow/response';

// Create a logger instance for this file
const log = createLogger('backend/execution/flow/FlowExecutor');

export class FlowExecutor {
  /**
   * Execute a flow by name
   */
  static async executeFlow(flowName: string, initialState: any = {}): Promise<FlowExecutionResponse> {
    log.info(`Executing flow: ${flowName}`, {
      initialStateKeys: Object.keys(initialState)
    });
    
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
    
    // Create shared state
    const sharedState = {
      ...initialState,
      flowName,
      flowId: reactFlow.id, // Add flowId to shared state for use by ProcessNode
      startTime: Date.now(),
      nodeExecutionTracker: [] // Track execution of each node
    };
    
    log.info('Starting flow execution', {
      flowName,
      sharedStateKeys: Object.keys(sharedState)
    });
    
    // Execute the flow
    try {
      await pocketFlow.run(sharedState);
      log.info('Flow execution completed successfully', {
        flowName,
        executionTime: Date.now() - sharedState.startTime,
        messagesCount: sharedState.messages?.length || 0
      });
    } catch (error) {
      log.error('Error during flow execution', {
        flowName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    
    // Return the final state
    const result: FlowExecutionResponse = {
      success: true,
      result: sharedState.lastResponse,
      messages: sharedState.messages || [],
      executionTime: Date.now() - sharedState.startTime,
      nodeExecutionTracker: sharedState.nodeExecutionTracker || [] // Include tracking information
    };
    
    log.debug('Returning flow execution result', {
      resultLength: typeof result.result === 'string' ? result.result.length : 0,
      messagesCount: result.messages.length,
      executionTime: result.executionTime
    });
    
    return result;
  }
}

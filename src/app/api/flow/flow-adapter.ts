import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { 
  FlowServiceResponse, 
  FlowOperationResponse, 
  FlowListResponse,
  FlowExecutionResponse
} from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';

// Create a logger instance for this file
const log = createLogger('app/api/flow/flow-adapter');

/**
 * Load all flows
 * This adapter delegates to the backend service
 */
export async function loadFlows(): Promise<FlowListResponse> {
  log.debug('loadFlows: Delegating to backend service');
  try {
    const flows = await flowService.loadFlows();
    return { success: true, flows };
  } catch (error) {
    log.error('loadFlows: Error loading flows:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load flows'
    };
  }
}

/**
 * Get a flow by ID
 * This adapter delegates to the backend service
 */
export async function getFlow(flowId: string): Promise<FlowOperationResponse> {
  log.debug(`getFlow: Delegating to backend service for flow ID: ${flowId}`);
  try {
    const flow = await flowService.getFlow(flowId);
    if (!flow) {
      return { success: false, error: `Flow not found: ${flowId}` };
    }
    return { success: true, flow };
  } catch (error) {
    log.error(`getFlow: Error getting flow ${flowId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get flow'
    };
  }
}

/**
 * Save a flow (create new or update existing)
 * This adapter delegates to the backend service
 */
export async function saveFlow(flow: Flow): Promise<FlowOperationResponse> {
  log.debug(`saveFlow: Delegating to backend service for flow ID: ${flow.id}`);
  try {
    const result = await flowService.saveFlow(flow);
    if (!result.success) {
      return result;
    }
    return { success: true, flow };
  } catch (error) {
    log.error('saveFlow: Error saving flow:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save flow'
    };
  }
}

/**
 * Delete a flow by ID
 * This adapter delegates to the backend service
 */
export async function deleteFlow(flowId: string): Promise<FlowServiceResponse> {
  log.debug(`deleteFlow: Delegating to backend service for flow ID: ${flowId}`);
  try {
    return await flowService.deleteFlow(flowId);
  } catch (error) {
    log.error(`deleteFlow: Error deleting flow ${flowId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete flow'
    };
  }
}

/**
 * Create a new flow with default nodes
 * This adapter delegates to the backend service
 */
export function createNewFlow(name: string = 'NewFlow'): Flow {
  log.debug(`createNewFlow: Delegating to backend service for flow name: ${name}`);
  return flowService.createNewFlow(name);
}

/**
 * Generate a sample flow for testing
 * This adapter delegates to the backend service
 */
export function generateSampleFlow(name: string = 'Sample Flow'): Flow {
  log.debug(`generateSampleFlow: Delegating to backend service for flow name: ${name}`);
  return flowService.generateSampleFlow(name);
}

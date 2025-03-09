import { Flow } from './flow';

/**
 * Base response interface for flow service operations
 */
export interface FlowServiceResponse {
  success: boolean;
  error?: string;
}

/**
 * Response interface for operations that return a flow
 */
export interface FlowOperationResponse extends FlowServiceResponse {
  flow?: Flow;
}

/**
 * Response interface for operations that return a list of flows
 */
export interface FlowListResponse extends FlowServiceResponse {
  flows?: Flow[];
}

/**
 * Response interface for flow execution operations
 */
export interface FlowExecutionResponse extends FlowServiceResponse {
  result?: any;
  executionId?: string;
}

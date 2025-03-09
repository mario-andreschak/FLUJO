// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { MCPNodeUtility } from './util/MCPNodeUtility';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/MCPNode');

export class MCPNode extends BaseNode {
  async prep(sharedState: any, node_params?: any): Promise<any> {
    return MCPNodeUtility.prepNode(sharedState, node_params);
  }

  async execCore(prepResult: any, node_params?: any): Promise<any> {
    return MCPNodeUtility.executeNode(prepResult, node_params);
  }

  async post(prepResult: any, execResult: any, sharedState: any, node_params?: any): Promise<string> {
    return MCPNodeUtility.postProcess(prepResult, execResult, sharedState, node_params, this.successors);
  }

  _clone(): BaseNode {
    return new MCPNode();
  }
}

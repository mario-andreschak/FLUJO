import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry } from '@/shared/types/flow';
import { 
  FlowServiceResponse, 
  FlowOperationResponse, 
  FlowListResponse
} from '@/shared/types/flow';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Edge } from '@xyflow/react';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/flow/index');

/**
 * FlowService class provides a clean interface for flow-related operations
 * This is the core backend service that handles all flow operations
 */
class FlowService {
  private flowsCache: Flow[] | null = null;

  /**
   * Load all flows from storage
   */
  async loadFlows(): Promise<Flow[]> {
    try {
      // Try to use cache first
      if (this.flowsCache) {
        log.debug('Using cached flows');
        return this.flowsCache;
      }

      log.debug('Loading flows from storage');
      const flows = await loadItem<Flow[]>(StorageKey.FLOWS, []);
      this.flowsCache = flows;
      log.info('Loaded flows from storage', { count: flows.length });
      return flows;
    } catch (error) {
      log.error('Failed to load flows', error);
      return [];
    }
  }

  /**
   * Get a specific flow by ID
   */
  async getFlow(flowId: string): Promise<Flow | null> {
    try {
      log.debug(`Getting flow by ID: ${flowId}`);
      const flows = await this.loadFlows();
      const flow = flows.find(flow => flow.id === flowId) || null;
      log.debug(`Flow ${flowId} ${flow ? 'found' : 'not found'}`);
      return flow;
    } catch (error) {
      log.error(`Failed to get flow ${flowId}`, error);
      return null;
    }
  }

  /**
   * Save a flow (create new or update existing)
   */
  async saveFlow(flow: Flow): Promise<FlowServiceResponse> {
    try {
      log.debug(`Saving flow: ${flow.id}`, { name: flow.name });
      // Load current flows
      const flows = await this.loadFlows();
      
      // Check if flow exists
      const existingFlowIndex = flows.findIndex(f => f.id === flow.id);
      
      let updatedFlows: Flow[];
      if (existingFlowIndex >= 0) {
        // Update existing flow
        log.debug(`Updating existing flow: ${flow.id}`);
        updatedFlows = [...flows];
        updatedFlows[existingFlowIndex] = flow;
      } else {
        // Add new flow
        log.debug(`Adding new flow: ${flow.id}`);
        updatedFlows = [...flows, flow];
      }
      
      await saveItem(StorageKey.FLOWS, updatedFlows);
      
      // Update cache
      this.flowsCache = updatedFlows;
      
      log.info(`Flow ${flow.id} saved successfully`);
      return { success: true };
    } catch (error) {
      log.error('Failed to save flow', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to save flow' 
      };
    }
  }

  /**
   * Delete a flow by ID
   */
  async deleteFlow(flowId: string): Promise<FlowServiceResponse> {
    try {
      log.debug(`Deleting flow: ${flowId}`);
      // Load current flows
      const flows = await this.loadFlows();
      
      // Remove the flow
      const updatedFlows = flows.filter(flow => flow.id !== flowId);
      await saveItem(StorageKey.FLOWS, updatedFlows);
      
      // Update cache
      this.flowsCache = updatedFlows;
      
      log.info(`Flow ${flowId} deleted successfully`);
      return { success: true };
    } catch (error) {
      log.error(`Failed to delete flow: ${flowId}`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to delete flow' 
      };
    }
  }

  /**
   * Create a new node of the specified type at the given position
   */
  createNode(type: string, position: { x: number; y: number }): FlowNode {
    log.debug(`Creating new node of type: ${type}`, { position });
    const node = {
      id: uuidv4(),
      type,
      position,
      data: {
        label: `${type === 'mcp' ? 'MCP' : type.charAt(0).toUpperCase() + type.slice(1)} Node`,
        type,
        properties: {},
      },
    };
    log.debug(`Node created with ID: ${node.id}`);
    return node;
  }

  /**
   * Create a new flow with a default Start node
   */
  createNewFlow(name: string = 'NewFlow'): Flow {
    log.debug(`Creating new flow: ${name}`);
    // Create a Start node
    const startNode: FlowNode = {
      id: uuidv4(),
      type: 'start',
      position: { x: 250, y: 150 },
      data: { 
        label: 'Start Node', 
        type: 'start',
        properties: {
          promptTemplate: ''
        }
      }
    };
    
    // Create and return the new flow
    const flow = {
      id: uuidv4(),
      name,
      nodes: [startNode],
      edges: [],
    };
    
    log.info(`New flow created with ID: ${flow.id}`, { name });
    return flow;
  }

  /**
   * Create a history entry for undo/redo functionality
   */
  createHistoryEntry(nodes: FlowNode[], edges: Edge[]): HistoryEntry {
    log.debug('Creating history entry', { nodeCount: nodes.length, edgeCount: edges.length });
    return {
      nodes: [...nodes],
      edges: [...edges]
    };
  }

  /**
   * Generate sample flow data for testing
   */
  generateSampleFlow(name: string = 'Sample Flow'): Flow {
    log.debug(`Generating sample flow: ${name}`);
    const sampleNodes: FlowNode[] = [
      {
        id: '1',
        type: 'start',
        position: { x: 250, y: 50 },
        data: { 
          label: 'Start Node', 
          type: 'start',
          properties: {
            prompt: 'Enter your query here',
            systemMessage: 'You are a helpful assistant',
            temperature: 0.0
          }
        }
      },
      {
        id: '2',
        type: 'process',
        position: { x: 250, y: 200 },
        data: { 
          label: 'Process Node', 
          type: 'process',
          properties: {
            operation: 'transform',
            enabled: true
          }
        }
      },
      {
        id: '3',
        type: 'finish',
        position: { x: 250, y: 350 },
        data: { 
          label: 'Finish Node', 
          type: 'finish',
          properties: {
            format: 'json',
            template: '{ "result": {{data}} }'
          }
        }
      },
      {
        id: '4',
        type: 'mcp',
        position: { x: 450, y: 200 },
        data: { 
          label: 'MCP Node', 
          type: 'mcp',
          properties: {
            channels: 2,
            mode: 'parallel'
          }
        }
      }
    ];
    
    const sampleEdges: Edge[] = [
      {
        id: 'e1-2',
        source: '1',
        target: '2',
        type: 'custom'
      },
      {
        id: 'e2-3',
        source: '2',
        target: '3',
        type: 'custom'
      }
    ];
    
    const flow = {
      id: uuidv4(),
      name,
      nodes: sampleNodes,
      edges: sampleEdges,
    };
    
    log.info(`Sample flow generated with ID: ${flow.id}`, { name });
    return flow;
  }

  /**
   * List all flows
   */
  async listFlows(): Promise<FlowListResponse> {
    log.debug('listFlows: Entering method');
    try {
      const flows = await this.loadFlows();
      return { success: true, flows };
    } catch (error) {
      log.warn('listFlows: Failed to list flows:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list flows'
      };
    }
  }
}

// Export a singleton instance of the service
export const flowService = new FlowService();

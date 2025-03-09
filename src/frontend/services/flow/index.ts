'use client';

import { v4 as uuidv4 } from 'uuid';
import { Flow, FlowNode, HistoryEntry } from '@/shared/types/flow';
import { Edge } from '@xyflow/react';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('frontend/services/flow/index');

/**
 * FlowService class provides a client-side API for UI components
 * This service makes API calls to the server-side API layer
 */
class FlowService {
  private flowsCache: Flow[] | null = null;

  /**
   * Load all flows
   */
  async loadFlows(): Promise<Flow[]> {
    log.debug('loadFlows: Entering method');
    try {
      // Try to use cache first
      if (this.flowsCache) {
        log.debug('loadFlows: Using cached flows', { count: this.flowsCache.length });
        return this.flowsCache;
      }

      // Call the API to list flows
      const response = await fetch('/api/flow?action=listFlows');
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load flows');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load flows');
      }
      
      const flows = data.flows || [];
      log.debug('loadFlows: Loaded flows from API', { count: flows.length });
      this.flowsCache = flows;
      return flows;
    } catch (error) {
      log.warn('loadFlows: Failed to load flows:', error);
      return [];
    }
  }

  /**
   * Get a specific flow by ID
   */
  async getFlow(flowId: string): Promise<Flow | null> {
    log.debug('getFlow: Entering method', { flowId });
    try {
      // Try to use cache first
      if (this.flowsCache) {
        const cachedFlow = this.flowsCache.find(flow => flow.id === flowId);
        if (cachedFlow) {
          log.debug('getFlow: Using cached flow', { flowId });
          return cachedFlow;
        }
      }

      // Call the API to get the flow
      const response = await fetch(`/api/flow?action=getFlow&id=${encodeURIComponent(flowId)}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          log.debug(`getFlow: Flow ${flowId} not found`);
          return null;
        }
        
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to get flow: ${flowId}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        log.debug(`getFlow: Flow ${flowId} not found`);
        return null;
      }
      
      log.debug('getFlow: Retrieved flow from API', { flowId });
      return data.flow;
    } catch (error) {
      log.warn(`getFlow: Failed to get flow ${flowId}:`, error);
      return null;
    }
  }

  /**
   * Save a flow (create new or update existing)
   */
  async saveFlow(flow: Flow): Promise<{ success: boolean; error?: string }> {
    log.debug('saveFlow: Entering method', { 
      flowId: flow.id, 
      flowName: flow.name,
      nodeCount: flow.nodes.length,
      edgeCount: flow.edges.length
    });
    
    try {
      // Determine if this is a new flow or an update
      const action = await this.getFlow(flow.id) ? 'updateFlow' : 'addFlow';
      
      // Call the API to save the flow
      const response = await fetch('/api/flow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          flow
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to save flow' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to save flow' 
        };
      }
      
      // Update cache
      if (this.flowsCache) {
        const existingFlowIndex = this.flowsCache.findIndex(f => f.id === flow.id);
        if (existingFlowIndex >= 0) {
          // Update existing flow in cache
          this.flowsCache[existingFlowIndex] = data.flow || flow;
        } else {
          // Add new flow to cache
          this.flowsCache.push(data.flow || flow);
        }
      }
      
      log.debug('saveFlow: Flow saved successfully', { flowId: flow.id });
      return { success: true };
    } catch (error) {
      log.warn('saveFlow: Failed to save flow:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to save flow' 
      };
    }
  }

  /**
   * Delete a flow by ID
   */
  async deleteFlow(flowId: string): Promise<{ success: boolean; error?: string }> {
    log.debug('deleteFlow: Entering method', { flowId });
    try {
      // Call the API to delete the flow
      const response = await fetch('/api/flow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'deleteFlow',
          id: flowId
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to delete flow' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to delete flow' 
        };
      }
      
      // Update cache
      if (this.flowsCache) {
        this.flowsCache = this.flowsCache.filter(flow => flow.id !== flowId);
      }
      
      log.debug('deleteFlow: Flow deleted successfully', { flowId });
      return { success: true };
    } catch (error) {
      log.warn('deleteFlow: Failed to delete flow:', error);
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
    log.debug('createNode: Entering method', { type, position });
    return {
      id: uuidv4(),
      type,
      position,
      data: {
        label: `${type === 'mcp' ? 'MCP' : type.charAt(0).toUpperCase() + type.slice(1)} Node`,
        type,
        properties: {},
      },
    };
  }

  /**
   * Create a new flow with a default Start node
   */
  createNewFlow(name: string = 'NewFlow'): Flow {
    log.debug('createNewFlow: Entering method', { name });
    
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
    return {
      id: uuidv4(),
      name,
      nodes: [startNode],
      edges: [],
    };
  }

  /**
   * Create a history entry for undo/redo functionality
   */
  createHistoryEntry(nodes: FlowNode[], edges: Edge[]): HistoryEntry {
    log.debug('createHistoryEntry: Entering method');
    return {
      nodes: [...nodes],
      edges: [...edges]
    };
  }

  /**
   * Generate sample flow data for testing
   */
  generateSampleFlow(name: string = 'Sample Flow'): Flow {
    log.debug('generateSampleFlow: Entering method', { name });
    
    // Call the API to generate a sample flow
    // For client-side performance, we'll generate it locally instead of making an API call
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
    
    return {
      id: uuidv4(),
      name,
      nodes: sampleNodes,
      edges: sampleEdges,
    };
  }
}

export const flowService = new FlowService();

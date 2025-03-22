// Local implementation of PocketFlow for debugging
import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import { MCPHandler } from '../handlers/MCPHandler';
import { SharedState, MCPNodeParams, MCPNodePrepResult, MCPNodeExecResult } from '../types';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/MCPNode');

export class MCPNode extends BaseNode {
  async prep(sharedState: SharedState, node_params?: MCPNodeParams): Promise<MCPNodePrepResult> {
    log.info('prep() started');
    
    // Extract properties from node_params
    const nodeId = node_params?.id || '';
    const mcpServer = node_params?.properties?.boundServer;
    const enabledTools = node_params?.properties?.enabledTools || [];
    const mcpEnv = node_params?.properties?.env || {};
    
    if (!mcpServer) {
      log.error('Missing bound server');
      throw new Error("MCP node requires a bound server");
    }
    
    // Create a properly typed PrepResult
    const prepResult: MCPNodePrepResult = {
      nodeId,
      nodeType: 'mcp',
      mcpServer,
      enabledTools,
      mcpEnv
    };
    
    log.info('prep() completed', { 
      mcpServer,
      enabledToolsCount: enabledTools.length
    });
    
    return prepResult;
  }

  async execCore(prepResult: MCPNodePrepResult, node_params?: MCPNodeParams): Promise<MCPNodeExecResult> {
    log.info('execCore() started', { 
      mcpServer: prepResult.mcpServer
    });
    
    // Add verbose logging of the entire prepResult
    log.verbose('execCore() prepResult', JSON.stringify(prepResult));
    
    try {
      // Execute MCP node using MCPHandler
      const result = await MCPHandler.executeMCP({
        mcpServer: prepResult.mcpServer,
        enabledTools: prepResult.enabledTools,
        mcpEnv: prepResult.mcpEnv
      });
      
      if (!result.success) {
        log.error('MCP execution failed', { error: result.error });
        throw new Error(`MCP execution failed: ${result.error.message}`);
      }
      
      // Create a properly typed ExecResult
      const execResult: MCPNodeExecResult = {
        success: true,
        server: result.value.server,
        tools: result.value.tools,
        enabledTools: result.value.enabledTools
      };
      
      log.info('execCore() completed', {
        server: execResult.server,
        toolsCount: execResult.tools?.length || 0,
        enabledToolsCount: execResult.enabledTools?.length || 0
      });
      
      // Add verbose logging of the entire execResult
      log.verbose('execCore() execResult', JSON.stringify(execResult));
      
      return execResult;
    } catch (error) {
      // Create an error result
      const errorResult: MCPNodeExecResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
      
      log.error('execCore() failed', {
        error: errorResult.error
      });
      
      // Add verbose logging of the error result
      log.verbose('execCore() errorResult', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }

  async post(
    prepResult: MCPNodePrepResult, 
    execResult: MCPNodeExecResult, 
    sharedState: SharedState, 
    node_params?: MCPNodeParams
  ): Promise<string> {
    log.info('post() started', { 
      server: execResult.server,
      toolsCount: execResult.tools?.length || 0,
      enabledToolsCount: execResult.enabledTools?.length || 0
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
        nodeType: 'MCPNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'MCP Node',
        timestamp: new Date().toISOString()
      });
      log.info('Added MCPNode tracking information');
    }
    
    // Store MCP context in shared state if execution was successful
    if (execResult.success && execResult.server && execResult.tools) {
      // Filter available tools based on enabled tools
      const availableTools = execResult.tools
        .filter(tool => execResult.enabledTools?.includes(tool.name))
        .map(tool => {
          // Create a copy of the tool with the name formatted
          return {
            ...tool,
            originalName: tool.name,
            name: `_-_-_${execResult.server}_-_-_${tool.name}`
          };
        });
      
      // Initialize mcpContext if it doesn't exist
      if (!sharedState.mcpContext) {
        sharedState.mcpContext = {
          server: execResult.server,
          availableTools
        };
      } else {
        // Merge with existing tools, avoiding duplicates
        const existingTools = sharedState.mcpContext.availableTools || [];
        const mergedTools = [...existingTools];
        
        // Add new tools that don't already exist
        for (const tool of availableTools) {
          if (!mergedTools.some(t => t.name === tool.name)) {
            mergedTools.push(tool);
          }
        }
        
        sharedState.mcpContext.availableTools = mergedTools;
      }
      
      // Get tool names for logging
      const toolNames = availableTools.map(tool => tool.name);
      
      log.info('Stored MCP context in shared state', { 
        server: execResult.server,
        availableToolsCount: availableTools.length,
        availableToolNames: toolNames.length > 10 ? 
          toolNames.slice(0, 10).join(', ') + '...' : toolNames.join(', '),
        totalToolsCount: sharedState.mcpContext.availableTools.length
      });
    }
    
    log.info('post() completed');
    
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
      log.info(`Returning action: ${action}`);
      return action;
    }
    
    return "default"; // Default fallback
  }

  _clone(): BaseNode {
    return new MCPNode();
  }
}

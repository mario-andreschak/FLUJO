import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('backend/flow/execution/nodes/util/MCPNodeUtility');

export class MCPNodeUtility {
  /**
   * Prepare MCP node by extracting properties and storing in shared state
   */
  static async prepNode(sharedState: any, node_params?: any): Promise<any> {
    log.info('prepNode() started');
    
    // Extract properties
    const boundServer = node_params?.properties?.boundServer;
    const enabledTools = node_params?.properties?.enabledTools || [];
    const env = node_params?.properties?.env || {};
    
    log.info('Extracted properties', { 
      boundServer, 
      enabledToolsCount: enabledTools.length,
      enabledTools: enabledTools.length > 10 ? 
        enabledTools.slice(0, 10).join(', ') + '...' : enabledTools.join(', '),
      envKeys: Object.keys(env),
      envCount: Object.keys(env).length
    });
    
    if (!boundServer) {
      log.error('Missing bound server');
      throw new Error("MCP node requires a bound server");
    }
    
    // Store in shared state
    sharedState.mcpServer = boundServer;
    sharedState.enabledTools = enabledTools;
    sharedState.mcpEnv = env;
    
    log.info('prepNode() completed', { 
      mcpServer: sharedState.mcpServer,
      enabledToolsCount: sharedState.enabledTools.length
    });
    
    return sharedState;
  }

  /**
   * Execute MCP node core functionality
   */
  static async executeNode(prepResult: any, node_params?: any): Promise<any> {
    log.info('executeNode() started', { 
      mcpServer: prepResult.mcpServer
    });
    
    const serverName = prepResult.mcpServer;
    
    // Check server status
    log.info('Checking server status', { serverName });
    const status = await mcpService.getServerStatus(serverName);
    log.info('Server status', { serverName, status });
    
    if (status.message !== 'connected') {
      log.info('Server not connected, attempting to connect', { serverName });
      // Try to connect
      const connectResult = await mcpService.connectServer(
        serverName,
      );
      
      if (!connectResult.success) {
        log.error('Failed to connect to server', { 
          serverName, 
          error: connectResult.error 
        });
        throw new Error(`Failed to connect to MCP server: ${connectResult.error}`);
      }
      
      log.info('Successfully connected to server', { serverName });
    }
    
    // Return the available tools
    log.info('Listing server tools', { serverName });
    const toolsResult = await mcpService.listServerTools(serverName);
    
    const result = {
      server: serverName,
      tools: toolsResult.tools || [],
      enabledTools: prepResult.enabledTools
    };
    
    log.info('executeNode() completed', { 
      server: result.server,
      toolsCount: result.tools.length,
      enabledToolsCount: result.enabledTools.length
    });
    
    return result;
  }

  /**
   * Process MCP node results and update shared state
   */
  static async postProcess(
    prepResult: any, 
    execResult: any, 
    sharedState: any, 
    node_params?: any, 
    successors?: Map<string, any> | Record<string, any>
  ): Promise<string> {
    log.info('postProcess() started', { 
      server: execResult.server,
      toolsCount: execResult.tools?.length || 0,
      enabledToolsCount: execResult.enabledTools?.length || 0
    });
    
    // // Store MCP context in shared state
    // const availableTools = execResult.tools.filter(
    //   (tool: any) => execResult.enabledTools.includes(tool.name)
    // );
    const availableTools = execResult.tools.filter(
      (tool: any) => execResult.enabledTools.includes(tool.name)
    ).map((tool: any)  => {
      // Create a copy of the tool with the name formatted
      return {
        ...tool,
        name: `tool:${execResult.server}:${tool.name}`
      };
    });
    
    sharedState.mcpContext = {
      server: execResult.server,
      availableTools
    };
    
    // Get tool names for logging
    const toolNames = availableTools.map((tool: any) => tool.name);
    
    log.info('postProcess() completed', { 
      server: sharedState.mcpContext.server,
      availableToolsCount: sharedState.mcpContext.availableTools.length,
      availableToolNames: toolNames.length > 10 ? 
        toolNames.slice(0, 10).join(', ') + '...' : toolNames.join(', ')
    });
    
    // Get the successors for this node
    
    // Log the successors object for debugging
    log.info('Successors object:', {
      hasSuccessors: !!successors,
      isMap: successors instanceof Map,
      type: typeof successors
    });
    
    // Handle successors as a Map (which is what PocketFlowFramework uses)
    const actions = successors instanceof Map 
      ? Array.from(successors.keys()) 
      : Object.keys(successors || {});
    
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
}

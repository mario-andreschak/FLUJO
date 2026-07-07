import { createLogger } from '@/utils/logger';
import { 
  MCPExecutionInput, 
  MCPExecutionResult 
} from '../types/mcpHandler';
import { Result } from '../errors';
import { createMCPError } from '../errorFactory';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('backend/flow/execution/handlers/MCPHandler');

export class MCPHandler {
  /**
   * Execute MCP operation - pure function
   */
  static async executeMCP(
    input: MCPExecutionInput
  ): Promise<Result<MCPExecutionResult>> {
    const { mcpServer, enabledTools, nodeId, nodeRoots } = input;
    
    // Add verbose logging of the input
    log.verbose('executeMCP input', JSON.stringify(input));
    
    try {
      // Node-level roots (issue 46): register this node's workspace-folder overlay
      // up front. Connections are singletons keyed by server name, so node roots are
      // additive - roots/list answers with the union of server-level and node-level
      // roots (falling back to the server's rootPath when there are none). The roots
      // capability is always declared, so this never requires a reconnect; a connected
      // server is notified via notifications/roots/list_changed. An empty list clears
      // this node's previous overlay.
      if (nodeId) {
        mcpService.setNodeRoots(mcpServer, nodeId, nodeRoots);
      }

      // Check server status. getServerStatus reports the connection state in `status`
      // (not `message`, which only carries error/auth detail) - checking the wrong field
      // here previously made this branch always run, masking the real intent.
      const status = await mcpService.getServerStatus(mcpServer);

      if (status.status !== 'connected') {
        // Try to connect
        const connectResult = await mcpService.connectServer(mcpServer);
        
        if (!connectResult.success) {
          const errorResult: Result<MCPExecutionResult> = {
            success: false,
            error: createMCPError(
              'server_connection_failed',
              `Failed to connect to MCP server: ${connectResult.error}`,
              mcpServer,
              'connect'
            )
          };
          
          // Add verbose logging of the connection error
          log.verbose('executeMCP connection error', JSON.stringify(errorResult));
          
          return errorResult;
        }
      }
      
      // List server tools
      const toolsResult = await mcpService.listServerTools(mcpServer);
      
      if (toolsResult.error) {
        const errorResult: Result<MCPExecutionResult> = {
          success: false,
          error: createMCPError(
            'list_tools_failed',
            `Failed to list tools for server: ${toolsResult.error}`,
            mcpServer,
            'listTools'
          )
        };
        
        // Add verbose logging of the list tools error
        log.verbose('executeMCP list tools error', JSON.stringify(errorResult));
        
        return errorResult;
      }
      
      const result: Result<MCPExecutionResult> = {
        success: true,
        value: {
          server: mcpServer,
          tools: toolsResult.tools || [],
          enabledTools
        }
      };
      
      // Add verbose logging of the successful result
      log.verbose('executeMCP success result', JSON.stringify(result));
      
      return result;
    } catch (error) {
      const errorResult: Result<MCPExecutionResult> = {
        success: false,
        error: createMCPError(
          'mcp_execution_failed',
          error instanceof Error ? error.message : String(error),
          mcpServer,
          'executeMCP'
        )
      };
      
      // Add verbose logging of the execution error
      log.verbose('executeMCP execution error', JSON.stringify(errorResult));
      
      return errorResult;
    }
  }
}

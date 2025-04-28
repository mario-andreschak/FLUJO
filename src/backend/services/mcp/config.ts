import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPServiceResponse, MCPSSEConfig, MCPStreamableConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/config');

/**
 * Load MCP server configurations from storage
 */
export async function loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
  log.debug('Entering loadServerConfigs method');
  try {
    const mcpServers = await loadItem<Record<string, any>>(StorageKey.MCP_SERVERS, {});
    
    return Object.entries(mcpServers).map(([name, serverConfig]) => {
      // Determine the transport type
      const transport = serverConfig.transport || 'stdio';
      
      // Default values for any missing properties
      const defaults = {
        name,
        disabled: false,
        autoApprove: [],
        rootPath: '',
        env: {},
        _buildCommand: '',
        _installCommand: ''
      };
      
      if (transport === 'streamable') {
        // Create streamable config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          authProvider: serverConfig.authProvider || '',
          requestInit: serverConfig.requestInit || '',
          reconnectionOptions: serverConfig.reconnectionOptions || '',
          sessionId: serverConfig.sessionId || ''
        } as MCPStreamableConfig;


      } else if (transport === 'sse') {
        // Create sse config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          authProvider: serverConfig.authProvider || '',
          eventSourceInit: serverConfig.eventSourceInit || '',
          requestInit: serverConfig.requestInit || ''
        } as MCPSSEConfig;


      } else if (transport === 'websocket') {
        // Create WebSocket config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          websocketUrl: serverConfig.websocketUrl || ''
        } as MCPWebSocketConfig;


      } else {
        // Create Stdio config with defaults
        return {
          ...defaults,
          ...serverConfig,
          name, // Ensure name is set correctly
          command: serverConfig.command || '',
          args: serverConfig.args || [],
          stderr: serverConfig.stderr || 'pipe'
        } as MCPStdioConfig;
      }
    });
  } catch (error) {
    log.warn('Failed to load server configs', error);
    return {
      success: false,
      error: `Failed to load server configs: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Save MCP server configurations to storage
 */
export async function saveConfig(configs: Map<string, MCPServerConfig>): Promise<MCPServiceResponse> {
  log.debug('Entering saveConfig method');
  try {
    const mcpServers = Object.fromEntries(
      Array.from(configs.entries()).map(([name, config]) => {
        // Remove the name property since it's used as the key
        const { name: _, ...configWithoutName } = config;
        
        // Return the entry with the server name as the key
        return [name, configWithoutName];
      })
    );

    await saveItem(StorageKey.MCP_SERVERS, mcpServers);
    return { success: true };
  } catch (error) {
    log.warn('Failed to save config', error);
    return {
      success: false,
      error: `Failed to save config: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPServiceResponse } from '@/shared/types/mcp';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/config-adapter');

/**
 * Load MCP server configurations from storage
 * 
 * This adapter delegates to the backend service
 */
export async function loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
  log.debug('Delegating loadServerConfigs to backend service');
  return mcpService.loadServerConfigs();
}

/**
 * Save MCP server configurations to storage
 * 
 * This adapter delegates to the backend service
 */
export async function saveConfig(configs: Map<string, MCPServerConfig>): Promise<MCPServiceResponse> {
  log.debug('This adapter method is deprecated. Use mcpService.updateServerConfig instead');
  
  // This is a compatibility layer that shouldn't be used directly
  // Instead, use mcpService.updateServerConfig for each config
  
  try {
    // Process each config individually
    for (const [name, config] of configs.entries()) {
      await mcpService.updateServerConfig(name, config);
    }
    
    return { success: true };
  } catch (error) {
    log.warn('Failed to save configs through adapter:', error);
    return {
      success: false,
      error: `Failed to save config: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

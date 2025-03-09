import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPServiceResponse } from '@/shared/types/mcp';

// Import from adapter
import { loadServerConfigs as loadServerConfigsAdapter, saveConfig as saveConfigAdapter } from './config-adapter';

const log = createLogger('app/api/mcp/config');

/**
 * Load MCP server configurations from storage
 * 
 * This function delegates to the adapter
 */
export async function loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
  log.debug('Delegating to adapter');
  return loadServerConfigsAdapter();
}

/**
 * Save MCP server configurations to storage
 * 
 * This function delegates to the adapter
 */
export async function saveConfig(configs: Map<string, MCPServerConfig>): Promise<MCPServiceResponse> {
  log.debug('Delegating to adapter');
  return saveConfigAdapter(configs);
}

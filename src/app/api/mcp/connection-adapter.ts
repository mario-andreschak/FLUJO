import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig } from '@/shared/types/mcp';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/connection-adapter');

/**
 * Create a new MCP client with proper capabilities
 * 
 * This adapter delegates to the backend service
 */
export function createNewClient(config: MCPServerConfig): Client {
  log.debug('This adapter method is deprecated. Use mcpService directly');
  
  // Get the client from the backend service if it exists
  const existingClient = mcpService.getClient(config.name);
  if (existingClient) {
    return existingClient;
  }
  
  // Otherwise, throw an error - clients should be created through the backend service
  throw new Error('Clients should be created through the backend service');
}

/**
 * Create a transport for the MCP client
 * 
 * This adapter is deprecated and should not be used directly
 */
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport {
  log.debug('This adapter method is deprecated. Use mcpService directly');
  throw new Error('Transports should be created through the backend service');
}

/**
 * Check if an existing client needs to be recreated
 * 
 * This adapter is deprecated and should not be used directly
 */
export function shouldRecreateClient(
  client: Client,
  config: MCPServerConfig
): { needsNewClient: boolean; reason?: string } {
  log.debug('This adapter method is deprecated. Use mcpService directly');
  return { needsNewClient: false };
}

/**
 * Safely close a client connection following the MCP shutdown sequence
 * 
 * This adapter delegates to the backend service
 */
export async function safelyCloseClient(client: Client, serverName: string): Promise<void> {
  log.debug('Delegating to mcpService.disconnectServer');
  await mcpService.disconnectServer(serverName);
}

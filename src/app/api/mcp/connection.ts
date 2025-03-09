import { createLogger } from '@/utils/logger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { MCPServerConfig } from '@/shared/types/mcp';

// Import from adapter
import {
  createNewClient as createNewClientAdapter,
  createTransport as createTransportAdapter,
  shouldRecreateClient as shouldRecreateClientAdapter,
  safelyCloseClient as safelyCloseClientAdapter
} from './connection-adapter';

const log = createLogger('app/api/mcp/connection');

/**
 * Create a new MCP client with proper capabilities
 * 
 * This function delegates to the adapter
 */
export function createNewClient(config: MCPServerConfig): Client {
  log.debug('Delegating to adapter');
  return createNewClientAdapter(config);
}

/**
 * Create a transport for the MCP client
 * 
 * This function delegates to the adapter
 */
export function createTransport(config: MCPServerConfig): StdioClientTransport | WebSocketClientTransport {
  log.debug('Delegating to adapter');
  return createTransportAdapter(config);
}

/**
 * Check if an existing client needs to be recreated
 * 
 * This function delegates to the adapter
 */
export function shouldRecreateClient(
  client: Client,
  config: MCPServerConfig
): { needsNewClient: boolean; reason?: string } {
  log.debug('Delegating to adapter');
  return shouldRecreateClientAdapter(client, config);
}

/**
 * Safely close a client connection following the MCP shutdown sequence
 * 
 * This function delegates to the adapter
 */
export async function safelyCloseClient(client: Client, serverName: string): Promise<void> {
  log.debug('Delegating to adapter');
  return safelyCloseClientAdapter(client, serverName);
}

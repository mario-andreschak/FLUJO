import { createLogger } from '@/utils/logger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NextResponse } from 'next/server';
import { MCPToolResponse as ToolResponse } from '@/shared/types/mcp';

// Import from adapter
import { listServerTools as listToolsAdapter, callTool as callToolAdapter } from './tools-adapter';

const log = createLogger('app/api/mcp/tools');

/**
 * List tools available from an MCP server
 * 
 * This function delegates to the adapter
 */
export async function listServerTools(client: Client | undefined, serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
  log.debug('Delegating to adapter');
  return listToolsAdapter(client, serverName);
}

/**
 * Call a tool on an MCP server with support for progress tracking
 * 
 * This function delegates to the adapter
 */
export async function callTool(
  client: Client | undefined, 
  serverName: string, 
  toolName: string, 
  args: Record<string, unknown>, 
  timeout?: number
): Promise<NextResponse> {
  log.debug('Delegating to adapter');
  return callToolAdapter(client, serverName, toolName, args, timeout);
}

/**
 * Cancel a tool execution in progress
 * 
 * This function is deprecated and should not be used directly.
 * Tool cancellation is now handled by the backend service.
 */
export async function cancelToolExecution(client: Client, requestId: string, reason: string): Promise<void> {
  log.debug('This function is deprecated. Tool cancellation is now handled by the backend service');
  // No-op - cancellation is now handled by the backend service
}

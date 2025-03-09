import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { MCPToolResponse as ToolResponse, MCPServiceResponse } from '@/shared/types/mcp';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/tools-adapter');

/**
 * List tools available from an MCP server
 * 
 * This adapter delegates to the backend service
 */
export async function listServerTools(client: Client | undefined, serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
  log.debug('Delegating listServerTools to backend service');
  return mcpService.listServerTools(serverName);
}

/**
 * Call a tool on an MCP server with support for progress tracking
 * 
 * This adapter delegates to the backend service and converts the response to NextResponse
 */
export async function callTool(
  client: Client | undefined, 
  serverName: string, 
  toolName: string, 
  args: Record<string, unknown>, 
  timeout?: number
): Promise<NextResponse> {
  log.debug('Delegating callTool to backend service');
  
  const result = await mcpService.callTool(serverName, toolName, args, timeout);
  
  // Convert MCPServiceResponse to NextResponse
  return NextResponse.json(
    result, 
    { status: result.statusCode || (result.success ? 200 : 500) }
  );
}

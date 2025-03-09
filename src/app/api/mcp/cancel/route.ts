import { NextRequest, NextResponse } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';
import { cancelToolExecution } from '@/app/api/mcp/tools';

const log = createLogger('app/api/mcp/cancel/route');

/**
 * API endpoint to cancel a tool execution in progress
 */
export async function POST(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const token = searchParams.get('token');
  const serverName = searchParams.get('serverName');
  
  if (!serverName) {
    log.error('Missing serverName parameter');
    return NextResponse.json({ error: 'Missing serverName parameter' }, { status: 400 });
  }
  
  try {
    // Get the client for this server
    const client = mcpService.getClient(serverName);
    if (!client) {
      log.error(`Server "${serverName}" not found or not connected`);
      return NextResponse.json({ error: `Server "${serverName}" not found or not connected` }, { status: 404 });
    }
    
    // Parse the request body to get the reason
    const body = await request.json();
    const reason = body.reason || 'User cancelled operation';
    
    if (token) {
      // If we have a token, use the standard cancellation mechanism
      log.info(`Cancelling tool execution with token ${token} for server ${serverName}`);
      await cancelToolExecution(client, token, reason);
    } else {
      // If no token is provided, attempt to force-cancel by closing and reconnecting the client
      log.info(`Force-cancelling all operations for server ${serverName} (no token provided)`);
      
      // First, try to disconnect the server
      await mcpService.disconnectServer(serverName);
      
      // Then, reconnect the server using the existing configuration
      // This uses the public connectServer method which will load the config internally
      const reconnectResult = await mcpService.connectServer(serverName);
      
      if (reconnectResult.success) {
        log.info(`Successfully reconnected server ${serverName} after force-cancel`);
      } else {
        log.warn(`Could not reconnect server ${serverName} after force-cancel: ${reconnectResult.error}`);
      }
    }
    
    log.info(`Successfully processed cancellation request for server ${serverName}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error(`Error cancelling tool execution: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return NextResponse.json(
      { error: `Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

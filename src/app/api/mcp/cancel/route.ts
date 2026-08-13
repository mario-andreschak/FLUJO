import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';
import { assertLocalRequest } from '@/utils/http/localRequest';

const log = createLogger('app/api/mcp/cancel/route');

/**
 * API endpoint to cancel a tool execution in progress
 */
async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const searchParams = request.nextUrl.searchParams;
  const token = searchParams.get('token');
  const serverName = searchParams.get('serverName');
  
  if (!serverName) {
    log.error('Missing serverName parameter');
    return NextResponse.json({ error: 'Missing serverName parameter' }, { status: 400 });
  }

  // Without a transport token this endpoint disconnects the entire server,
  // cancelling every in-flight operation that uses it. That can include
  // Persona-owned Activities, so the global force-cancel is a strict local
  // control-plane action even when ordinary MCP administration is exposed.
  if (!token) {
    const notLoopback = assertLocalRequest(request, { strictLoopback: true });
    if (notLoopback) return notLoopback;
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
      // Token-based cancellation is handled by the backend service / MCP transport itself;
      // there is no per-token cancel hook to invoke here. Logged for traceability.
      log.info(`Cancellation requested with token ${token} for server ${serverName} (reason: ${reason})`);
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

export const POST = withWorkspaceRoute(POST_handler);

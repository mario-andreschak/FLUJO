import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { formatErrorResponse } from '../../../utils/mcp/utils';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('app/api/mcp/handlers');

/**
 * Handle GET requests
 * 
 * This simplified version focuses on providing a clean API interface
 * without complex error handling or state management.
 */
export async function GET(request: NextRequest) {
  log.debug('Entering GET method');
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  const serverName = searchParams.get('server');

  if (!action) {
    return NextResponse.json({ success: false, error: 'Missing action parameter' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'loadConfigs':
        const configs = await mcpService.loadServerConfigs();
        if ('error' in configs) {
          return NextResponse.json({ success: false, error: configs.error }, { status: 500 });
        }
        return NextResponse.json({ success: true, configs });

      case 'listTools':
        if (!serverName) {
          return NextResponse.json({ success: false, error: 'Missing server parameter' }, { status: 400 });
        }
        const tools = await mcpService.listServerTools(serverName);
        return NextResponse.json({
          success: !tools.error,
          ...tools
        });

      case 'status':
        if (!serverName) {
          return NextResponse.json({ success: false, error: 'Missing server parameter' }, { status: 400 });
        }
        const status = await mcpService.getServerStatus(serverName);
        // Always return success: true for status requests, even if the server is in error state
        // This prevents the frontend from treating a disconnected server as a config update failure
        return NextResponse.json({
          success: true,
          ...status
        });

      default:
        return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('API Error in GET method', error);
    return NextResponse.json(
      { success: false, ...formatErrorResponse(error) },
      { status: 500 }
    );
  }
}

/**
 * Handle POST requests
 */
export async function POST(request: NextRequest) {
  log.debug('Entering POST method');
  try {
    const body = await request.json();
    const { action, serverName, ...data } = body;

    if (!action || !serverName) {
      return NextResponse.json({ success: false, error: 'Missing required parameters' }, { status: 400 });
    }

    switch (action) {
      case 'disconnect':
        const disconnected = await mcpService.disconnectServer(serverName);
        return NextResponse.json(disconnected);

      case 'updateConfig':
        try {
          const updated = await mcpService.updateServerConfig(serverName, data);
          
          // Check if there was an actual error updating the config
          if ('error' in updated) {
            log.warn(`Error updating config for ${serverName}:`, updated.error);
            return NextResponse.json({
              success: false,
              error: updated.error
            });
          }
          
          // Config update was successful
          log.info(`Successfully updated config for ${serverName}`);
          return NextResponse.json({
            success: true,
            data: updated
          });
        } catch (error) {
          log.error(`Exception updating config for ${serverName}:`, error);
          return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error updating server config'
          });
        }

      case 'callTool':
        const { toolName, args, timeout } = data;
        if (!toolName || !args) {
          return NextResponse.json({ success: false, error: 'Missing tool parameters' }, { status: 400 });
        }

        const toolResult = await mcpService.callTool(serverName, toolName, args, timeout);
        // Convert MCPServiceResponse to NextResponse
        return NextResponse.json(
          toolResult, 
          { status: toolResult.statusCode || (toolResult.success ? 200 : 500) }
        );

      case 'deleteConfig':
        const deleteResult = await mcpService.deleteServerConfig(serverName);
        return NextResponse.json(deleteResult);

      default:
        return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('API Error in POST method', error);
    return NextResponse.json(
      { success: false, ...formatErrorResponse(error) },
      { status: 500 }
    );
  }
}

/**
 * Handle PUT requests
 */
export async function PUT(request: NextRequest) {
  log.debug('Entering PUT method');
  try {
    const body = await request.json();
    const { serverName, ...updates } = body;

    if (!serverName) {
      return NextResponse.json({ success: false, error: 'Missing required parameters' }, { status: 400 });
    }

    const updatedConfig = await mcpService.updateServerConfig(serverName, updates);
    return NextResponse.json({
      success: !('error' in updatedConfig),
      data: !('error' in updatedConfig) ? updatedConfig : undefined,
      error: 'error' in updatedConfig ? updatedConfig.error : undefined
    });
  } catch (error) {
    log.error('API Error in PUT method', error);
    return NextResponse.json(
      { success: false, ...formatErrorResponse(error) },
      { status: 500 }
    );
  }
}

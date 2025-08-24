import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { mcpService } from '@/backend/services/mcp';

const log = createLogger('api/oauth/reset');

/**
 * Reset OAuth tokens for an MCP server
 * This endpoint clears stored OAuth tokens and forces re-authentication
 */
export async function POST(request: NextRequest) {
  try {
    const { serverName } = await request.json();

    if (!serverName) {
      return NextResponse.json(
        { error: 'Server name is required' },
        { status: 400 }
      );
    }

    log.info(`Resetting OAuth tokens for server: ${serverName}`);

    // Load server configurations
    const configsResult = await loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.error('Failed to load server configs', configsResult);
      return NextResponse.json(
        { error: 'Failed to load server configuration' },
        { status: 500 }
      );
    }

    // Find the server configuration
    const serverConfig = configsResult.find(config => config.name === serverName) as MCPStreamableConfig;
    if (!serverConfig || serverConfig.transport !== 'streamable') {
      log.error('Server configuration not found or not streamable', { serverName });
      return NextResponse.json(
        { error: 'Server configuration not found or not streamable' },
        { status: 404 }
      );
    }

    // Check if the server has OAuth tokens to reset
    if (!serverConfig.oauthTokens && !serverConfig.oauthClientInformation) {
      log.warn(`No OAuth tokens found for server ${serverName}`);
      return NextResponse.json(
        { error: 'No OAuth tokens found for this server' },
        { status: 400 }
      );
    }

    // Clear OAuth tokens and related data
    serverConfig.oauthTokens = undefined;
    serverConfig.oauthCodeVerifier = undefined;
    
    // Optionally clear client information to force re-registration
    // serverConfig.oauthClientInformation = undefined;
    // serverConfig.oauthClientMetadata = undefined;

    // Save updated configuration
    const configMap = new Map(configsResult.map(config => [config.name, config]));
    configMap.set(serverName, serverConfig);
    
    const saveResult = await saveConfig(configMap);
    if (!saveResult.success) {
      log.error('Failed to save updated configuration', saveResult);
      return NextResponse.json(
        { error: 'Failed to save configuration after token reset' },
        { status: 500 }
      );
    }

    // Disconnect the server to force re-authentication on next connection
    try {
      const disconnectResult = await mcpService.disconnectServer(serverName);
      if (!disconnectResult.success) {
        log.warn(`Failed to disconnect server ${serverName} after token reset:`, disconnectResult.error);
        // Don't fail the entire operation if disconnect fails
      } else {
        log.info(`Successfully disconnected server ${serverName} after token reset`);
      }
    } catch (error) {
      log.warn(`Error disconnecting server ${serverName} after token reset:`, error);
      // Don't fail the entire operation if disconnect fails
    }

    log.info(`Successfully reset OAuth tokens for server ${serverName}`);
    
    return NextResponse.json({
      success: true,
      message: `OAuth tokens reset for ${serverName}. The server will require re-authentication on next connection.`
    });

  } catch (error) {
    log.error('Unexpected error in OAuth token reset', error);
    return NextResponse.json(
      { error: 'Unexpected server error' },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { MCPStreamableConfig, MCPServiceResponse } from '@/shared/types/mcp';
import { exchangeAuthorization, discoverOAuthMetadata } from '@modelcontextprotocol/sdk/client/auth.js';

const log = createLogger('api/oauth/callback');

/**
 * Handle OAuth callback from MCP servers
 * This endpoint receives the authorization code and exchanges it for tokens
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    log.info('OAuth callback received', { 
      hasCode: !!code, 
      hasState: !!state, 
      hasError: !!error 
    });

    // Handle OAuth error responses
    if (error) {
      log.error('OAuth authorization error', { error, errorDescription });
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription || '')}`, request.url)
      );
    }

    // Validate required parameters
    if (!code || !state) {
      log.error('Missing required OAuth parameters', { code: !!code, state: !!state });
      return NextResponse.redirect(
        new URL('/mcp?oauth_error=invalid_request&error_description=Missing authorization code or state', request.url)
      );
    }

    // Parse state to get server name and other info
    let serverName: string;
    let redirectUri: string;
    try {
      const stateData = JSON.parse(decodeURIComponent(state));
      serverName = stateData.serverName;
      redirectUri = stateData.redirectUri;
      
      if (!serverName) {
        throw new Error('Server name not found in state');
      }
    } catch (parseError) {
      log.error('Invalid state parameter', { state, error: parseError });
      return NextResponse.redirect(
        new URL('/mcp?oauth_error=invalid_state&error_description=Invalid state parameter', request.url)
      );
    }

    log.info(`Processing OAuth callback for server: ${serverName}`);

    // Load server configurations
    const configsResult = await loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.error('Failed to load server configs', configsResult);
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=server_error&error_description=Failed to load server configuration`, request.url)
      );
    }

    // Find the server configuration
    const serverConfig = configsResult.find(config => config.name === serverName) as MCPStreamableConfig;
    if (!serverConfig || serverConfig.transport !== 'streamable') {
      log.error('Server configuration not found or not streamable', { serverName });
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=server_error&error_description=Server configuration not found`, request.url)
      );
    }

    // Get the server URL for OAuth metadata discovery
    const serverUrl = new URL(serverConfig.serverUrl);
    const baseUrl = `${serverUrl.protocol}//${serverUrl.host}`;

    try {
      // Discover OAuth metadata
      log.debug(`Discovering OAuth metadata for ${baseUrl}`);
      const oauthMetadata = await discoverOAuthMetadata(baseUrl);
      
      if (!oauthMetadata) {
        throw new Error('OAuth metadata not found');
      }

      // Get client information
      const clientInformation = serverConfig.oauthClientInformation;
      if (!clientInformation) {
        throw new Error('Client information not found');
      }

      // Get code verifier
      const codeVerifier = serverConfig.oauthCodeVerifier;
      if (!codeVerifier) {
        throw new Error('Code verifier not found');
      }

      log.debug(`Exchanging authorization code for tokens`);
      
      // Exchange authorization code for tokens
      const tokens = await exchangeAuthorization(baseUrl, {
        metadata: oauthMetadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier,
        redirectUri,
      });

      log.info(`Successfully obtained OAuth tokens for ${serverName}`);

      // Update server configuration with tokens
      serverConfig.oauthTokens = tokens;
      
      // Clear the code verifier as it's no longer needed
      delete serverConfig.oauthCodeVerifier;

      // Save updated configuration
      const configMap = new Map(configsResult.map(config => [config.name, config]));
      configMap.set(serverName, serverConfig);
      
      const saveResult = await saveConfig(configMap);
      if (!saveResult.success) {
        log.error('Failed to save updated configuration', saveResult);
        return NextResponse.redirect(
          new URL(`/mcp?oauth_error=server_error&error_description=Failed to save configuration`, request.url)
        );
      }

      log.info(`OAuth authentication completed successfully for ${serverName}`);

      // Redirect back to MCP page with success
      return NextResponse.redirect(
        new URL(`/mcp?oauth_success=${encodeURIComponent(serverName)}`, request.url)
      );

    } catch (exchangeError) {
      log.error('Failed to exchange authorization code', { 
        serverName, 
        error: exchangeError instanceof Error ? exchangeError.message : exchangeError 
      });
      
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=token_exchange_failed&error_description=${encodeURIComponent(exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed')}`, request.url)
      );
    }

  } catch (error) {
    log.error('Unexpected error in OAuth callback', error);
    return NextResponse.redirect(
      new URL(`/mcp?oauth_error=server_error&error_description=Unexpected server error`, request.url)
    );
  }
}

/**
 * Handle OAuth callback POST requests from MCP servers
 * Some OAuth providers send POST requests to the callback URL
 */
export async function POST(request: NextRequest) {
  try {
    // Parse form data from POST body
    const formData = await request.formData();
    const code = formData.get('code')?.toString();
    const state = formData.get('state')?.toString();
    const error = formData.get('error')?.toString();
    const errorDescription = formData.get('error_description')?.toString();

    log.info('OAuth callback POST received', { 
      hasCode: !!code, 
      hasState: !!state, 
      hasError: !!error 
    });

    // Handle OAuth error responses
    if (error) {
      log.error('OAuth authorization error', { error, errorDescription });
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription || '')}`, request.url)
      );
    }

    // Validate required parameters
    if (!code || !state) {
      log.error('Missing required OAuth parameters', { code: !!code, state: !!state });
      return NextResponse.redirect(
        new URL('/mcp?oauth_error=invalid_request&error_description=Missing authorization code or state', request.url)
      );
    }

    // Parse state to get server name and other info
    let serverName: string;
    let redirectUri: string;
    try {
      const stateData = JSON.parse(decodeURIComponent(state));
      serverName = stateData.serverName;
      redirectUri = stateData.redirectUri;
      
      if (!serverName) {
        throw new Error('Server name not found in state');
      }
    } catch (parseError) {
      log.error('Invalid state parameter', { state, error: parseError });
      return NextResponse.redirect(
        new URL('/mcp?oauth_error=invalid_state&error_description=Invalid state parameter', request.url)
      );
    }

    log.info(`Processing OAuth callback POST for server: ${serverName}`);

    // Load server configurations
    const configsResult = await loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.error('Failed to load server configs', configsResult);
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=server_error&error_description=Failed to load server configuration`, request.url)
      );
    }

    // Find the server configuration
    const serverConfig = configsResult.find(config => config.name === serverName) as MCPStreamableConfig;
    if (!serverConfig || serverConfig.transport !== 'streamable') {
      log.error('Server configuration not found or not streamable', { serverName });
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=server_error&error_description=Server configuration not found`, request.url)
      );
    }

    // Get the server URL for OAuth metadata discovery
    const serverUrl = new URL(serverConfig.serverUrl);
    const baseUrl = `${serverUrl.protocol}//${serverUrl.host}`;

    try {
      // Discover OAuth metadata
      log.debug(`Discovering OAuth metadata for ${baseUrl}`);
      const oauthMetadata = await discoverOAuthMetadata(baseUrl);
      
      if (!oauthMetadata) {
        throw new Error('OAuth metadata not found');
      }

      // Get client information
      const clientInformation = serverConfig.oauthClientInformation;
      if (!clientInformation) {
        throw new Error('Client information not found');
      }

      // Get code verifier
      const codeVerifier = serverConfig.oauthCodeVerifier;
      if (!codeVerifier) {
        throw new Error('Code verifier not found');
      }

      log.debug(`Exchanging authorization code for tokens`);
      
      // Exchange authorization code for tokens
      const tokens = await exchangeAuthorization(baseUrl, {
        metadata: oauthMetadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier,
        redirectUri,
      });

      log.info(`Successfully obtained OAuth tokens for ${serverName}`);

      // Update server configuration with tokens
      serverConfig.oauthTokens = tokens;
      
      // Clear the code verifier as it's no longer needed
      delete serverConfig.oauthCodeVerifier;

      // Save updated configuration
      const configMap = new Map(configsResult.map(config => [config.name, config]));
      configMap.set(serverName, serverConfig);
      
      const saveResult = await saveConfig(configMap);
      if (!saveResult.success) {
        log.error('Failed to save updated configuration', saveResult);
        return NextResponse.redirect(
          new URL(`/mcp?oauth_error=server_error&error_description=Failed to save configuration`, request.url)
        );
      }

      log.info(`OAuth authentication completed successfully for ${serverName}`);

      // Redirect back to MCP page with success
      return NextResponse.redirect(
        new URL(`/mcp?oauth_success=${encodeURIComponent(serverName)}`, request.url)
      );

    } catch (exchangeError) {
      log.error('Failed to exchange authorization code', { 
        serverName, 
        error: exchangeError instanceof Error ? exchangeError.message : exchangeError 
      });
      
      return NextResponse.redirect(
        new URL(`/mcp?oauth_error=token_exchange_failed&error_description=${encodeURIComponent(exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed')}`, request.url)
      );
    }

  } catch (error) {
    log.error('Unexpected error in OAuth callback POST', error);
    return NextResponse.redirect(
      new URL(`/mcp?oauth_error=server_error&error_description=Unexpected server error`, request.url)
    );
  }
}

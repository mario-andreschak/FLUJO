import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { discoverOAuthMetadata, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';

const log = createLogger('api/oauth/initiate');

/**
 * Initiate OAuth authentication for an MCP server
 * This endpoint handles dynamic client registration and returns the authorization URL
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

    log.info(`Initiating OAuth authentication for server: ${serverName}`);

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

    // Get the server URL for OAuth metadata discovery
    const serverUrl = new URL(serverConfig.serverUrl);
    const baseUrl = `${serverUrl.protocol}//${serverUrl.host}`;
    const redirectUri = `${request.nextUrl.origin}/api/oauth/callback`;

    try {
      // Discover OAuth metadata
      log.debug(`Discovering OAuth metadata for ${baseUrl}`);
      const oauthMetadata = await discoverOAuthMetadata(baseUrl);
      
      if (!oauthMetadata) {
        return NextResponse.json(
          { error: 'OAuth not supported by this server' },
          { status: 400 }
        );
      }

      log.debug('OAuth metadata discovered', { 
        authorizationEndpoint: oauthMetadata.authorization_endpoint,
        tokenEndpoint: oauthMetadata.token_endpoint,
        registrationEndpoint: oauthMetadata.registration_endpoint
      });

      // Check if we need to register the client
      let clientInformation = serverConfig.oauthClientInformation;
      
      if (!clientInformation && oauthMetadata.registration_endpoint) {
        log.info(`Registering OAuth client for ${serverName}`);
        
        // Prepare client metadata for registration
        const clientMetadata = {
          redirect_uris: [redirectUri],
          client_name: `FLUJO MCP Client - ${serverName}`,
          client_uri: 'https://github.com/mario-andreschak/FLUJO',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
          scope: serverConfig.oauthScopes?.join(' ') || 'read',
        };

        try {
          // Register the client
          const registrationResult = await registerClient(baseUrl, {
            metadata: oauthMetadata,
            clientMetadata,
          });

          log.info(`Client registered successfully for ${serverName}`);
          log.verbose('Registration result', JSON.stringify({
            ...registrationResult,
            client_secret: registrationResult.client_secret ? '[REDACTED]' : undefined,
          }));

          // Store client information
          clientInformation = {
            client_id: registrationResult.client_id,
            client_secret: registrationResult.client_secret,
            client_id_issued_at: registrationResult.client_id_issued_at,
            client_secret_expires_at: registrationResult.client_secret_expires_at,
          };

          // Update server configuration
          serverConfig.oauthClientInformation = clientInformation;
          serverConfig.oauthClientMetadata = clientMetadata;

        } catch (registrationError) {
          log.error('Failed to register OAuth client', { 
            serverName, 
            error: registrationError instanceof Error ? registrationError.message : registrationError 
          });
          return NextResponse.json(
            { error: 'Failed to register OAuth client' },
            { status: 500 }
          );
        }
      }

      if (!clientInformation) {
        return NextResponse.json(
          { error: 'No client credentials available and dynamic registration not supported' },
          { status: 400 }
        );
      }

      // Start authorization flow
      log.debug(`Starting authorization flow for ${serverName}`);
      const authResult = await startAuthorization(baseUrl, {
        metadata: oauthMetadata,
        clientInformation,
        redirectUrl: redirectUri,
      });

      log.info(`Authorization URL generated for ${serverName}`);

      // Store the code verifier
      serverConfig.oauthCodeVerifier = authResult.codeVerifier;

      // Add state parameter to the authorization URL
      const authUrl = new URL(authResult.authorizationUrl);
      const stateData = {
        serverName: serverName,
        redirectUri: redirectUri
      };
      const stateParam = encodeURIComponent(JSON.stringify(stateData));
      authUrl.searchParams.set('state', stateParam);
      
      log.debug(`Added state parameter to authorization URL for ${serverName}`);

      // Save updated configuration
      const configMap = new Map(configsResult.map(config => [config.name, config]));
      configMap.set(serverName, serverConfig);
      
      const saveResult = await saveConfig(configMap);
      if (!saveResult.success) {
        log.error('Failed to save updated configuration', saveResult);
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        );
      }

      // Return the authorization URL with state parameter
      return NextResponse.json({
        authorizationUrl: authUrl.toString(),
        serverName,
      });

    } catch (error) {
      log.error('Failed to initiate OAuth flow', { 
        serverName, 
        error: error instanceof Error ? error.message : error 
      });
      
      return NextResponse.json(
        { error: 'Failed to initiate OAuth authentication' },
        { status: 500 }
      );
    }

  } catch (error) {
    log.error('Unexpected error in OAuth initiation', error);
    return NextResponse.json(
      { error: 'Unexpected server error' },
      { status: 500 }
    );
  }
}

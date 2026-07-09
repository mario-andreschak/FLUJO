import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOAuthClientProvider } from '@/backend/services/mcp/oauth';

const log = createLogger('api/oauth/initiate');

/**
 * Initiate OAuth authentication for an MCP server.
 *
 * Delegates the entire discovery -> registration -> authorization dance to the MCP SDK's
 * `auth()` orchestrator (RFC 9728 protected-resource discovery, RFC 8414 authorization-server
 * discovery, dynamic client registration, PKCE) via MCPOAuthClientProvider, instead of hand-
 * rolling each step - so this stays correct as the SDK's auth implementation evolves.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { serverName } = await request.json();

    if (!serverName) {
      return NextResponse.json(
        { error: 'Server name is required' },
        { status: 400 }
      );
    }

    log.info(`Initiating OAuth authentication for server: ${serverName}`);

    const configsResult = await loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.error('Failed to load server configs', configsResult);
      return NextResponse.json(
        { error: 'Failed to load server configuration' },
        { status: 500 }
      );
    }

    const serverConfig = configsResult.find(config => config.name === serverName) as MCPStreamableConfig | undefined;
    if (!serverConfig || serverConfig.transport !== 'streamable') {
      log.error('Server configuration not found or not streamable', { serverName });
      return NextResponse.json(
        { error: 'Server configuration not found or not streamable' },
        { status: 404 }
      );
    }

    const redirectUri = `${request.nextUrl.origin}/api/oauth/callback`;
    // The provider mutates and persists `serverConfig` in place (see MCPOAuthClientProvider),
    // so client registration / discovery state / the authorization URL land in storage as
    // soon as auth() produces them - the route doesn't do any saving itself.
    const provider = createOAuthClientProvider(serverConfig, redirectUri);

    try {
      const result = await auth(provider, { serverUrl: serverConfig.serverUrl });

      if (result === 'AUTHORIZED') {
        // We already held a usable (or successfully refreshed) token - no user interaction
        // needed.
        log.info(`Server ${serverName} already has valid OAuth tokens`);
        return NextResponse.json({ alreadyAuthorized: true, serverName });
      }

      // 'REDIRECT': our provider's redirectToAuthorization() always throws (see oauth.ts) to
      // signal this case up through the connection stack, so in practice we won't get here -
      // but handle it defensively using whatever it stored.
      log.info(`Authorization URL generated for ${serverName}`);
      return NextResponse.json({ authorizationUrl: serverConfig.authorizationUrl, serverName });
    } catch (error) {
      if (error instanceof Error && error.name === 'OAuthAuthenticationRequired' && serverConfig.authorizationUrl) {
        log.info(`Authorization URL generated for ${serverName}`);
        return NextResponse.json({ authorizationUrl: serverConfig.authorizationUrl, serverName });
      }

      const rawMessage = error instanceof Error ? error.message : String(error);

      // Some authorization servers (e.g. Asana's V2 MCP server) disable Dynamic Client
      // Registration, so auth() can't self-register and needs a pre-registered app. Turn the
      // SDK's terse error into an actionable instruction pointing at the new credential fields.
      if (/dynamic client registration/i.test(rawMessage) && !serverConfig.oauthClientId) {
        log.info(`Server ${serverName} requires manual OAuth client credentials (no DCR)`);
        return NextResponse.json(
          {
            error:
              'This server does not support automatic app registration. Edit the server and enter ' +
              'the OAuth Client ID and Client Secret from the provider\'s developer console, then ' +
              'authenticate again.',
            needsClientCredentials: true,
            serverName,
          },
          { status: 400 }
        );
      }

      log.error('Failed to initiate OAuth flow', { serverName, error: rawMessage });
      return NextResponse.json(
        { error: rawMessage || 'Failed to initiate OAuth authentication' },
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

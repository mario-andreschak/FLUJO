import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOAuthClientProvider } from '@/backend/services/mcp/oauth';

const log = createLogger('api/oauth/callback');

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/**
 * Handle an OAuth callback from an MCP server's authorization server.
 *
 * Exchanges the authorization code for tokens via the MCP SDK's `auth()` orchestrator
 * (through the same MCPOAuthClientProvider used to initiate the flow), instead of calling
 * the lower-level token-exchange functions directly - so this stays correct as the SDK's
 * auth implementation evolves, and reuses whatever discovery/client-registration state
 * /api/oauth/initiate already persisted for this server.
 */
async function handleCallback(request: NextRequest, params: CallbackParams): Promise<NextResponse> {
  const { code, state, error, errorDescription } = params;

  log.info('OAuth callback received', { hasCode: !!code, hasState: !!state, hasError: !!error });

  if (error) {
    log.error('OAuth authorization error', { error, errorDescription });
    return NextResponse.redirect(
      new URL(`/mcp?oauth_error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription || '')}`, request.url)
    );
  }

  if (!code || !state) {
    log.error('Missing required OAuth parameters', { code: !!code, state: !!state });
    return NextResponse.redirect(
      new URL('/mcp?oauth_error=invalid_request&error_description=Missing authorization code or state', request.url)
    );
  }

  let serverName: string;
  try {
    const stateData = JSON.parse(decodeURIComponent(state));
    serverName = stateData.serverName;
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

  const configsResult = await loadServerConfigs();
  if (!Array.isArray(configsResult)) {
    log.error('Failed to load server configs', configsResult);
    return NextResponse.redirect(
      new URL(`/mcp?oauth_error=server_error&error_description=Failed to load server configuration`, request.url)
    );
  }

  const serverConfig = configsResult.find(config => config.name === serverName) as MCPStreamableConfig | undefined;
  if (!serverConfig || serverConfig.transport !== 'streamable') {
    log.error('Server configuration not found or not streamable', { serverName });
    return NextResponse.redirect(
      new URL(`/mcp?oauth_error=server_error&error_description=Server configuration not found`, request.url)
    );
  }

  const redirectUri = `${request.nextUrl.origin}/api/oauth/callback`;
  const provider = createOAuthClientProvider(serverConfig, redirectUri);

  try {
    const result = await auth(provider, { serverUrl: serverConfig.serverUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED') {
      throw new Error(`Unexpected authorization result: ${result}`);
    }

    // The code verifier is single-use and no longer needed once the exchange succeeds.
    await provider.invalidateCredentials?.('verifier');

    log.info(`OAuth authentication completed successfully for ${serverName}`);
    return NextResponse.redirect(new URL(`/mcp?oauth_success=${encodeURIComponent(serverName)}`, request.url));
  } catch (exchangeError) {
    log.error('Failed to exchange authorization code', {
      serverName,
      error: exchangeError instanceof Error ? exchangeError.message : exchangeError
    });

    return NextResponse.redirect(
      new URL(
        `/mcp?oauth_error=token_exchange_failed&error_description=${encodeURIComponent(exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed')}`,
        request.url
      )
    );
  }
}

/** GET callback - the form most authorization servers use. */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    return await handleCallback(request, {
      code: searchParams.get('code'),
      state: searchParams.get('state'),
      error: searchParams.get('error'),
      errorDescription: searchParams.get('error_description'),
    });
  } catch (error) {
    log.error('Unexpected error in OAuth callback', error);
    return NextResponse.redirect(new URL(`/mcp?oauth_error=server_error&error_description=Unexpected server error`, request.url));
  }
}

/** POST callback - some authorization servers submit the result as form data instead. */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    return await handleCallback(request, {
      code: formData.get('code')?.toString() ?? null,
      state: formData.get('state')?.toString() ?? null,
      error: formData.get('error')?.toString() ?? null,
      errorDescription: formData.get('error_description')?.toString() ?? null,
    });
  } catch (error) {
    log.error('Unexpected error in OAuth callback POST', error);
    return NextResponse.redirect(new URL(`/mcp?oauth_error=server_error&error_description=Unexpected server error`, request.url));
  }
}

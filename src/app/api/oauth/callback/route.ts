import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOAuthClientProvider, matchesOAuthState } from '@/backend/services/mcp/oauth';
import { getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('api/oauth/callback');

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

interface CallbackBinding {
  serverName: string;
  workspace: string;
  config: MCPStreamableConfig;
}

function redirectToMcp(
  request: NextRequest,
  workspace: string | undefined,
  params: Record<string, string>,
): NextResponse {
  const url = new URL('/mcp', request.url);
  if (workspace) url.searchParams.set('workspace', workspace);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
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
async function handleCallback(
  request: NextRequest,
  params: CallbackParams,
  binding: CallbackBinding,
): Promise<NextResponse> {
  const { code, state, error, errorDescription } = params;

  log.info('OAuth callback received', { hasCode: !!code, hasState: !!state, hasError: !!error });

  if (error) {
    log.error('OAuth authorization error', { error, errorDescription });
    return redirectToMcp(request, binding.workspace, {
      oauth_error: error,
      error_description: errorDescription || '',
    });
  }

  if (!code || !state) {
    log.error('Missing required OAuth parameters', { code: !!code, state: !!state });
    return redirectToMcp(request, binding.workspace, {
      oauth_error: 'invalid_request',
      error_description: 'Missing authorization code or state',
    });
  }

  const { serverName, workspace, config: serverConfig } = binding;

  log.info(`Processing OAuth callback for server: ${serverName}`);

  const redirectUrl = new URL('/api/oauth/callback', request.nextUrl.origin);
  redirectUrl.searchParams.set('workspace', workspace);
  const redirectUri = redirectUrl.toString();
  const provider = createOAuthClientProvider(serverConfig, redirectUri);

  try {
    const result = await auth(provider, { serverUrl: serverConfig.serverUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED') {
      throw new Error(`Unexpected authorization result: ${result}`);
    }

    // The code verifier is single-use and no longer needed once the exchange succeeds.
    await provider.invalidateCredentials?.('verifier');

    log.info(`OAuth authentication completed successfully for ${serverName}`);
    return redirectToMcp(request, workspace, { oauth_success: serverName });
  } catch (exchangeError) {
    log.error('Failed to exchange authorization code', {
      serverName,
      error: exchangeError instanceof Error ? exchangeError.message : exchangeError
    });

    return redirectToMcp(request, workspace, {
      oauth_error: 'token_exchange_failed',
      error_description: exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed',
    });
  }
}

async function handleWorkspaceCallback(
  request: NextRequest,
  params: CallbackParams,
): Promise<NextResponse> {
  const workspace = getCurrentWorkspace();
  const lock = await assertUnlocked();
  if (lock) return lock as NextResponse;

  const configsResult = await loadServerConfigs();
  if (!Array.isArray(configsResult)) {
    log.error('Failed to load MCP server configs while validating OAuth state', configsResult);
    return redirectToMcp(request, workspace, {
      oauth_error: 'server_error',
      error_description: 'Failed to load server configuration',
    });
  }

  const state = params.state;
  const serverConfig = state
    ? configsResult.find((config): config is MCPStreamableConfig =>
        config.transport === 'streamable' && matchesOAuthState(config, state, workspace))
    : undefined;

  if (!serverConfig) {
    log.error('OAuth callback carried invalid, expired, or cross-workspace state');
    return redirectToMcp(request, workspace, {
      oauth_error: 'invalid_state',
      error_description: 'Invalid state parameter',
    });
  }

  // Consume before exchange. A failed/replayed callback must start a new flow.
  serverConfig.oauthState = undefined;
  serverConfig.oauthStateWorkspace = undefined;
  serverConfig.oauthStateCreatedAt = undefined;
  const saveResult = await saveConfig(new Map(configsResult.map(config => [config.name, config])));
  if (!saveResult.success) {
    log.error('Failed to consume OAuth callback state', saveResult);
    return redirectToMcp(request, workspace, {
      oauth_error: 'server_error',
      error_description: 'Failed to consume OAuth state',
    });
  }

  return handleCallback(request, params, {
    serverName: serverConfig.name,
    workspace,
    config: serverConfig,
  });
}

/** GET callback - the form most authorization servers use. */
async function GET_handler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    return await handleWorkspaceCallback(request, {
      code: searchParams.get('code'),
      state: searchParams.get('state'),
      error: searchParams.get('error'),
      errorDescription: searchParams.get('error_description'),
    });
  } catch (error) {
    log.error('Unexpected error in OAuth callback', error);
    return redirectToMcp(request, undefined, {
      oauth_error: 'server_error',
      error_description: 'Unexpected server error',
    });
  }
}

/** POST callback - some authorization servers submit the result as form data instead. */
async function POST_handler(request: NextRequest) {
  try {
    const formData = await request.formData();
    return await handleWorkspaceCallback(request, {
      code: formData.get('code')?.toString() ?? null,
      state: formData.get('state')?.toString() ?? null,
      error: formData.get('error')?.toString() ?? null,
      errorDescription: formData.get('error_description')?.toString() ?? null,
    });
  } catch (error) {
    log.error('Unexpected error in OAuth callback POST', error);
    return redirectToMcp(request, undefined, {
      oauth_error: 'server_error',
      error_description: 'Unexpected server error',
    });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);

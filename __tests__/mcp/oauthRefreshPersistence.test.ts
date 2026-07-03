/**
 * Regression tests for OAuth token handling across restarts.
 *
 * Access tokens for MCP servers (e.g. Asana's, ~1h lifetime) routinely expire
 * between FLUJO sessions. That is NOT a reason to re-authenticate: the stored
 * refresh_token renews the grant silently on the next connection attempt.
 *
 * Two bugs previously forced an interactive re-auth after every access-token
 * lifetime:
 *  1. MCPOAuthClientProvider.tokens() deleted the whole token set (including
 *     the refresh_token) from disk the moment the access token was past its
 *     expiry - so the SDK's refresh_token grant path could never run.
 *  2. MCPService.getServerStatus() reported 'requires_authentication' on pure
 *     wall-clock expiry, without considering the stored refresh_token - so the
 *     server card showed the orange auth badge after every restart >1h.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
  resolveAndDecryptApiKey: jest.fn(async (v: string) => v),
}));

// Mutable server list so each test can shape the stored OAuth state.
const serverConfigs: Record<string, unknown>[] = [];

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => serverConfigs),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(),
  callTool: jest.fn(),
}));

jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(() => ({})),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

jest.mock('@/utils/mcp/directExecution', () => ({
  executeCommand: jest.fn(async () => ({ commandOutput: '' })),
}));

import { MCPService } from '@/backend/services/mcp';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { saveConfig } from '@/backend/services/mcp/config';
import { MCPStreamableConfig } from '@/shared/types/mcp';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function streamableServer(name: string, oauthTokens: Record<string, unknown> | undefined): MCPStreamableConfig {
  return {
    name,
    transport: 'streamable',
    serverUrl: 'https://mcp.example.com/mcp',
    disabled: false,
    autoApprove: [],
    rootPath: '',
    env: {},
    oauthScopes: ['read'],
    oauthTokens,
  } as unknown as MCPStreamableConfig;
}

beforeEach(() => {
  serverConfigs.length = 0;
  global.__mcp_recovery?.clear();
  global.__mcp_connecting?.clear();
  global.__mcp_starting_up = false;
  jest.clearAllMocks();
});

describe('MCPOAuthClientProvider.tokens() with an expired access token', () => {
  it('returns the token set intact (refresh_token included) instead of wiping it', async () => {
    const config = streamableServer('asana', {
      access_token: 'expired-access',
      refresh_token: 'still-valid-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      issued_at: nowSeconds() - 7200, // expired two hours ago
    });

    const provider = new MCPOAuthClientProvider(config, 'http://localhost:4200/api/oauth/callback');
    const tokens = await provider.tokens();

    // The SDK only attempts the silent refresh_token grant when tokens() yields one.
    expect(tokens?.refresh_token).toBe('still-valid-refresh');
    expect(tokens?.access_token).toBe('expired-access');
    // The stored token set must survive: no destructive persist.
    expect(config.oauthTokens).toBeDefined();
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe('MCPService.getServerStatus with expired OAuth tokens', () => {
  it('does NOT demand re-authentication when a refresh_token is stored', async () => {
    serverConfigs.push(streamableServer('asana', {
      access_token: 'expired-access',
      refresh_token: 'still-valid-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      issued_at: nowSeconds() - 7200,
    }));
    // Simulate the restart window where this used to flash the auth badge.
    global.__mcp_starting_up = true;
    const svc = new MCPService();

    const status = await svc.getServerStatus('asana');

    expect(status.status).not.toBe('requires_authentication');
    expect(status.status).toBe('connecting');
  });

  it('still demands re-authentication when tokens are expired and there is no refresh_token', async () => {
    serverConfigs.push(streamableServer('asana', {
      access_token: 'expired-access',
      token_type: 'bearer',
      expires_in: 3600,
      issued_at: nowSeconds() - 7200,
    }));
    const svc = new MCPService();

    const status = await svc.getServerStatus('asana');

    expect(status.status).toBe('requires_authentication');
  });

  it('still demands authentication when no tokens are stored at all', async () => {
    serverConfigs.push(streamableServer('asana', undefined));
    const svc = new MCPService();

    const status = await svc.getServerStatus('asana');

    expect(status.status).toBe('requires_authentication');
  });
});

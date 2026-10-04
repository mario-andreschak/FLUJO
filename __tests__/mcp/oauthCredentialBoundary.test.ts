import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { enrollPrivateEncryptionFixture } from '../utils/privateEncryptionFixture';

const mockLoadConfigs = jest.fn();
const mockSaveConfigs = jest.fn();
jest.mock('@/utils/logger', () => {
  const logger = { info: jest.fn(), verbose: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => logger };
});
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoadConfigs(), saveConfig: (configs: unknown) => mockSaveConfigs(configs),
}));

import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { createLogger } from '@/utils/logger';
const mockLog = createLogger('test') as unknown as Record<'info' | 'verbose' | 'debug' | 'warn' | 'error', jest.Mock>;

describe('OAuth credential logging and persistence acknowledgements', () => {
  let config: MCPStreamableConfig;
  let provider: MCPOAuthClientProvider;
  const tokens = {
    access_token: 'synthetic-new-access-secret', refresh_token: 'synthetic-new-refresh-secret',
    id_token: 'synthetic-extension-secret', token_type: 'bearer', expires_in: 60,
  } as OAuthTokens;
  const client: OAuthClientInformationFull = {
    client_id: 'synthetic-client', client_secret: 'synthetic-client-secret',
    redirect_uris: ['http://127.0.0.1:4200/api/oauth/callback'],
  };

  beforeEach(async () => {
    await enrollPrivateEncryptionFixture();
    for (const logger of Object.values(mockLog)) logger.mockReset();
    mockLoadConfigs.mockReset();
    mockSaveConfigs.mockReset().mockResolvedValue({ success: true });
    config = {
      name: 'synthetic-server', transport: 'streamable', serverUrl: 'https://mcp.invalid/mcp',
      rootPath: '', env: {}, disabled: true,
      _buildCommand: '', _installCommand: '',
      oauthTokens: { access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', token_type: 'bearer' },
      oauthClientInformation: { client_id: 'old-client', client_secret: 'synthetic-old-client-secret' },
      oauthCodeVerifier: 'synthetic-old-verifier',
    };
    mockLoadConfigs.mockResolvedValue([config]);
    provider = new MCPOAuthClientProvider(config, 'http://127.0.0.1:4200/api/oauth/callback');
  });
  function renderedLogs() { return JSON.stringify(Object.values(mockLog).flatMap(logger => logger.mock.calls)); }

  it('logs only fixed presence flags for client secrets and unknown token extensions', async () => {
    await provider.saveClientInformation(client);
    await provider.saveTokens(tokens);
    await provider.saveCodeVerifier('synthetic-new-verifier');
    for (const secret of [client.client_secret!, tokens.access_token, tokens.refresh_token!, 'synthetic-extension-secret', 'synthetic-new-verifier']) {
      expect(renderedLogs()).not.toContain(secret);
    }
    expect(mockLog.verbose).toHaveBeenCalledWith('Client information to save', { hasClientSecret: true });
    expect(mockLog.verbose).toHaveBeenCalledWith('Tokens to save', { hasAccessToken: true, hasRefreshToken: true });
    await expect(provider.tokens()).resolves.toMatchObject(tokens);
    await expect(provider.codeVerifier()).resolves.toBe('synthetic-new-verifier');
    await expect(provider.clientInformation()).resolves.toMatchObject(client);
    expect(JSON.stringify(config)).not.toContain(client.client_secret);
  });
  it('retains the browser authorization URL without logging its state or private parameters', async () => {
    const url = new URL('https://oauth.invalid/authorize?state=synthetic-private-state&extra=synthetic-private-parameter');
    await expect(provider.redirectToAuthorization(url)).rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(config.authorizationUrl).toBe(url.href);
    expect(renderedLogs()).not.toContain('synthetic-private-state');
    expect(renderedLogs()).not.toContain('synthetic-private-parameter');
  });
  it('keeps the previous active credential until storage acknowledges the staged replacement', async () => {
    let accept!: (result: { success: boolean }) => void;
    let stagedReady!: () => void;
    const stagedWritten = new Promise<void>(resolve => { stagedReady = resolve; });
    mockSaveConfigs.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; stagedReady(); }));
    const saving = provider.saveTokens(tokens);
    await Promise.race([stagedWritten, saving]);
    const staged = (mockSaveConfigs.mock.calls[0][0] as Map<string, MCPStreamableConfig>).get(config.name)!;
    expect(JSON.stringify(staged.oauthTokens)).not.toContain(tokens.access_token);
    expect(staged.oauthTokens).toMatchObject({ format: 'flujo-oauth-v1' });
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'synthetic-old-access' });
    accept({ success: true });
    await saving;
    await expect(provider.tokens()).resolves.toMatchObject(tokens);
  });
  it.each(['tokens', 'client', 'verifier', 'invalidation'] as const)('refuses false save success and preserves previous %s state', async kind => {
    const before = JSON.stringify(config);
    mockSaveConfigs.mockResolvedValueOnce({ success: false, error: 'synthetic-storage-secret' });
    const saving = kind === 'tokens' ? provider.saveTokens(tokens)
      : kind === 'client' ? provider.saveClientInformation(client)
        : kind === 'verifier' ? provider.saveCodeVerifier('synthetic-new-verifier')
          : provider.invalidateCredentials('all');
    await expect(saving).rejects.toThrow('OAuth credential persistence failed');
    expect(JSON.stringify(config)).toBe(before);
    expect(renderedLogs()).not.toContain('synthetic-storage-secret');
    expect(renderedLogs()).not.toContain('OAuth tokens saved');
    expect(renderedLogs()).not.toContain('Client information saved');
  });
  it('refuses unreadable configuration without acknowledging or replacing credentials', async () => {
    mockLoadConfigs.mockResolvedValueOnce({ success: false, error: 'synthetic-load-secret' });
    await expect(provider.saveTokens(tokens)).rejects.toThrow('OAuth credential persistence failed');
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'synthetic-old-access' });
    expect(mockSaveConfigs).not.toHaveBeenCalled();
    expect(renderedLogs()).not.toContain('synthetic-load-secret');
  });
  it('redacts thrown storage errors, including their cause, from the provider boundary', async () => {
    mockSaveConfigs.mockRejectedValueOnce(new Error('synthetic-thrown-secret'));
    let rejected: Error | undefined;
    try { await provider.saveTokens(tokens); } catch (error) { rejected = error as Error; }
    expect(rejected?.message).toContain('OAuth credential persistence failed');
    expect(rejected?.message).not.toContain('synthetic-thrown-secret');
    expect(rejected?.cause).toBeUndefined();
    expect(renderedLogs()).not.toContain('synthetic-thrown-secret');
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'synthetic-old-access' });
  });
  it('acknowledges successful explicit invalidation and preserves unrelated configuration', async () => {
    await provider.invalidateCredentials('all');
    expect(config.oauthTokens).toBeUndefined();
    expect(config.oauthClientInformation).toBeUndefined();
    expect(config.oauthCodeVerifier).toBeUndefined();
    expect(config.serverUrl).toBe('https://mcp.invalid/mcp');
  });
});

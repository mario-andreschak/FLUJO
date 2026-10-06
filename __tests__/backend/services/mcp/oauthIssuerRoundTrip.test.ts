const mockStore: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) => key in mockStore ? mockStore[key] : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => { mockStore[key] = JSON.parse(JSON.stringify(value)); }),
}));
jest.mock('simple-git', () => ({ __esModule: true, simpleGit: jest.fn(() => ({ getRemotes: jest.fn(async () => []) })) }));

import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { MCPOAuthClientProvider } from '@/backend/services/mcp/oauth';
import { StorageKey } from '@/shared/types/storage';
import type { MCPStreamableConfig } from '@/shared/types/mcp';

const issuer = 'https://authorization.example.test/tenant/';
beforeEach(() => { for (const key of Object.keys(mockStore)) delete mockStore[key]; });

async function loaded(): Promise<MCPStreamableConfig> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('expected configs');
  return configs[0] as MCPStreamableConfig;
}

it('round-trips operator issuer, exact SDK credential stamps and issued_at through actual config storage methods', async () => {
  const config: MCPStreamableConfig = { name: 'issuer-test', transport: 'streamable', serverUrl: 'https://mcp.example.test/mcp',
    rootPath: '', env: {}, disabled: true, source: { type: 'remote' },
    _buildCommand: '', _installCommand: '',
    oauthClientId: 'synthetic-manual-client', oauthIssuer: issuer };
  await saveConfig(new Map([[config.name, config]]));
  const provider = new MCPOAuthClientProvider(await loaded(), 'http://127.0.0.1:4200/api/oauth/callback');
  await provider.saveClientInformation({ client_id: 'synthetic-registered-client', issuer,
    redirect_uris: ['http://127.0.0.1:4200/api/oauth/callback'] });
  await provider.saveTokens({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', issuer, expires_in: 3600 });
  const first = await loaded();
  expect(first.oauthIssuer).toBe(issuer);
  expect(first.oauthClientInformation?.issuer).toBe(issuer);
  expect(first.oauthTokens?.issuer).toBe(issuer);
  expect((first.oauthTokens as { issued_at?: number }).issued_at).toEqual(expect.any(Number));
  const before = JSON.stringify(mockStore[StorageKey.MCP_SERVERS]);
  await saveConfig(new Map([[first.name, first]]));
  expect(JSON.stringify(mockStore[StorageKey.MCP_SERVERS])).toBe(before);
  const reloadedProvider = new MCPOAuthClientProvider(await loaded(), 'http://127.0.0.1:4200/api/oauth/callback');
  await expect(reloadedProvider.clientInformation()).resolves.toEqual(first.oauthClientInformation);
  await expect(reloadedProvider.tokens()).resolves.toEqual(first.oauthTokens);
});

it('loads legacy credentials unchanged but withholds them until fresh authorization without rewriting storage', async () => {
  mockStore[StorageKey.MCP_SERVERS] = { legacy: { transport: 'streamable', serverUrl: 'https://mcp.example.test/mcp',
    source: { type: 'remote' }, oauthClientInformation: { client_id: 'synthetic-legacy', client_secret: 'synthetic-legacy-secret' },
    oauthTokens: { access_token: 'synthetic-legacy-access', refresh_token: 'synthetic-legacy-refresh', token_type: 'bearer', issued_at: 123 } } };
  const before = JSON.stringify(mockStore[StorageKey.MCP_SERVERS]);
  const provider = new MCPOAuthClientProvider(await loaded(), 'http://127.0.0.1:4200/api/oauth/callback');
  await expect(provider.clientInformation()).resolves.toBeUndefined();
  await expect(provider.tokens()).resolves.toBeUndefined();
  expect(JSON.stringify(mockStore[StorageKey.MCP_SERVERS])).toBe(before);
});

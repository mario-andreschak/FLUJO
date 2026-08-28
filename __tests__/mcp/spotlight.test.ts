jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.modelcontextprotocol.io',
  registryGetJson: jest.fn(),
}));

import { loadSpotlightCache, refreshSpotlightServers } from '@/backend/services/spotlight';
import { registryGetJson } from '@/backend/utils/registryClient';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import {
  SpotlightCache,
  RegistryServerResult,
  getInstallOptions,
  buildConfigFromOption,
} from '@/utils/mcp/registry';

const SOURCE_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers/ai.parallel%2Fsearch-mcp/versions';
const OLD_URL = 'https://search-mcp.parallel.ai/mcp';
const ANONYMOUS_URL = 'https://search.parallel.ai/mcp';

const registryResult = (): RegistryServerResult => ({
  server: {
    name: 'ai.parallel/search-mcp',
    title: 'Parallel Search MCP',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: OLD_URL }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
});

const cached = (result = registryResult()): SpotlightCache => ({
  updatedAt: '2026-07-24T00:00:00.000Z',
  entries: [{ url: SOURCE_URL, result }],
});

const loadMock = jest.mocked(loadItem);
const saveMock = jest.mocked(saveItem);
const registryMock = jest.mocked(registryGetJson);

beforeEach(() => {
  jest.clearAllMocks();
  global.__flujo_spotlight_refresh = undefined;
  loadMock.mockResolvedValue(null);
  saveMock.mockResolvedValue(undefined);
});

describe('Spotlight remote endpoint corrections', () => {
  it('keeps an empty cache empty without fetching the registry', async () => {
    expect(await loadSpotlightCache()).toBeNull();
    expect(registryMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('builds the anonymous Parallel config from an existing cache before any refresh', async () => {
    const stored = cached();
    loadMock.mockResolvedValue(stored);

    const cache = await loadSpotlightCache();
    const server = cache!.entries[0].result!.server;
    const options = getInstallOptions(server);
    expect(options).toHaveLength(1);
    expect(options[0].label).toContain(ANONYMOUS_URL);
    const config = buildConfigFromOption(server, options[0]);
    expect(config).toMatchObject({
      transport: 'streamable',
      serverUrl: ANONYMOUS_URL,
      headers: {},
      source: { type: 'registry', registryName: 'ai.parallel/search-mcp', version: '1.0.0' },
    });
    expect(config).not.toHaveProperty('oauthClientId');
    expect(config).not.toHaveProperty('oauthClientInformation');
    expect(config).not.toHaveProperty('oauthTokens');
    expect(cache!.updatedAt).toBe(stored.updatedAt);
    expect(stored.entries[0].result!.server.remotes![0].url).toBe(OLD_URL);
    expect(loadMock).toHaveBeenCalledWith(StorageKey.SPOTLIGHT_SERVERS, null);
    expect(registryMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('changes only the configured source and exact URL, preserving registry inputs and metadata', async () => {
    const result = registryResult();
    result.server.remotes![0].headers = [{ name: 'X-Example', isRequired: true, isSecret: true }];
    result.server.remotes!.push({ type: 'sse', url: 'https://search.parallel.ai/another-endpoint' });
    result.server.packages = [{ registryType: 'npm', identifier: 'example-search' }];
    const stored = cached(result);
    stored.entries.push(
      { url: 'https://registry.modelcontextprotocol.io/?q=another-provider', result: registryResult() },
      { url: 'https://registry.modelcontextprotocol.io/?q=unavailable', error: 'Unavailable' },
    );
    const original = JSON.parse(JSON.stringify(stored));
    loadMock.mockResolvedValue(stored);

    const cache = await loadSpotlightCache();
    expect(cache!.entries[0].result).toEqual({
      ...result,
      server: {
        ...result.server,
        remotes: [
          { ...result.server.remotes![0], url: ANONYMOUS_URL },
          result.server.remotes![1],
        ],
      },
    });
    expect(cache!.entries.slice(1)).toEqual(stored.entries.slice(1));
    expect(stored).toEqual(original);
  });

  it('returns corrected fresh records while persisting the registry response unchanged', async () => {
    const result = registryResult();
    registryMock.mockImplementation(async url => ({
      servers: [url.searchParams.get('search') === 'ai.parallel/search-mcp'
        ? result
        : { server: { name: url.searchParams.get('search')!, remotes: [] } }],
    }));

    const cache = await refreshSpotlightServers();
    const entry = cache.entries.find(e => e.url === SOURCE_URL)!;
    expect(entry.result!.server.remotes![0].url).toBe(ANONYMOUS_URL);
    expect(entry.error).toBeUndefined();
    expect(registryMock).toHaveBeenCalledWith(
      new URL('https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.parallel%2Fsearch-mcp&version=latest&limit=1'),
      15000,
    );
    expect(cache.entries.find(e => e.url.includes('playwright-mcp'))!.env)
      .toEqual({ PLAYWRIGHT_MCP_BROWSER: 'msedge' });
    const persisted = saveMock.mock.calls[0][1] as SpotlightCache;
    expect(saveMock.mock.calls[0][0]).toBe(StorageKey.SPOTLIGHT_SERVERS);
    expect(persisted.entries.find(e => e.url === SOURCE_URL)!.result).toEqual(registryResult());
    expect(result).toEqual(registryResult());
  });

  it('corrects the previous good record after refresh failure without storing the correction', async () => {
    const stored = cached();
    loadMock.mockResolvedValue(stored);
    registryMock.mockRejectedValue(new Error('Registry unavailable'));

    const cache = await refreshSpotlightServers();
    const entry = cache.entries.find(e => e.url === SOURCE_URL)!;
    expect(entry.result!.server.remotes![0].url).toBe(ANONYMOUS_URL);
    expect(entry.error).toBe('Registry unavailable');
    const persisted = saveMock.mock.calls[0][1] as SpotlightCache;
    expect(persisted.entries.find(e => e.url === SOURCE_URL)!.result).toEqual(registryResult());
    expect(stored).toEqual(cached());
  });
});

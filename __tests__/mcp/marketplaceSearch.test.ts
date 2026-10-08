import {
  DEFAULT_MARKETPLACE_FILTERS,
  filterMarketplaceResults,
  hasActiveMarketplaceFilters,
  type MarketplaceSearchFilters,
} from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/MarketplaceTab/search';
import type { RegistryServerResult } from '@/utils/mcp/registry';

function result(
  name: string,
  options: {
    title?: string;
    local?: boolean;
    remote?: boolean;
    verified?: boolean;
    stars?: number;
    downloads?: number;
  } = {},
): RegistryServerResult {
  return {
    server: {
      name,
      title: options.title,
      ...(options.local
        ? { packages: [{ registryType: 'npm', identifier: name }] }
        : {}),
      ...(options.remote
        ? { remotes: [{ type: 'streamable-http', url: `https://${name}.example.com/mcp` }] }
        : {}),
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: options.verified ? 'active' : 'unverified',
      },
    },
    quality: {
      score: 0.5,
      stars: options.stars,
      weeklyDownloads: options.downloads,
      status: options.verified ? 'active' : 'unverified',
    },
  };
}

const RESULTS = [
  result('io.example/beta', { local: true, verified: true, stars: 10, downloads: 500 }),
  result('io.example/alpha', { title: 'Alpha', remote: true, stars: 50, downloads: 100 }),
  result('io.example/hybrid', { local: true, remote: true, verified: true }),
];

function filters(overrides: Partial<MarketplaceSearchFilters>): MarketplaceSearchFilters {
  return { ...DEFAULT_MARKETPLACE_FILTERS, ...overrides };
}

describe('Marketplace search filters', () => {
  it('combines transport, setup, and verification filters', () => {
    expect(filterMarketplaceResults(RESULTS, filters({
      transport: 'local',
      setup: 'automatic',
      verification: 'verified',
    })).map(item => item.server.name)).toEqual([
      'io.example/beta',
      'io.example/hybrid',
    ]);

    expect(filterMarketplaceResults(RESULTS, filters({ setup: 'manual' })))
      .toEqual([]);
  });

  it('sorts quality signals descending and leaves missing signals last', () => {
    expect(filterMarketplaceResults(RESULTS, filters({ sort: 'stars' })).map(item => item.server.name))
      .toEqual(['io.example/alpha', 'io.example/beta', 'io.example/hybrid']);
    expect(filterMarketplaceResults(RESULTS, filters({ sort: 'downloads' })).map(item => item.server.name))
      .toEqual(['io.example/beta', 'io.example/alpha', 'io.example/hybrid']);
  });

  it('sorts by display name without mutating the input order', () => {
    expect(filterMarketplaceResults(RESULTS, filters({ sort: 'name' })).map(item => item.server.name))
      .toEqual(['io.example/alpha', 'io.example/beta', 'io.example/hybrid']);
    expect(RESULTS.map(item => item.server.name))
      .toEqual(['io.example/beta', 'io.example/alpha', 'io.example/hybrid']);
  });

  it('detects whether filters differ from the default view', () => {
    expect(hasActiveMarketplaceFilters(DEFAULT_MARKETPLACE_FILTERS)).toBe(false);
    expect(hasActiveMarketplaceFilters(filters({ verification: 'verified' }))).toBe(true);
    expect(hasActiveMarketplaceFilters(filters({ sort: 'name' }))).toBe(true);
  });
});

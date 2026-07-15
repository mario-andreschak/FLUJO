// Keep the cache/settings IO off disk and deterministic.
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (_k: string, def: unknown) => def),
  saveItem: jest.fn(async () => {}),
}));

import { enrichAndRank } from '@/backend/services/mcp/quality/orchestrator';
import { defaultQualitySettings } from '@/backend/services/mcp/quality/settings';
import { __resetGithubProviderState } from '@/backend/services/mcp/quality/providers/githubStars';
import { __resetNpmProviderState } from '@/backend/services/mcp/quality/providers/npmDownloads';
import { ServerCandidate } from '@/backend/services/mcp/quality/types';
import { RegistryServer } from '@/utils/mcp/registry';

function mockRes(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function candidate(name: string, repo: string, pkg: string): ServerCandidate {
  return {
    registryName: name,
    server: {
      name,
      repository: { url: `https://github.com/${repo}`, source: 'github' },
      packages: [{ registryType: 'npm', identifier: pkg }],
    } as RegistryServer,
    verificationStatus: 'active',
  };
}

const NOW = Date.parse('2026-07-15T00:00:00Z');
const settings = defaultQualitySettings();

describe('enrichAndRank', () => {
  beforeEach(() => {
    __resetGithubProviderState();
    __resetNpmProviderState();
    jest.restoreAllMocks();
  });

  it('ranks a high-quality candidate above a low-quality one', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/repositories')) {
        return mockRes({
          items: [
            { full_name: 'a/high', stargazers_count: 5000, pushed_at: '2026-07-10T00:00:00Z' },
            { full_name: 'b/low', stargazers_count: 3, pushed_at: '2020-01-01T00:00:00Z' },
          ],
        });
      }
      if (url.includes('api.npmjs.org')) {
        return mockRes({ 'high-pkg': { downloads: 500000 }, 'low-pkg': { downloads: 4 } });
      }
      return mockRes({});
    });

    const low = candidate('io.x/low', 'b/low', 'low-pkg');
    const high = candidate('io.x/high', 'a/high', 'high-pkg');
    const ranked = await enrichAndRank('term', [low, high], { now: NOW, settings });

    expect(ranked[0].candidate.registryName).toBe('io.x/high');
    expect(ranked[1].candidate.registryName).toBe('io.x/low');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('degrades gracefully: a failing GitHub source still ranks by npm downloads', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/repositories')) throw new Error('github down');
      if (url.includes('api.npmjs.org')) {
        return mockRes({ 'high-pkg': { downloads: 500000 }, 'low-pkg': { downloads: 4 } });
      }
      return mockRes({});
    });

    const low = candidate('io.x/low', 'b/low', 'low-pkg');
    const high = candidate('io.x/high', 'a/high', 'high-pkg');
    const ranked = await enrichAndRank('term', [low, high], { now: NOW, settings });

    expect(ranked[0].candidate.registryName).toBe('io.x/high');
  });

  it('never throws — total failure falls back to registry order with zero scores', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network dead'));
    const a = candidate('io.x/a', 'x/a', 'a-pkg');
    const b = candidate('io.x/b', 'x/b', 'b-pkg');
    const ranked = await enrichAndRank('term', [a, b], { now: NOW, settings });
    // status provider still contributes equally (both active) → tie → stable order.
    expect(ranked.map((r) => r.candidate.registryName)).toEqual(['io.x/a', 'io.x/b']);
  });

  it('returns candidates unscored when no providers are enabled', async () => {
    const disabled = { ...settings, providers: settings.providers.map((p) => ({ ...p, enabled: false })) };
    const a = candidate('io.x/a', 'x/a', 'a-pkg');
    const ranked = await enrichAndRank('term', [a], { now: NOW, settings: disabled });
    expect(ranked[0].score).toBe(0);
    expect(ranked[0].signals).toEqual([]);
  });
});

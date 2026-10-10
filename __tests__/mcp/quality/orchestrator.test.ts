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

function isNpmApiRequest(input: Parameters<typeof fetch>[0]): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.protocol === 'https:' && url.hostname === 'api.npmjs.org';
}

it('routes fixture responses by the actual HTTPS hostname', () => {
  expect(isNpmApiRequest('https://api.npmjs.org/downloads/point/last-week/pkg')).toBe(true);
  for (const url of [
    'https://api.npmjs.org.attacker.test/downloads',
    'https://attacker.test/api.npmjs.org',
    'https://attacker.test/?target=api.npmjs.org',
    'https://api.npmjs.org@attacker.test/',
    'http://api.npmjs.org/downloads',
  ]) expect(isNpmApiRequest(url)).toBe(false);
});

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
      if (isNpmApiRequest(input)) {
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
      if (isNpmApiRequest(input)) {
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

  it('cancels active provider IO and never starts the next provider or candidate lookup', async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (input, options) => {
      requests.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        controller.abort(new DOMException('Research cancelled', 'AbortError'));
      });
    });
    const first = candidate('io.x/cancel-first', 'x/cancel-first', '@x/cancel-first');
    const second = candidate('io.x/cancel-second', 'x/cancel-second', '@x/cancel-second');
    await expect(enrichAndRank('cancel', [first, second], { now: NOW, settings, signal: controller.signal })).rejects.toThrow('Research cancelled');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/search/repositories');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation attached through provider response-body consumption', async () => {
    const controller = new AbortController();
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_input, options) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        controller.abort(new DOMException('Body cancelled', 'AbortError'));
      }),
    } as unknown as Response));
    await expect(enrichAndRank('body-cancel', [candidate('io.x/body-cancel', 'x/body-cancel', '@x/body-cancel')], { now: NOW, settings, signal: controller.signal })).rejects.toThrow('Body cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

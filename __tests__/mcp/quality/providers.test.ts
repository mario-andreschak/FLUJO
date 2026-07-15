import {
  githubProvider,
  parseGithubRepo,
  setGithubToken,
  __resetGithubProviderState,
} from '@/backend/services/mcp/quality/providers/githubStars';
import {
  npmDownloadsProvider,
  npmPackageName,
  __resetNpmProviderState,
} from '@/backend/services/mcp/quality/providers/npmDownloads';
import { registryStatusProvider } from '@/backend/services/mcp/quality/providers/registryStatus';
import { ServerCandidate } from '@/backend/services/mcp/quality/types';
import { RegistryServer } from '@/utils/mcp/registry';

function candidate(server: Partial<RegistryServer>, status = 'active'): ServerCandidate {
  return {
    registryName: server.name ?? 'io.example/thing',
    server: { name: 'io.example/thing', ...server } as RegistryServer,
    verificationStatus: status,
  };
}

interface ResInit {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
}
function mockRes(body: unknown, init: ResInit = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? init.headers?.[k] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const signal = () => new AbortController().signal;

describe('githubStars provider', () => {
  beforeEach(() => {
    __resetGithubProviderState();
    jest.restoreAllMocks();
  });

  describe('parseGithubRepo', () => {
    it('extracts owner/repo from assorted GitHub URLs', () => {
      expect(parseGithubRepo('https://github.com/Owner/Repo')).toBe('owner/repo');
      expect(parseGithubRepo('https://github.com/owner/repo.git')).toBe('owner/repo');
      expect(parseGithubRepo('git+https://github.com/owner/repo.git')).toBe('owner/repo');
      expect(parseGithubRepo('https://github.com/owner/repo/tree/main/sub')).toBe('owner/repo');
    });
    it('returns null for non-GitHub or malformed URLs', () => {
      expect(parseGithubRepo('https://gitlab.com/owner/repo')).toBeNull();
      expect(parseGithubRepo('https://github.com/owner')).toBeNull();
      expect(parseGithubRepo(undefined)).toBeNull();
      expect(parseGithubRepo('not a url')).toBeNull();
    });
  });

  it('TOKENLESS: does exactly ONE request (the search) — never per-repo lookups', async () => {
    setGithubToken(undefined);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockRes({ items: [{ full_name: 'a/found', stargazers_count: 1200, pushed_at: '2026-07-01T00:00:00Z' }] }));

    const inSearch = candidate({ repository: { url: 'https://github.com/a/found', source: 'github' } });
    const missing = candidate({ repository: { url: 'https://github.com/b/missing', source: 'github' } });

    await githubProvider.prefetch!('youtube', [inSearch, missing], signal());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/search/repositories');
  });

  it('joins search results to candidates by repo url; misses return null', async () => {
    setGithubToken(undefined);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockRes({ items: [{ full_name: 'a/found', stargazers_count: 1200, pushed_at: '2026-07-01T00:00:00Z' }] }));

    const inSearch = candidate({ repository: { url: 'https://github.com/a/found', source: 'github' } });
    const missing = candidate({ repository: { url: 'https://github.com/b/missing', source: 'github' } });
    await githubProvider.prefetch!('youtube', [inSearch, missing], signal());

    const hit = await githubProvider.fetch(inSearch, signal());
    expect(hit).not.toBeNull();
    expect(hit!.evidence.stars).toBe(1200);
    expect(hit!.score).toBeGreaterThan(0);

    expect(await githubProvider.fetch(missing, signal())).toBeNull();
  });

  it('WITH token: falls back to bounded per-repo lookups for search misses', async () => {
    setGithubToken('ghp_test');
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/search/repositories')) return mockRes({ items: [] });
      // direct /repos/{owner}/{repo}
      return mockRes({ stargazers_count: 42, pushed_at: '2026-06-01T00:00:00Z' });
    });

    const c = candidate({ repository: { url: 'https://github.com/b/missing', source: 'github' } });
    await githubProvider.prefetch!('youtube', [c], signal());

    // one search + one direct lookup
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hit = await githubProvider.fetch(c, signal());
    expect(hit!.evidence.stars).toBe(42);
  });

  it('is not applicable to non-GitHub repos', () => {
    expect(githubProvider.isApplicable(candidate({ repository: { url: 'https://gitlab.com/a/b' } }))).toBe(false);
    expect(githubProvider.isApplicable(candidate({ repository: { url: 'https://github.com/a/b' } }))).toBe(true);
  });
});

describe('npmDownloads provider', () => {
  beforeEach(() => {
    __resetNpmProviderState();
    jest.restoreAllMocks();
  });

  it('finds the npm package identifier', () => {
    expect(
      npmPackageName(candidate({ packages: [{ registryType: 'pypi', identifier: 'x' }, { registryType: 'npm', identifier: 'my-pkg' }] }))
    ).toBe('my-pkg');
    expect(npmPackageName(candidate({ packages: [{ registryType: 'oci', identifier: 'img' }] }))).toBeNull();
  });

  it('reads weekly downloads for a single unscoped package', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockRes({ package: 'left-pad', downloads: 5000 }));
    const c = candidate({ packages: [{ registryType: 'npm', identifier: 'left-pad' }] });
    await npmDownloadsProvider.prefetch!('pad', [c], signal());
    const sig = await npmDownloadsProvider.fetch(c, signal());
    expect(sig!.evidence.weeklyDownloads).toBe(5000);
    expect(sig!.score).toBeGreaterThan(0);
  });

  it('parses the bulk map shape for multiple unscoped packages', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      mockRes({ 'pkg-a': { downloads: 10 }, 'pkg-b': { downloads: 20 } })
    );
    const a = candidate({ name: 'a', packages: [{ registryType: 'npm', identifier: 'pkg-a' }] });
    const b = candidate({ name: 'b', packages: [{ registryType: 'npm', identifier: 'pkg-b' }] });
    await npmDownloadsProvider.prefetch!('x', [a, b], signal());
    expect((await npmDownloadsProvider.fetch(a, signal()))!.evidence.weeklyDownloads).toBe(10);
    expect((await npmDownloadsProvider.fetch(b, signal()))!.evidence.weeklyDownloads).toBe(20);
  });

  it('returns null when the package was never resolved', async () => {
    const c = candidate({ packages: [{ registryType: 'npm', identifier: 'never-fetched' }] });
    expect(await npmDownloadsProvider.fetch(c, signal())).toBeNull();
  });
});

describe('registryStatus provider', () => {
  it('scores active=1 and everything else=0', async () => {
    expect((await registryStatusProvider.fetch(candidate({}, 'active'), signal()))!.score).toBe(1);
    expect((await registryStatusProvider.fetch(candidate({}, 'deprecated'), signal()))!.score).toBe(0);
    expect((await registryStatusProvider.fetch(candidate({}, 'unverified'), signal()))!.score).toBe(0);
  });
  it('is always applicable and never cached', () => {
    expect(registryStatusProvider.isApplicable(candidate({}))).toBe(true);
    expect(registryStatusProvider.cacheKey(candidate({}))).toBeNull();
  });
});

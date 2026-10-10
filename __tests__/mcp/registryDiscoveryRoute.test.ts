const assertUnlockedMock = jest.fn();
const registryGetRawMock = jest.fn();
const rankRegistryResultsMock = jest.fn();
const discoverRegistryServersMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args) }));
jest.mock('@/backend/utils/registryClient', () => ({ REGISTRY_ORIGIN: 'https://registry.example.test', registryGetRaw: (...args: unknown[]) => registryGetRawMock(...args) }));
jest.mock('@/backend/services/mcp/registryInstall', () => ({ rankRegistryResults: (...args: unknown[]) => rankRegistryResultsMock(...args) }));
jest.mock('@/backend/services/mcp/registryDiscovery', () => ({ discoverRegistryServers: (...args: unknown[]) => discoverRegistryServersMock(...args) }));
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/mcp-registry/route';

const request = (search: string, cursor = '', limit = 2) => new NextRequest(`http://localhost/api/mcp-registry?${new URLSearchParams({ search, cursor, limit: String(limit) })}`);
describe('Marketplace discovery pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    discoverRegistryServersMock.mockResolvedValue({
      servers: ['one', 'two', 'three', 'four', 'five'].map(name => ({ server: { name: `io.example/${name}` } })),
      discovery: { bounded: true, terms: ['search'], partial: false, truncated: true },
    });
    rankRegistryResultsMock.mockImplementation(async (_query, results) => results);
  });

  it('freezes a ranked deduplicated set, counts actual pages and never reacquires on pagination', async () => {
    const first = await (await GET(request('web search paging'))).json();
    expect(first.metadata.count).toBe(2);
    expect(first.metadata.discovery.truncated).toBe(true);
    discoverRegistryServersMock.mockRejectedValue(new Error('upstream changed'));
    const second = await (await GET(request('web search paging', first.metadata.nextCursor))).json();
    const third = await (await GET(request('web search paging', second.metadata.nextCursor))).json();
    expect([...first.servers, ...second.servers, ...third.servers].map(value => value.server.name)).toEqual(
      ['one', 'two', 'three', 'four', 'five'].map(name => `io.example/${name}`),
    );
    expect(third.metadata).toMatchObject({ count: 1 });
    expect(third.metadata.nextCursor).toBeUndefined();
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(1);
    expect(rankRegistryResultsMock).toHaveBeenCalledTimes(1);
    expect(registryGetRawMock).not.toHaveBeenCalled();
  });

  it('shares first-page concurrent work and keeps cursor bound to query and page size', async () => {
    const [left, right] = await Promise.all([GET(request('parallel discovery')), GET(request('parallel discovery'))]);
    const body = await left.json();
    expect((await right.json()).metadata.nextCursor).toBe(body.metadata.nextCursor);
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(1);
    expect((await GET(request('wrong discovery', body.metadata.nextCursor))).status).toBe(410);
    expect((await GET(request('parallel discovery', body.metadata.nextCursor, 3))).status).toBe(400);
    expect((await GET(request('parallel discovery', 'upstream-cursor'))).status).toBe(400);
  });

  it('expires a cursor explicitly rather than silently replacing its candidate set', async () => {
    const first = await (await GET(request('expired discovery'))).json();
    const now = Date.now();
    const date = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    try { expect((await GET(request('expired discovery', first.metadata.nextCursor))).status).toBe(410); }
    finally { date.mockRestore(); }
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(1);
  });

  it('returns upstream failures as failures, without caching a fake empty search', async () => {
    discoverRegistryServersMock.mockRejectedValueOnce(new Error('failed'));
    const failed = await GET(request('failure discovery'));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ success: false });
    expect((await GET(request('failure discovery'))).status).toBe(200);
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(2);
  });

  it('preserves unlocked admission and query bounds before network work', async () => {
    assertUnlockedMock.mockResolvedValueOnce(new Response('locked', { status: 423 }));
    expect((await GET(request('locked discovery'))).status).toBe(423);
    expect((await GET(request('x'.repeat(257)))).status).toBe(400);
    expect(discoverRegistryServersMock).not.toHaveBeenCalled();
  });

  it('evicts large snapshots by byte budget and returns an explicit expired cursor', async () => {
    discoverRegistryServersMock.mockResolvedValue({
      servers: Array.from({ length: 180 }, (_, index) => ({ server: { name: `io.example/cache-${index}`, description: 'x'.repeat(15_000) } })),
      discovery: { bounded: true, terms: ['cache'], partial: false, truncated: true },
    });
    const first = await (await GET(request('large snapshot zero'))).json();
    for (const query of ['large snapshot one', 'large snapshot two', 'large snapshot three']) await GET(request(query));
    expect((await GET(request('large snapshot zero', first.metadata.nextCursor))).status).toBe(410);
    expect(discoverRegistryServersMock).toHaveBeenCalledTimes(4);
  });
});

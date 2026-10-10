const registryGetJsonMock = jest.fn();
jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.example.test',
  registryGetJson: (...args: unknown[]) => registryGetJsonMock(...args),
}));
import { discoverRegistryServers } from '@/backend/services/mcp/registryDiscovery';

const entry = (name: string, description = '') => ({ server: { name, description, version: '2.0.0' } });
const search = (url: URL) => url.searchParams.get('search')!;

describe('bounded Registry capability acquisition', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('acquires spaces/dashes and relevant description synonyms from bounded latest pages', async () => {
    registryGetJsonMock.mockImplementation(async (url: URL) => ({ servers: search(url) === 'filesystem'
      ? [entry('io.example/drive', 'Read files and directories'), entry('io.example/profile', 'User profiles')]
      : [] }));
    const result = await discoverRegistryServers('please read files');
    expect(result.servers.map(value => value.server.name)).toEqual(['io.example/drive']);
    expect(registryGetJsonMock.mock.calls.length).toBeLessThanOrEqual(6);
    for (const [url, timeout, options] of registryGetJsonMock.mock.calls) {
      expect(url.searchParams.get('version')).toBe('latest');
      expect(url.searchParams.get('limit')).toBe('30');
      expect(url.searchParams.get('search')).toBeTruthy();
      expect(timeout).toBe(15_000);
      expect(options.maxBytes).toBe(256 * 1024);
    }
  });

  it('deduplicates aliases and chooses newest dated latest receipt', async () => {
    registryGetJsonMock.mockImplementation(async (url: URL) => ({
      servers: [{ ...entry('io.example/calendar', 'Calendar schedules'), _meta: {
        'io.modelcontextprotocol.registry/official': { publishedAt: search(url) === 'calendar' ? '2026-10-09T00:00:00Z' : '2026-10-08T00:00:00Z', isLatest: true },
      } }, { ...entry('io.example/old-calendar'), _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } } }],
      metadata: { nextCursor: 'upstream-extra-page' },
    }));
    const result = await discoverRegistryServers('schedule appointments');
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt).toBe('2026-10-09T00:00:00Z');
    expect(result.discovery.truncated).toBe(true);
    expect(result.discovery.partial).toBe(false);
  });

  it('shares concurrent acquisition and caches successful repeated searches without shared mutation', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [entry('io.example/weather')] });
    const [first, second] = await Promise.all([discoverRegistryServers('weather'), discoverRegistryServers('weather')]);
    expect(registryGetJsonMock).toHaveBeenCalledTimes(1);
    first.servers[0].server.name = 'mutated';
    expect(second.servers[0].server.name).toBe('io.example/weather');
    expect((await discoverRegistryServers('weather')).servers[0].server.name).toBe('io.example/weather');
    expect(registryGetJsonMock).toHaveBeenCalledTimes(1);
  });

  it('never returns an outage as success or caches a failed lookup', async () => {
    registryGetJsonMock.mockRejectedValue(new Error('503'));
    await expect(discoverRegistryServers('quantum')).rejects.toThrow('Failed to reach');
    registryGetJsonMock.mockResolvedValue({ servers: [entry('io.example/quantum')] });
    expect((await discoverRegistryServers('quantum')).servers).toHaveLength(1);
    expect(registryGetJsonMock).toHaveBeenCalledTimes(2);
  });

  it('labels useful partial acquisition and permits a subsequent fresh retry', async () => {
    registryGetJsonMock.mockImplementation(async (url: URL) => {
      if (search(url) === 'mail') throw new Error('503');
      return { servers: [entry('io.example/gmail', 'Read your email inbox')] };
    });
    expect((await discoverRegistryServers('email inbox')).discovery.partial).toBe(true);
    const count = registryGetJsonMock.mock.calls.length;
    await discoverRegistryServers('email inbox');
    expect(registryGetJsonMock.mock.calls.length).toBeGreaterThan(count);
  });

  it('never downloads an unfiltered catalog for vague filler or fabricated capability', async () => {
    expect((await discoverRegistryServers('please give me a useful server')).servers).toEqual([]);
    expect(registryGetJsonMock).not.toHaveBeenCalled();
    registryGetJsonMock.mockResolvedValue({ servers: [entry('io.example/popular', 'Browser automation')] });
    expect((await discoverRegistryServers('mythical telepathy')).servers).toEqual([]);
    expect(registryGetJsonMock).toHaveBeenCalled();
  });

  it('rejects malformed/oversized pages and entries instead of ranking fabricated metadata', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: Array.from({ length: 31 }, (_, i) => entry(`io.example/huge-${i}`)) });
    await expect(discoverRegistryServers('huge')).rejects.toThrow('Failed to reach');
    registryGetJsonMock.mockResolvedValue({ servers: [entry('io.example/oversized', 'x'.repeat(16 * 1024))] });
    await expect(discoverRegistryServers('oversized')).rejects.toThrow('incomplete');
  });

  it('enforces the total cache byte budget before its entry count limit', async () => {
    registryGetJsonMock.mockImplementation(async (url: URL) => {
      const term = search(url);
      const index = term.match(/budget(\d+)/)?.[1];
      return { servers: Array.from({ length: 30 }, (_, offset) => entry(
        `io.example/budget${index}alpha-budget${index}beta-budget${index}gamma-${term}-${offset}`,
        'x'.repeat(15_000),
      )) };
    });
    for (let index = 0; index < 6; index++) await discoverRegistryServers(`budget${index}alpha budget${index}beta budget${index}gamma`);
    const count = registryGetJsonMock.mock.calls.length;
    await discoverRegistryServers('budget0alpha budget0beta budget0gamma');
    expect(registryGetJsonMock.mock.calls.length).toBeGreaterThan(count);
  });

  it('bounds active searches and releases capacity after actual settlement', async () => {
    const releases: Array<() => void> = [];
    registryGetJsonMock.mockImplementation(async (url: URL) => new Promise(resolve => {
      releases.push(() => resolve({ servers: [entry(`io.example/${search(url)}`)] }));
    }));
    const running = Array.from({ length: 8 }, (_, index) => discoverRegistryServers(`activebudget${index}`));
    await expect(discoverRegistryServers('activebudgetoverflow')).rejects.toThrow('busy');
    expect(registryGetJsonMock).toHaveBeenCalledTimes(8);
    releases.forEach(release => release());
    await Promise.all(running);
    registryGetJsonMock.mockResolvedValue({ servers: [] });
    await expect(discoverRegistryServers('activebudgetafter')).resolves.toMatchObject({ servers: [] });
  });

  it('cancels only its own research without disrupting another browsing consumer', async () => {
    let releaseBrowse: (() => void) | undefined;
    registryGetJsonMock.mockImplementation(async (_url, _timeout, options) => new Promise((resolve, reject) => {
      if (options.signal) options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      else releaseBrowse = () => resolve({ servers: [entry('io.example/cancelisolated')] });
    }));
    const browsing = discoverRegistryServers('cancelisolated');
    const controller = new AbortController();
    const research = discoverRegistryServers('cancelisolated', controller.signal);
    controller.abort(new DOMException('Research cancelled', 'AbortError'));
    await expect(research).rejects.toThrow('Research cancelled');
    releaseBrowse!();
    expect((await browsing).servers).toHaveLength(1);
    expect(registryGetJsonMock).toHaveBeenCalledTimes(2);
  });

  it('merges optional assisted aliases under one global six-request budget', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [entry('io.example/freshweb', 'Search the web')] });
    const result = await discoverRegistryServers('search the freshweb', undefined, ['freshweb', 'extraone', 'extratwo', 'extrathree', 'extrafour', 'extrafive', 'extrasix']);
    expect(registryGetJsonMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.discovery.terms).toContain('extraone');
    expect(result.servers).toHaveLength(1);
  });
});

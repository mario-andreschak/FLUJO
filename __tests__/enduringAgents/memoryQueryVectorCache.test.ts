import {
  MemoryQueryVectorCache,
  normalizeMemoryQueryForCache,
} from '@/backend/services/enduringAgents/memoryQueryVectorCache';

const baseKey = {
  workspaceId: 'workspace-a',
  provider: 'openai',
  modelId: 'text-embedding-3-small',
  dimensions: 3,
  query: 'Release process',
};

describe('MemoryQueryVectorCache', () => {
  it('normalizes equivalent query text and records a warm hit', async () => {
    const cache = new MemoryQueryVectorCache();
    const create = jest.fn(async () => [1, 0, 0]);

    await expect(cache.getOrCreate(baseKey, create)).resolves.toEqual([1, 0, 0]);
    await expect(cache.getOrCreate({
      ...baseKey,
      query: '  RELEASE\n process  ',
    }, create)).resolves.toEqual([1, 0, 0]);

    expect(normalizeMemoryQueryForCache('  RELEASE\n process  ')).toBe('release process');
    expect(create).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('isolates workspaces, providers, models, and dimensions', async () => {
    const cache = new MemoryQueryVectorCache();
    const create = jest.fn(async () => [1, 0, 0]);

    await cache.getOrCreate(baseKey, create);
    await cache.getOrCreate({ ...baseKey, workspaceId: 'workspace-b' }, create);
    await cache.getOrCreate({ ...baseKey, provider: 'azure' }, create);
    await cache.getOrCreate({ ...baseKey, modelId: 'embedding-v2' }, create);
    await cache.getOrCreate({ ...baseKey, dimensions: 2 }, create);

    expect(create).toHaveBeenCalledTimes(5);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 5, size: 5 });
  });

  it('evicts the least-recently-used entry at its bound', async () => {
    const cache = new MemoryQueryVectorCache({ maxEntries: 2 });
    const create = jest.fn(async () => [1]);

    const first = { ...baseKey, query: 'first' };
    const second = { ...baseKey, query: 'second' };
    const third = { ...baseKey, query: 'third' };
    await cache.getOrCreate(first, create);
    await cache.getOrCreate(second, create);
    await cache.getOrCreate(first, create);
    await cache.getOrCreate(third, create);
    await cache.getOrCreate(second, create);

    expect(create).toHaveBeenCalledTimes(4);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 4, evictions: 2, size: 2 });
  });

  it('expires entries after the configured TTL', async () => {
    let now = 100;
    const cache = new MemoryQueryVectorCache({
      ttlMilliseconds: 50,
      now: () => now,
    });
    const create = jest.fn(async () => [1]);

    await cache.getOrCreate(baseKey, create);
    now = 149;
    await cache.getOrCreate(baseKey, create);
    now = 150;
    await cache.getOrCreate(baseKey, create);

    expect(create).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, size: 1 });
  });

  it('coalesces concurrent misses for the same key', async () => {
    let resolveCreate: ((vector: number[]) => void) | undefined;
    const create = jest.fn(() => new Promise<number[]>((resolve) => {
      resolveCreate = resolve;
    }));
    const cache = new MemoryQueryVectorCache();

    const first = cache.getOrCreate(baseKey, create);
    const second = cache.getOrCreate(baseKey, create);
    resolveCreate?.([1, 0, 0]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 1, inFlight: 0 });
  });

  it('does not repopulate or disrupt a newer request after reset', async () => {
    let resolveFirst: ((vector: number[]) => void) | undefined;
    const cache = new MemoryQueryVectorCache();
    const first = cache.getOrCreate(baseKey, () => new Promise<number[]>((resolve) => {
      resolveFirst = resolve;
    }));

    cache.clear();
    const second = cache.getOrCreate(baseKey, async () => [0, 1, 0]);
    resolveFirst?.([1, 0, 0]);

    await expect(first).resolves.toEqual([1, 0, 0]);
    await expect(second).resolves.toEqual([0, 1, 0]);
    expect(cache.get(baseKey)).toEqual([0, 1, 0]);
    expect(cache.stats()).toMatchObject({ misses: 1, size: 1, inFlight: 0 });
  });

  it('cleans up a failed in-flight request so it can be retried', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce([1, 0, 0]);
    const cache = new MemoryQueryVectorCache();

    await expect(cache.getOrCreate(baseKey, create)).rejects.toThrow('provider unavailable');
    await expect(cache.getOrCreate(baseKey, create)).resolves.toEqual([1, 0, 0]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ misses: 2, size: 1, inFlight: 0 });
  });

  it('clears entries and statistics', async () => {
    const cache = new MemoryQueryVectorCache();
    await cache.getOrCreate(baseKey, async () => [1]);
    cache.clear();

    expect(cache.get(baseKey)).toBeUndefined();
    expect(cache.stats()).toEqual({
      hits: 0,
      misses: 0,
      coalesced: 0,
      evictions: 0,
      size: 0,
      inFlight: 0,
    });
  });
});

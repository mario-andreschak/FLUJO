import {
  clearRunResourceIndexCache,
  getRunResourceIndexPressure,
  invalidateRunResourceIndex,
  loadRunResourceIndex,
  publishRunResourceIndex,
} from '@/backend/services/runResources/indexCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const encoded = (id: string) => JSON.stringify([{ id, readBy: [], producedBy: { source: 'capture' } }]);
const forbiddenLoad = () => { throw new Error('Cached index unexpectedly reloaded'); };

beforeEach(() => { clearRunResourceIndexCache(); });
afterEach(() => {
  jest.restoreAllMocks();
  expect(getRunResourceIndexPressure()).toMatchObject({ activeReads: 0, queuedReads: 0 });
  clearRunResourceIndexCache();
});

it('caps retained indexes at 200 and reloads the evicted history', async () => {
  for (let i = 0; i < 201; i++) publishRunResourceIndex('conversation-' + i, encoded('record-' + i));
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 200, maxCached: 200 });
  const reload = jest.fn(async () => encoded('persisted-record-0'));
  expect(await loadRunResourceIndex('conversation-0', reload)).toMatchObject([{ id: 'persisted-record-0' }]);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(getRunResourceIndexPressure().cached).toBe(200);
});

it('evicts the least recently used index rather than a recently read one', async () => {
  for (let i = 0; i < 200; i++) publishRunResourceIndex('key-' + i, encoded('record-' + i));
  await loadRunResourceIndex('key-0', forbiddenLoad);
  publishRunResourceIndex('new-key', encoded('new-record'));
  expect(await loadRunResourceIndex('key-0', forbiddenLoad)).toMatchObject([{ id: 'record-0' }]);
  const reload = jest.fn(async () => encoded('record-1'));
  await loadRunResourceIndex('key-1', reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('measures encoded UTF-8 bytes and enforces the aggregate 8 MiB cap', async () => {
  const content = JSON.stringify([{ id: 'unicode', name: 'λ'.repeat(2 * 1024 * 1024) }]);
  publishRunResourceIndex('first', content);
  expect(getRunResourceIndexPressure().serializedBytes).toBe(Buffer.byteLength(content, 'utf8'));
  publishRunResourceIndex('second', content);
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 1, maxSerializedBytes: 8 * 1024 * 1024 });
  expect(getRunResourceIndexPressure().serializedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  await loadRunResourceIndex('second', forbiddenLoad);
  const reload = jest.fn(async () => '[]');
  await loadRunResourceIndex('first', reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('admits exactly the byte boundary and bypasses oversized retention without truncating data', async () => {
  const boundary = '[' + ' '.repeat(8 * 1024 * 1024 - 2) + ']';
  publishRunResourceIndex('boundary', boundary);
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 1, serializedBytes: 8 * 1024 * 1024 });
  const oversized = JSON.stringify([{ id: 'large', name: 'x'.repeat(8 * 1024 * 1024) }]);
  const before = getRunResourceIndexPressure().bypassed;
  const load = jest.fn(async () => oversized);
  expect((await loadRunResourceIndex('large', load))[0].name?.length).toBe(8 * 1024 * 1024);
  await loadRunResourceIndex('large', load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(getRunResourceIndexPressure().bypassed - before).toBe(2);
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 1, serializedBytes: 8 * 1024 * 1024 });
});

it('expires idle snapshots lazily at thirty minutes', () => {
  let now = 1;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  publishRunResourceIndex('idle', '[]');
  now += 30 * 60 * 1000 - 1;
  expect(getRunResourceIndexPressure().cached).toBe(1);
  now++;
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 0, serializedBytes: 0, idleMs: 30 * 60 * 1000 });
});

it('coalesces a shared cold read before opening another loader', async () => {
  const gate = deferred<string>();
  const entered = deferred<void>();
  const load = jest.fn(() => { entered.resolve(); return gate.promise; });
  const readers = Array.from({ length: 20 }, () => loadRunResourceIndex('shared', load));
  try {
    await entered.promise;
    expect(load).toHaveBeenCalledTimes(1);
    expect(getRunResourceIndexPressure()).toMatchObject({ activeReads: 1, queuedReads: 0 });
  } finally { gate.resolve(encoded('shared-record')); }
  expect((await Promise.all(readers)).map(entries => entries[0].id)).toEqual(Array(20).fill('shared-record'));
});

it('never lets an older cold read replace a newly committed index', async () => {
  const gate = deferred<string>(), entered = deferred<void>();
  const pending = loadRunResourceIndex('race', () => { entered.resolve(); return gate.promise; });
  await entered.promise;
  publishRunResourceIndex('race', encoded('new-committed-record'));
  gate.resolve(encoded('obsolete-record'));
  expect(await pending).toMatchObject([{ id: 'new-committed-record' }]);
  expect(await loadRunResourceIndex('race', forbiddenLoad)).toMatchObject([{ id: 'new-committed-record' }]);
});

it('reloads after an invalidating oversized publication that bypasses the cache', async () => {
  const gate = deferred<string>(), entered = deferred<void>();
  const oversized = '[' + ' '.repeat(8 * 1024 * 1024) + ']';
  const load = jest.fn().mockImplementationOnce(() => { entered.resolve(); return gate.promise; }).mockResolvedValue(oversized);
  const pending = loadRunResourceIndex('race-large', load);
  await entered.promise;
  publishRunResourceIndex('race-large', oversized);
  gate.resolve(encoded('obsolete-record'));
  expect(await pending).toEqual([]);
  expect(load).toHaveBeenCalledTimes(2);
  expect(getRunResourceIndexPressure()).toMatchObject({ cached: 0, serializedBytes: 0 });
});

it('refuses continually invalidated snapshots after three loads', async () => {
  const load = jest.fn(async () => { invalidateRunResourceIndex('busy'); return encoded('obsolete-record'); });
  await expect(loadRunResourceIndex('busy', load)).rejects.toMatchObject({ code: 'RUN_RESOURCE_INDEX_PRESSURE', retryable: true });
  expect(load).toHaveBeenCalledTimes(3);
  expect(getRunResourceIndexPressure().cached).toBe(0);
});

it('preserves read errors and releases their admission slot', async () => {
  const failure = Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
  await expect(loadRunResourceIndex('denied', async () => { throw failure; })).rejects.toBe(failure);
  expect(getRunResourceIndexPressure()).toMatchObject({ activeReads: 0, cached: 0 });
  expect(await loadRunResourceIndex('denied', async () => encoded('recovered'))).toMatchObject([{ id: 'recovered' }]);
});

it('detaches reset reads without allowing them to repopulate or erase a fresh cache entry', async () => {
  const gate = deferred<string>(), entered = deferred<void>();
  const old = loadRunResourceIndex('reset', () => { entered.resolve(); return gate.promise; });
  await entered.promise;
  clearRunResourceIndexCache();
  expect(await loadRunResourceIndex('reset', async () => encoded('fresh'))).toMatchObject([{ id: 'fresh' }]);
  gate.resolve(encoded('detached-old'));
  await old;
  expect(await loadRunResourceIndex('reset', forbiddenLoad)).toMatchObject([{ id: 'fresh' }]);
});

it('admits four active and sixty queued distinct reads, then refuses before loader IO', async () => {
  const gate = deferred<void>(), firstFour = deferred<void>();
  const started: number[] = [];
  let active = 0, peak = 0;
  const reads = Array.from({ length: 64 }, (_, i) => loadRunResourceIndex('private-key-' + i, async () => {
    started.push(i); active++; peak = Math.max(peak, active);
    if (started.length === 4) firstFour.resolve();
    try { await gate.promise; return encoded('private-record-' + i); }
    finally { active--; }
  }));
  const overflow = jest.fn(async () => '[]');
  let joined: Promise<unknown> | undefined;
  try {
    await firstFour.promise;
    expect(started).toEqual([0, 1, 2, 3]);
    expect(getRunResourceIndexPressure()).toMatchObject({ activeReads: 4, queuedReads: 60, maxActiveReads: 4, maxQueuedReads: 60 });
    await expect(loadRunResourceIndex('overflow-private-key', overflow)).rejects.toMatchObject({ code: 'RUN_RESOURCE_INDEX_PRESSURE', retryable: true });
    joined = loadRunResourceIndex('private-key-0', overflow);
    expect(overflow).not.toHaveBeenCalled();
    const pressure = JSON.stringify(getRunResourceIndexPressure());
    expect(pressure).not.toMatch(/private-key|private-record|overflow/);
  } finally {
    gate.resolve();
    await Promise.all(reads);
    await joined;
  }
  expect(peak).toBe(4);
  expect(started).toEqual(Array.from({ length: 64 }, (_, i) => i));
});

it('owns a frozen snapshot of the exact encoded metadata', async () => {
  const original = [{ id: 'committed', readBy: [], producedBy: { source: 'capture' } }];
  const content = JSON.stringify(original);
  publishRunResourceIndex('immutable', content);
  original[0].producedBy.source = 'caller-change';
  const entries = await loadRunResourceIndex('immutable', forbiddenLoad);
  expect(entries).toMatchObject([{ id: 'committed', producedBy: { source: 'capture' } }]);
  expect(() => { entries[0].readBy.push({ at: 1, source: 'node' }); }).toThrow(TypeError);
  expect(getRunResourceIndexPressure().serializedBytes).toBe(Buffer.byteLength(content, 'utf8'));
});

it.each(['{broken-json', '{}'])('refuses corrupt or non-array history instead of returning an empty index (%s)', async content => {
  await expect(loadRunResourceIndex('corrupt', async () => content)).rejects.toThrow();
  expect(getRunResourceIndexPressure().cached).toBe(0);
});

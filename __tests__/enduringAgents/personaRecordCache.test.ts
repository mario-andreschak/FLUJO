import {
  _clearPersonaRecordCache,
  advancePersonaRecordCache,
  loadPersonaRecords,
  PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA,
  PERSONA_RECORD_CACHE_MAX_RECORDS,
  PERSONA_RECORD_READ_CONCURRENCY,
} from '@/backend/services/enduringAgents/personaRecordCache';

const collection = 'activities';
const personaId = 'persona_cache_probe';
const entries = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }];

describe('Persona record cache mutation fencing', () => {
  beforeEach(_clearPersonaRecordCache);

  it('reloads the compacted record without rereading unchanged history', async () => {
    const records: Record<string, string> = { a: 'detailed', b: 'unchanged' };
    const load = jest.fn(async (id: string) => records[id]);
    const read = (revision: number) => loadPersonaRecords({ collection, personaId, revision, entries, load });
    expect(await read(1)).toEqual(['detailed', 'unchanged']);
    records.a = 'compacted'; // Compaction preserves updatedAt.
    advancePersonaRecordCache(collection, personaId, 'a', 1, 2);
    load.mockClear();
    expect(await read(2)).toEqual(['compacted', 'unchanged']);
    expect(load.mock.calls).toEqual([['a']]);
  });

  it('discards all cached records when the index revision includes unobserved writes', async () => {
    const load = jest.fn(async (id: string) => `old-${id}`);
    await loadPersonaRecords({ collection, personaId, revision: 1, entries, load });
    advancePersonaRecordCache(collection, personaId, 'a', 2, 3);
    load.mockImplementation(async id => `new-${id}`);
    load.mockClear();
    expect(await loadPersonaRecords({ collection, personaId, revision: 3, entries, load }))
      .toEqual(['new-a', 'new-b']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not let a late read from the old revision overwrite committed data', async () => {
    let finish!: (value: string) => void;
    const oldRead = loadPersonaRecords({
      collection, personaId, revision: 1, entries: entries.slice(0, 1),
      load: () => new Promise<string>(resolve => { finish = resolve; }),
    });
    await Promise.resolve();
    advancePersonaRecordCache(collection, personaId, 'a', 1, 2);
    const load = jest.fn(async () => 'new');
    const read = () => loadPersonaRecords({ collection, personaId, revision: 2, entries: entries.slice(0, 1), load });
    expect(await read()).toEqual(['new']);
    finish('old');
    expect(await oldRead).toEqual(['old']);
    expect(await read()).toEqual(['new']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns the whole requested history while retaining only the bounded cache', async () => {
    const history = Array.from({ length: PERSONA_RECORD_CACHE_MAX_RECORDS_PER_PERSONA + 1 }, (_, index) => ({
      id: `record-${index}`, updatedAt: 1,
    }));
    const load = jest.fn(async (id: string) => id);
    const read = (selected: typeof history) => loadPersonaRecords({
      collection, personaId, revision: 1, entries: selected, load,
    });
    expect(await read(history)).toEqual(history.map(entry => entry.id));
    load.mockClear();
    expect(await read(history.slice(-1))).toEqual([history.at(-1)!.id]);
    expect(load).not.toHaveBeenCalled();
    expect(await read(history.slice(0, 1))).toEqual([history[0].id]);
    expect(load).toHaveBeenCalledWith(history[0].id);
  });

  it('keeps remaining old reads fenced when another read in the batch fails', async () => {
    let finish!: (value: string) => void;
    const oldRead = loadPersonaRecords({
      collection, personaId, revision: 1, entries,
      load: async id => {
        if (id === 'b') throw new Error('storage unavailable');
        return new Promise<string>(resolve => { finish = resolve; });
      },
    });
    await expect(oldRead).rejects.toThrow('storage unavailable');
    advancePersonaRecordCache(collection, personaId, 'a', 1, 2);
    const read = () => loadPersonaRecords({
      collection, personaId, revision: 2, entries: entries.slice(0, 1),
      load: async () => 'new',
    });
    expect(await read()).toEqual(['new']);
    finish('old');
    await new Promise(resolve => setImmediate(resolve));
    expect(await read()).toEqual(['new']);
  });

  it('bounds cold-read concurrency without dropping or reordering records', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let peak = 0;
    const history = Array.from({ length: 200 }, (_, index) => ({ id: String(index), updatedAt: 1 }));
    const read = loadPersonaRecords({
      collection, personaId, revision: 1, entries: history,
      load: async id => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return id;
      },
    });
    expect(active).toBe(PERSONA_RECORD_READ_CONCURRENCY);
    release();
    expect(await read).toEqual(history.map(entry => entry.id));
    expect(peak).toBe(PERSONA_RECORD_READ_CONCURRENCY);
    expect(active).toBe(0);
  });

  it('keeps 50k recall warm and bounds retention across Personas', async () => {
    const history = Array.from({ length: 50_000 }, (_, index) => ({ id: String(index), updatedAt: 1 }));
    let loads = 0;
    const load = async (id: string) => { loads += 1; return id; };
    const read = (owner: string, selected = history) => loadPersonaRecords({
      collection, personaId: owner, revision: 1, entries: selected, load,
    });
    for (let index = 0; index < PERSONA_RECORD_CACHE_MAX_RECORDS / history.length; index += 1) {
      await read(`persona_${index}`);
    }
    const coldLoads = loads;
    expect((await read('persona_0')).length).toBe(50_000);
    expect(loads).toBe(coldLoads);
    // A new bucket exceeds the process budget and evicts an older working set.
    await read('persona_new', history.slice(0, 1));
    for (let index = 0; index < PERSONA_RECORD_CACHE_MAX_RECORDS / history.length; index += 1) {
      await read(`persona_${index}`, history.slice(0, 1));
    }
    expect(loads).toBeGreaterThan(coldLoads + 1);
  });
});

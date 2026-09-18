import {
  _clearPersonaRecordCache,
  advancePersonaRecordCache,
  loadPersonaRecords,
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
    advancePersonaRecordCache(collection, personaId, 'a', 1, 2);
    const load = jest.fn(async () => 'new');
    const read = () => loadPersonaRecords({ collection, personaId, revision: 2, entries: entries.slice(0, 1), load });
    expect(await read()).toEqual(['new']);
    finish('old');
    expect(await oldRead).toEqual(['old']);
    expect(await read()).toEqual(['new']);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

import { readFactoryObservatorySnapshot } from '@/backend/services/factory/observatorySnapshot';

const TOKEN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const config = {
  FACTORY_OBSERVATORY_URL: 'http://127.0.0.1:4343/v1/snapshot',
  FACTORY_OBSERVATORY_TOKEN: TOKEN,
  FACTORY_OBSERVATORY_ID: 'world-swarm',
};

function envelope() {
  return { schemaVersion: 1, factoryId: 'world-swarm', scope: 'local-coordinator',
    observedAt: '2026-10-08T00:00:00.000Z', revision: 42,
    capabilities: { snapshot: true, events: true, commands: false },
    snapshot: { control: { mission: 'Run SAVIA', status: 'active' },
      cells: [
        { id: 'root', parentId: null, depth: 0, role: 'coordinator', status: 'ready', purpose: 'Run SAVIA' },
        { id: 'lead', parentId: 'root', depth: 1, role: 'coordinator', status: 'ready', purpose: 'Lead' },
        { id: 'specialist', parentId: 'lead', depth: 2, role: 'developer', status: 'reserved', purpose: 'Specialist' },
      ],
      tasks: [{ id: 'case-1', owner: 'lead', status: 'running', projectId: 'savia' }],
      effects: [], unresolvedEffects: 0, budget: { limitCents: 0 } } };
}

test('reads FACTORY hierarchy through a pinned local endpoint and returns only the safe projection', async () => {
  const fetcher = jest.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(init?.redirect).toBe('error');
    return Response.json(envelope());
  }) as unknown as typeof fetch;
  const result = await readFactoryObservatorySnapshot(config, fetcher);
  expect(result.cells.map((cell) => [cell.id, cell.parentId])).toEqual([
    ['root', null], ['lead', 'root'], ['specialist', 'lead'],
  ]);
  expect(result.tasks).toEqual([{ id: 'case-1', owner: 'lead', status: 'running', projectId: 'savia' }]);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(fetcher).toHaveBeenCalledWith(config.FACTORY_OBSERVATORY_URL, expect.anything());
});

test('refuses remote URLs and mismatched or forged topology', async () => {
  const fetcher = jest.fn(async () => Response.json(envelope())) as unknown as typeof fetch;
  await expect(readFactoryObservatorySnapshot({ ...config, FACTORY_OBSERVATORY_URL: 'https://remote.example/v1/snapshot' }, fetcher))
    .rejects.toThrow('FACTORY_CONFIG_INVALID');
  expect(fetcher).not.toHaveBeenCalled();
  const wrong = envelope();
  wrong.snapshot.cells[2].parentId = 'missing';
  await expect(readFactoryObservatorySnapshot(config, jest.fn(async () => Response.json(wrong)) as unknown as typeof fetch))
    .rejects.toThrow('FACTORY_SOURCE_INVALID');
  const foreign = envelope();
  foreign.factoryId = 'other';
  await expect(readFactoryObservatorySnapshot(config, jest.fn(async () => Response.json(foreign)) as unknown as typeof fetch))
    .rejects.toThrow('FACTORY_SOURCE_INVALID');
});

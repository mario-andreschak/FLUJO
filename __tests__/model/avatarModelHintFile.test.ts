import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCodexModelHints } from '@/backend/services/avatar/connectionDiscovery';

let fixture: string;
let previous: string | undefined;
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-model-hints-'));
  previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture;
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('flujo-model-hints-')) {
    throw new Error('Unsafe fixture cleanup');
  }
  await fs.rm(fixture, { recursive: true, force: true });
});

test('public hints come from the bounded descriptor without reopening content by pathname', async () => {
  await fs.writeFile(path.join(fixture, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(),
    models: [{ slug: 'public-fixture-model', visibility: 'list', private_metadata: 'synthetic-private-value' }] }));
  const pathnameRead = jest.spyOn(fs, 'readFile');
  expect(await inspectCodexModelHints()).toEqual([{ id: 'public-fixture-model', label: 'public-fixture-model',
    source: 'host-cache', updatedAt: expect.any(Number) }]);
  expect(pathnameRead).not.toHaveBeenCalled();
});

test('descriptor drift discards the model hints', async () => {
  await fs.writeFile(path.join(fixture, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(),
    models: [{ slug: 'public-fixture-model', visibility: 'list' }] }));
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    let reads = 0;
    jest.spyOn(handle, 'stat').mockImplementation(async (...statArgs: Parameters<typeof handle.stat>) => {
      const value = await stat(...statArgs);
      if (++reads === 2) value.ino = typeof value.ino === 'bigint' ? BigInt(0) : 0;
      return value;
    });
    return handle;
  });
  expect(await inspectCodexModelHints()).toEqual([]);
});

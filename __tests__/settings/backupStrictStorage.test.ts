import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
let fixtureDirectory: string;
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'), getWorkspaceDataDir: () => fixtureDirectory }));
import { listCollectionItems, listCollectionItemEntriesStrict } from '@/utils/storage/backend';
beforeEach(async () => {
  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-backup-strict-'));
  await fs.mkdir(path.join(fixtureDirectory, 'db', 'flows'), { recursive: true });
});
afterEach(async () => { await fs.rm(fixtureDirectory, { recursive: true, force: true }); });
it.each(['{broken', '   '])('rejects actual corrupt disk data that tolerant listings silently skip', async content => {
  await fs.writeFile(path.join(fixtureDirectory, 'db', 'flows', 'broken.json'), content);
  await fs.writeFile(path.join(fixtureDirectory, 'db', 'flows', 'valid.json'), '{"id":"valid"}');
  await expect(listCollectionItems('flows')).resolves.toEqual([{ id: 'valid' }]);
  await expect(listCollectionItemEntriesStrict('flows')).rejects.toThrow();
});
it('treats an absent collection as empty', async () => {
  await expect(listCollectionItemEntriesStrict('conversations')).resolves.toEqual([]);
});

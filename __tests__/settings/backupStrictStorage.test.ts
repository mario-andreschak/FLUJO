import { StorageKey } from '@/shared/types/storage';
jest.mock('@/utils/encryption/credentialMigrationState', () => ({ assertCredentialStoreReady: async () => undefined }));
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
let fixtureDirectory: string;
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'), getWorkspaceDataDir: () => fixtureDirectory }));
import { loadItem, loadItemForBackup, listCollectionItems, listCollectionItemEntriesStrict } from '@/utils/storage/backend';
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

it.each([StorageKey.MODELS, StorageKey.FLOWS, StorageKey.CHAT_HISTORY])('does not mistake interrupted legacy %s storage for an empty backup', async key => {
  await fs.writeFile(path.join(fixtureDirectory, 'db', `${key}.json`), '   ');
  await expect(loadItemForBackup(key, null)).rejects.toThrow();
  await expect(loadItem(key, null)).resolves.toBeNull();
});

it.each([StorageKey.MODELS, StorageKey.FLOWS, StorageKey.CHAT_HISTORY])('preserves absent and valid legacy %s data without corruption recovery writes', async key => {
  await expect(loadItemForBackup(key, null)).resolves.toBeNull();
  const filename = path.join(fixtureDirectory, 'db', `${key}.json`);
  await fs.writeFile(filename, '{broken');
  await expect(loadItemForBackup(key, null)).rejects.toThrow();
  expect((await fs.readdir(path.join(fixtureDirectory, 'db'))).filter(name => name.includes('.corrupted.'))).toEqual([]);
  await fs.writeFile(filename, '{"ApiKey":"encrypted:unchanged"}');
  await expect(loadItemForBackup(key, null)).resolves.toEqual({ ApiKey: 'encrypted:unchanged' });
});

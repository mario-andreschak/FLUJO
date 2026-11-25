/**
 * Issue #1368: a workspace that never stored a secret has no key metadata
 * (db/encryption_key.json). Restored on a worker it must not stay locked,
 * because there is nothing to unlock. Only a worker that holds encrypted
 * secrets without their key metadata stays locked, with plain fix-it words.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getWorkspaceDbDir, runWithWorkspace } from '@/utils/workspace';
import {
  EncryptionLockedError, decryptWithPassword, describeWorkerEncryptionLock, encryptWithPassword, isEncryptionLocked,
} from '@/utils/encryption/secure';
import { lockServer } from '@/utils/encryption/session';
import type { EncryptionMetadata } from '@/utils/encryption/format';

jest.setTimeout(60_000);

const workspace = 'worker-without-metadata';
const environmentKeys = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WORKER_MODE'] as const;
let root: string;
let saved: Array<string | undefined>;

beforeEach(async () => {
  saved = environmentKeys.map(key => process.env[key]);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-missing-metadata-'));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  delete process.env.FLUJO_WORKER_MODE;
  global.__flujo_stored_ciphertext_checks = undefined;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await runWithWorkspace(workspace, async () => lockServer());
  environmentKeys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
  });
  global.__flujo_stored_ciphertext_checks = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

const metadataFile = () => path.join(getWorkspaceDbDir(), `${StorageKey.ENCRYPTION_KEY}.json`);
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

async function writeDbFile(name: string, content: string) {
  const file = path.join(getWorkspaceDbDir(), ...name.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** A source workspace that stored one secret, then lost or never shipped its key file. */
async function sourceWithSecret(): Promise<{ ciphertext: string; metadata: EncryptionMetadata }> {
  const ciphertext = (await encryptWithPassword('source-model-key'))!;
  await saveItem(StorageKey.MODELS, [{ id: 'model', ApiKey: `encrypted:${ciphertext}` }]);
  const metadata = (await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
  return { ciphertext, metadata };
}

test('missing key metadata alone never locks a worker: nothing encrypted means unlocked', async () => {
  await runWithWorkspace(workspace, async () => {
    await writeDbFile('models.json', JSON.stringify([{ id: 'model', ApiKey: '' }]));
    await writeDbFile('flows/flow-one.json', JSON.stringify({ id: 'flow-one', nodes: [], edges: [] }));
    process.env.FLUJO_WORKER_MODE = '1';

    expect(await isEncryptionLocked()).toBe(false);
    expect(await exists(metadataFile())).toBe(false);

    // The first secret the worker stores creates default key metadata, as the source would.
    const ciphertext = (await encryptWithPassword('worker-model-key'))!;
    expect(await decryptWithPassword(ciphertext)).toBe('worker-model-key');
    expect(JSON.parse(await fs.readFile(metadataFile(), 'utf8'))).toMatchObject({ encryption_version: 2, encryption_type: 'default' });
    expect(await isEncryptionLocked()).toBe(false);
  });
});

test('a worker with encrypted secrets and their key metadata is unlocked', async () => {
  await runWithWorkspace(workspace, async () => {
    const { ciphertext } = await sourceWithSecret();
    process.env.FLUJO_WORKER_MODE = '1';
    expect(await isEncryptionLocked()).toBe(false);
    expect(await decryptWithPassword(ciphertext)).toBe('source-model-key');
  });
});

test.each([
  ['an encrypted model key', 'models.json', (ciphertext: string) => JSON.stringify([{ id: 'model', ApiKey: `encrypted:${ciphertext}` }])],
  ['a bare envelope in a nested record', 'native-session-origins/owner-runtime-v1/book.json',
    (ciphertext: string) => JSON.stringify({ accounts: [{ payload: ciphertext }] })],
])('a worker holding %s without key metadata stays locked with plain fix-it words', async (_name, file, content) => {
  await runWithWorkspace(workspace, async () => {
    const { ciphertext, metadata } = await sourceWithSecret();
    await fs.rm(path.join(getWorkspaceDbDir(), 'models.json'));
    await writeDbFile(file, content(ciphertext));
    await fs.rm(metadataFile());
    process.env.FLUJO_WORKER_MODE = '1';

    expect(await isEncryptionLocked()).toBe(true);
    const message = await describeWorkerEncryptionLock();
    expect(message).toContain(`db/${file}`);
    expect(message).toContain('db/encryption_key.json is missing');
    await expect(encryptWithPassword('must-not-mint-a-new-key')).rejects.toThrow(EncryptionLockedError);
    await expect(encryptWithPassword('must-not-mint-a-new-key')).rejects.toThrow(`db/${file}`);
    expect(await exists(metadataFile())).toBe(false);

    // Putting the key file back unlocks without a restart.
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
    expect(await isEncryptionLocked()).toBe(false);
    expect(await decryptWithPassword(ciphertext)).toBe('source-model-key');
  });
});

test('a worker heals by itself once the unreadable secrets are removed', async () => {
  await runWithWorkspace(workspace, async () => {
    await sourceWithSecret();
    await fs.rm(metadataFile());
    process.env.FLUJO_WORKER_MODE = '1';
    expect(await isEncryptionLocked()).toBe(true);

    await saveItem(StorageKey.MODELS, [{ id: 'model', ApiKey: '' }]);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    expect(await isEncryptionLocked()).toBe(false);
    expect(await describeWorkerEncryptionLock()).toBe('Worker workspace encryption is locked. Unlock this workspace before running jobs.');
  });
});

test('finds a legacy encrypted value whose marker is split between two reads', async () => {
  await runWithWorkspace(workspace, async () => {
    const before = '[{"id":"model","notes":"';
    const between = '","ApiKey":';
    const padding = 'x'.repeat(64 * 1024 - 5 - before.length - between.length);
    await writeDbFile('models.json', `${before}${padding}${between}"encrypted:${'a'.repeat(32)}:QUJD"}]`);
    const marker = (await fs.readFile(path.join(getWorkspaceDbDir(), 'models.json'))).indexOf('"encrypted:');
    expect(marker).toBe(64 * 1024 - 5);
    process.env.FLUJO_WORKER_MODE = '1';
    expect(await isEncryptionLocked()).toBe(true);
  });
});

test('a desktop workspace without key metadata keeps its unlocked default behaviour', async () => {
  await runWithWorkspace(workspace, async () => {
    await sourceWithSecret();
    await fs.rm(metadataFile());
    expect(await isEncryptionLocked()).toBe(false);
  });
});

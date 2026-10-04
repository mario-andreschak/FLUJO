import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceRecoveryMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { runWithWorkspace } from '@/utils/workspace';
import { CREDENTIAL_RECOVERY_FILES, encryptCredentialRecoveryObject } from '@/utils/encryption/credentialRecoveryFormat';
import {
  clearCredentialRecoveryImage, createCredentialRecoveryBackup, readCredentialRecoveryBackup,
  type CredentialRecoveryImage,
} from '@/utils/encryption/credentialRecoveryBackup';

// Real native filesystem/crypto; this capability models exclusive process
// admission. No installed application, pending gate or crash was exercised.
const WORKSPACE = 'recovery-backup-fixture';
const TRANSACTION = 'd858dc1f-77d8-4198-9b6d-571fd2fd7a8f';
const OTHER_TRANSACTION = 'b07b5f50-3d9b-4b43-a134-d3000e26b7f2';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const image = (): CredentialRecoveryImage => Object.fromEntries(CREDENTIAL_RECOVERY_FILES.map(file =>
  [file, Buffer.from(`synthetic-new-private-${file}`)])) as CredentialRecoveryImage;
const original = (file: string) => Buffer.concat([Buffer.from(`synthetic-old-private-${file}\n`), Buffer.from([0xff, 0x00])]);
let root: string;
let tempRoot: string;
let priorDataRoot: string | undefined;
let priorParentRoot: string | undefined;
let key: Buffer;
let operation: WorkspaceRecoveryMutation;
const db = () => path.join(root, 'workspaces', WORKSPACE, 'db');
const vault = () => path.join(root, 'workspaces', WORKSPACE, '.credential-recovery');
const transaction = () => path.join(vault(), TRANSACTION);
const intent = (after = image()) => ({ transactionId: TRANSACTION, sourceKeyId: 'a'.repeat(64), targetKeyId: 'b'.repeat(64), after });
const within = <T>(task: () => Promise<T>) => runWithWorkspace(WORKSPACE, task);

beforeEach(async () => {
  priorDataRoot = process.env.FLUJO_DATA_DIR;
  priorParentRoot = process.env.FLUJO_PARENT_DATA_DIR;
  tempRoot = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(tempRoot, 'flujo-recovery-backup-'));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  await fs.mkdir(db(), { recursive: true });
  for (const file of CREDENTIAL_RECOVERY_FILES) await fs.writeFile(path.join(db(), file), original(file), { flag: 'wx', mode: 0o600 });
  key = randomBytes(32);
  operation = Object.freeze({ workspace: WORKSPACE, generation: 1, assertOwned: jest.fn(async () => undefined) });
});
afterEach(async () => {
  key.fill(0);
  if (priorDataRoot === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = priorDataRoot;
  if (priorParentRoot === undefined) delete process.env.FLUJO_PARENT_DATA_DIR;
  else process.env.FLUJO_PARENT_DATA_DIR = priorParentRoot;
  expect(path.dirname(await fs.realpath(root))).toBe(tempRoot);
  expect((await fs.lstat(root)).isSymbolicLink()).toBe(false);
  await fs.rm(root, { recursive: true, force: true });
});

test('persists authenticated complete encrypted before/after bytes and preserves active originals', async () => within(async () => {
  const after = image();
  const retainedKey = Buffer.from(key);
  const manifest = await createCredentialRecoveryBackup(operation, intent(after), key);
  const recovered = await readCredentialRecoveryBackup(operation, TRANSACTION, key);
  expect(recovered.manifest).toEqual(manifest);
  expect(manifest.phase).toBe('prepared');
  expect(key).toEqual(retainedKey);
  expect(await fs.readdir(transaction())).toHaveLength(11);
  for (const file of CREDENTIAL_RECOVERY_FILES) {
    expect(recovered.before[file]).toEqual(original(file));
    expect(recovered.after[file]).toEqual(after[file]);
    expect(await fs.readFile(path.join(db(), file))).toEqual(original(file));
    expect(manifest.entries.find(entry => entry.file === file)!.before).toEqual({ size: original(file).length, sha256: hash(original(file)) });
  }
  for (const name of await fs.readdir(transaction())) {
    const file = path.join(transaction(), name);
    const wire = await fs.readFile(file, 'utf8');
    expect(wire).not.toContain('synthetic-old-private');
    expect(wire).not.toContain('synthetic-new-private');
    expect(wire).not.toContain(key.toString('hex'));
    expect(wire).not.toContain(manifest.entries[0].before!.sha256);
    expect((await fs.lstat(file)).nlink).toBe(1);
    if (process.platform !== 'win32') expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
  }
  clearCredentialRecoveryImage(recovered.before);
  clearCredentialRecoveryImage(recovered.after);
  expect(recovered.before['models.json']!.every(byte => byte === 0)).toBe(true);
  expect(after['models.json']!.toString()).toContain('synthetic-new-private');
}));

test('retains original absences without writing placeholder files or accepting extra objects', async () => within(async () => {
  await fs.unlink(path.join(db(), 'models.json'));
  const after = image();
  after['models.json'] = null;
  await createCredentialRecoveryBackup(operation, intent(after), key);
  const recovered = await readCredentialRecoveryBackup(operation, TRANSACTION, key);
  expect(recovered.before['models.json']).toBeNull();
  expect(recovered.after['models.json']).toBeNull();
  expect(await fs.readdir(transaction())).toHaveLength(9);
  clearCredentialRecoveryImage(recovered.before);
  clearCredentialRecoveryImage(recovered.after);
  await fs.writeFile(path.join(transaction(), 'before-models.json'), 'synthetic-ambiguous-extra', { flag: 'wx', mode: 0o600 });
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  expect(await fs.readFile(path.join(transaction(), 'before-models.json'), 'utf8')).toBe('synthetic-ambiguous-extra');
}));

test('never overwrites a retained transaction, including an interrupted partial backup', async () => within(async () => {
  const interrupted = { ...operation, assertOwned: async () => {
    try { await fs.lstat(path.join(transaction(), 'before-encryption_key.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('synthetic-private-owner-error');
  } };
  await expect(createCredentialRecoveryBackup(interrupted, intent(), key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  const wire = await fs.readFile(path.join(transaction(), 'before-encryption_key.json'));
  expect(wire.length).toBeGreaterThan(0);
  expect(await fs.readdir(transaction())).toEqual(['before-encryption_key.json']);
  await expect(createCredentialRecoveryBackup(operation, intent(), key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  expect(await fs.readFile(path.join(transaction(), 'before-encryption_key.json'))).toEqual(wire);
  for (const file of CREDENTIAL_RECOVERY_FILES) expect(await fs.readFile(path.join(db(), file))).toEqual(original(file));
}));

test('rejects wrong keys and transaction/file/role replay without deleting recovery objects', async () => within(async () => {
  await createCredentialRecoveryBackup(operation, intent(), key);
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, randomBytes(32))).rejects.toThrow('Credential recovery data is invalid or unauthenticated');
  const copiedManifest = await fs.readFile(path.join(transaction(), 'manifest.json'));
  await fs.mkdir(path.join(vault(), OTHER_TRANSACTION), { mode: 0o700 });
  await fs.writeFile(path.join(vault(), OTHER_TRANSACTION, 'manifest.json'), copiedManifest, { mode: 0o600 });
  await expect(readCredentialRecoveryBackup(operation, OTHER_TRANSACTION, key)).rejects.toThrow('Credential recovery data is invalid or unauthenticated');
  const target = path.join(transaction(), 'before-models.json');
  await fs.writeFile(target, await fs.readFile(path.join(transaction(), 'after-models.json')));
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, key)).rejects.toThrow('Credential recovery data is invalid or unauthenticated');
  await fs.writeFile(target, await fs.readFile(path.join(transaction(), 'before-registry_account.json')));
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, key)).rejects.toThrow('Credential recovery data is invalid or unauthenticated');
  expect(await fs.readdir(transaction())).toHaveLength(11);
}));

test('valid authentication cannot substitute bytes that disagree with the encrypted intent witness', async () => within(async () => {
  await createCredentialRecoveryBackup(operation, intent(), key);
  const changed = encryptCredentialRecoveryObject(Buffer.from('synthetic-private-witness-conflict'), key,
    { workspace: WORKSPACE, transactionId: TRANSACTION, role: 'after', file: 'models.json' });
  await fs.writeFile(path.join(transaction(), 'after-models.json'), changed);
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  expect(await fs.readFile(path.join(db(), 'models.json'))).toEqual(original('models.json'));
}));

test('rejects multiply linked original and recovery files without modifying the linked content', async () => within(async () => {
  const models = path.join(db(), 'models.json');
  const linked = path.join(root, 'linked-models');
  await fs.link(models, linked);
  await expect(createCredentialRecoveryBackup(operation, intent(), key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  await fs.unlink(linked);
  await createCredentialRecoveryBackup(operation, intent(), key);
  const recovery = path.join(transaction(), 'before-models.json');
  const recoveryBytes = await fs.readFile(recovery);
  await fs.link(recovery, linked);
  await expect(readCredentialRecoveryBackup(operation, TRANSACTION, key)).rejects.toThrow('Credential recovery backup is unavailable or changed');
  expect(await fs.readFile(linked)).toEqual(recoveryBytes);
}));

test('copies caller bytes, key and intent before asynchronous ownership admission', async () => within(async () => {
  let release!: () => void;
  const admission = new Promise<void>(resolve => { release = resolve; });
  const admitted = { ...operation, assertOwned: () => admission };
  const after = image();
  const expected = Buffer.from(after['models.json']!);
  const retainedKey = Buffer.from(key);
  const candidate = intent(after);
  const pending = createCredentialRecoveryBackup(admitted, candidate, key);
  after['models.json']!.fill(0);
  key.fill(0);
  candidate.transactionId = OTHER_TRANSACTION;
  candidate.targetKeyId = 'c'.repeat(64);
  release();
  const manifest = await pending;
  expect(manifest.transactionId).toBe(TRANSACTION);
  expect(manifest.targetKeyId).toBe('b'.repeat(64));
  const recovered = await readCredentialRecoveryBackup(operation, TRANSACTION, retainedKey);
  expect(recovered.after['models.json']).toEqual(expected);
  clearCredentialRecoveryImage(recovered.before);
  clearCredentialRecoveryImage(recovered.after);
  retainedKey.fill(0);
}));

test('rejects invalid inventory/key intent before creating a backup and projects fixed ownership errors', async () => within(async () => {
  const after = image();
  after['models.json'] = null;
  await expect(createCredentialRecoveryBackup(operation, intent(after), key)).rejects.toThrow('Credential recovery input is invalid');
  await expect(fs.lstat(vault())).rejects.toHaveProperty('code', 'ENOENT');
  await expect(createCredentialRecoveryBackup(operation, intent(), Buffer.alloc(31))).rejects.toThrow('Credential recovery input is invalid');
  const denied = { ...operation, assertOwned: async () => { throw new Error('synthetic-private-owning-path'); } };
  let caught: Error | undefined;
  try { await createCredentialRecoveryBackup(denied, intent(), key); } catch (error) { caught = error as Error; }
  expect(caught!.message).toBe('Credential recovery backup is unavailable or changed; retain all original files and recovery objects before retrying.');
  expect(caught!.cause).toBeUndefined();
  await expect(fs.lstat(vault())).rejects.toHaveProperty('code', 'ENOENT');
}));

test('requires matching selected workspace and existing active directories', async () => {
  await expect(runWithWorkspace('other-recovery-workspace', () => createCredentialRecoveryBackup(operation, intent(), key)))
    .rejects.toThrow('Credential recovery backup is unavailable or changed');
  await fs.rename(db(), `${db()}-retained`);
  await expect(within(() => createCredentialRecoveryBackup(operation, intent(), key))).rejects.toThrow('Credential recovery backup is unavailable or changed');
  await expect(fs.lstat(db())).rejects.toHaveProperty('code', 'ENOENT');
  expect(await fs.readFile(path.join(`${db()}-retained`, 'models.json'))).toEqual(original('models.json'));
});

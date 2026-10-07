import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { encryptWithPassword, decryptWithPassword, getOperatorWorkerBootstrapKey, isEncryptionLocked, unlockValidatedWorkerTransfer } from '@/utils/encryption/secure';
import { lockServer, unlockServer } from '@/utils/encryption/session';
import { metadataRevision, newKeyring, serializeKeyring, type EncryptionMetadata } from '@/utils/encryption/format';
import { sealOAuthCredential } from '@/backend/services/mcp/oauthCredentialStorage';
import { captureWorkspaceSnapshot, writeWorkspaceSnapshotArchive } from '@/backend/services/workspace/snapshotArchive';

jest.setTimeout(60_000);
let root: string;
let secretFile: string;
let serialized: string;
let ciphertext: string;
let metadata: EncryptionMetadata;
let saved: Record<string, string | undefined>;
const workspace = 'worker-transfer';
beforeEach(async () => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY']
    .map(key => [key, process.env[key]]));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-provenance-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'source');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_WORKER_MODE;
  delete process.env.FLUJO_WORKER_SNAPSHOT_KEY;
  secretFile = path.join(root, 'operator-secret');
  await fs.writeFile(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  await runWithWorkspace(workspace, async () => {
    lockServer();
    ciphertext = (await encryptWithPassword('synthetic-model-secret'))!;
    metadata = (await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
    serialized = await getOperatorWorkerBootstrapKey(metadata);
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await runWithWorkspace(workspace, async () => lockServer());
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function activate() {
  process.env.FLUJO_WORKER_MODE = '1';
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  await unlockValidatedWorkerTransfer(serialized, { workspace, root: getWorkspaceDataDir() });
}

test('only validated provenance permits a mountless worker, and generic unlock/lock revoke it', async () => {
  await runWithWorkspace(workspace, async () => {
    process.env.FLUJO_WORKER_MODE = '1'; delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    unlockServer(serialized);
    expect(await isEncryptionLocked()).toBe(true);
    await expect(decryptWithPassword(ciphertext)).rejects.toThrow();
    await activate();
    expect(await isEncryptionLocked()).toBe(false);
    expect(await decryptWithPassword(ciphertext)).toBe('synthetic-model-secret');
    const fresh = (await encryptWithPassword('worker-new-secret'))!;
    expect(await decryptWithPassword(fresh)).toBe('worker-new-secret');
    unlockServer(serialized);
    expect(await isEncryptionLocked()).toBe(true);
    await activate(); lockServer();
    expect(await isEncryptionLocked()).toBe(true);
  });
});

test.each(['mode', 'workspace', 'root', 'key', 'revision', 'missing-revision'])('rejects invalid transfer %s', async variant => {
  await runWithWorkspace(workspace, async () => {
    process.env.FLUJO_WORKER_MODE = variant === 'mode' ? '0' : '1';
    delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    const key = variant === 'key' ? serializeKeyring(newKeyring(), metadataRevision(metadata))
      : variant === 'revision' ? serialized.replace(metadataRevision(metadata), 'a'.repeat(64))
        : variant === 'missing-revision' ? serializeKeyring(JSON.parse(serialized.slice(3))) : serialized;
    await expect(unlockValidatedWorkerTransfer(key, { workspace: variant === 'workspace' ? 'other' : workspace,
      root: variant === 'root' ? root : getWorkspaceDataDir() })).rejects.toThrow();
    expect(await isEncryptionLocked()).toBe(true);
  });
});

test.each(['mode', 'root', 'workspace', 'revision', 'key', 'pending'])('revalidates established provenance after %s changes', async variant => {
  await runWithWorkspace(workspace, async () => {
    await activate();
    if (variant === 'mode') process.env.FLUJO_WORKER_MODE = '0';
    if (variant === 'root') {
      const oldRoot = getWorkspaceDataDir();
      await fs.rename(oldRoot, `${oldRoot}-old`);
      await fs.mkdir(oldRoot);
      await fs.cp(path.join(`${oldRoot}-old`, 'db'), path.join(oldRoot, 'db'), { recursive: true });
    }
    if (variant === 'revision') await saveItem(StorageKey.ENCRYPTION_KEY, { ...metadata, kdf_iterations: metadata.kdf_iterations! + 1 });
    if (variant === 'key') global.__flujo_server_deks_by_workspace!.set(workspace, serializeKeyring(newKeyring(), metadataRevision(metadata)));
    if (variant === 'pending') await fs.writeFile(path.join(getWorkspaceDataDir(), 'db', '.credential-migration.pending'), 'pending');
    const check = async () => {
      expect(await isEncryptionLocked()).toBe(true);
      await expect(decryptWithPassword(ciphertext)).rejects.toThrow();
      await expect(encryptWithPassword('must-deny')).rejects.toThrow();
    };
    if (variant === 'workspace') await runWithWorkspace('other', check); else await check();
  });
});

test.each(['missing', 'changed'])('a configured %s operator mount cannot be bypassed by cached desktop or worker keys', async variant => {
  await runWithWorkspace(workspace, async () => {
    unlockServer(serialized);
    if (variant === 'missing') await fs.unlink(secretFile);
    else await fs.writeFile(secretFile, randomBytes(32).toString('base64url'));
    expect(await isEncryptionLocked()).toBe(true);
    await expect(decryptWithPassword(ciphertext)).resolves.toBeNull();
    await activate();
    process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
    expect(await isEncryptionLocked()).toBe(true);
    await expect(decryptWithPassword(ciphertext)).resolves.toBeNull();
  });
});

test('a cold OS worker restores an authenticated operator snapshot and uses real model/OAuth encryption without the source mount', async () => {
  await runWithWorkspace(workspace, async () => {
    await saveItem(StorageKey.MODELS, [{ id: 'offline', adapter: 'openai', ApiKey: `encrypted:${ciphertext}` }]);
    await saveItem(StorageKey.MCP_SERVERS, { offline: { name: 'offline', transport: 'streamable', url: 'https://example.invalid/mcp',
      oauthTokens: await sealOAuthCredential('tokens', { access_token: 'synthetic-oauth', token_type: 'Bearer' }) } });
    const key = randomBytes(32);
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = key.toString('base64');
    const captured = await captureWorkspaceSnapshot(workspace, 1);
    let archive: Awaited<ReturnType<typeof writeWorkspaceSnapshotArchive>> | undefined;
    let failed = false;
    try {
      archive = await writeWorkspaceSnapshotArchive(captured);
      const result = spawnSync(process.execPath, [path.resolve('__tests__/encryption/fixtures/worker-transfer-child.cjs'),
        process.cwd(), require.resolve('typescript')], { encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, FLUJO_DATA_DIR: path.join(root, 'worker'), FLUJO_ENCRYPTION_SECRET_FILE: undefined,
          FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: archive.archivePath, FLUJO_WORKER_SNAPSHOT_KEY: key.toString('base64'),
          FLUJO_WORKER_SNAPSHOT_SHA256: archive.plaintextSha256 } });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('WORKER_TRANSFER_SOURCE_PASS');
    } catch (error) { failed = true; throw error; } finally {
      const cleanup = await Promise.allSettled([
        captured.dispose?.(),
        ...(archive ? [fs.rm(archive.stagingDir, { recursive: true, force: true })] : []),
      ]);
      if (!failed) for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    }
  });
});

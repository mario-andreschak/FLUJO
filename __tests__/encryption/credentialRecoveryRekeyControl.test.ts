// Crypto/storage are real. This fixture models process lock admission and does
// not run an installed server or establish cross-process ownership.
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withWorkspaceProcessMutation: (task: () => Promise<unknown>) => task(),
  withWorkspaceRuntimeLock: (_key: string, task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) =>
    task({ assertOwned: async () => undefined }),
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PASSWORD, keyId, newKeyring, open, unwrapKeyring, wrapKeyring } from '@/utils/encryption/format';
import { initializeEncryption, encryptWithPassword } from '@/utils/encryption/secure';
import { runWithWorkspace } from '@/utils/workspace';
import { CREDENTIAL_RECOVERY_FILES } from '@/utils/encryption/credentialRecoveryFormat';
import { encryptCredentialRecoveryManifest, type CredentialRecoveryManifest } from '@/utils/encryption/credentialRecoveryManifest';

test('current password rewrap permits copied public metadata to decrypt a future credential; recovery intent refuses the unchanged key', async () => {
  const priorDataRoot = process.env.FLUJO_DATA_DIR;
  const priorOperatorFile = process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'flujo-rekey-current-control-'));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  try {
    await runWithWorkspace('rekey-current-control', async () => {
      const originalRing = newKeyring();
      const copiedPublicMetadata = await wrapKeyring(originalRing, 'default', DEFAULT_PASSWORD);
      const db = path.join(root, 'workspaces', 'rekey-current-control', 'db');
      await fs.mkdir(db, { recursive: true });
      const metadataFile = path.join(db, 'encryption_key.json');
      await fs.writeFile(metadataFile, JSON.stringify(copiedPublicMetadata), { flag: 'wx', mode: 0o600 });
      const privatePassword = 'synthetic-private-password-for-current-rewrap-control';
      expect(await initializeEncryption(privatePassword)).toBe(true);
      const privateMetadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
      expect(privateMetadata.encryption_type).toBe('user');
      expect(privateMetadata.key_id).toBe(copiedPublicMetadata.key_id);
      const future = await encryptWithPassword('synthetic-future-private-credential', privatePassword);
      expect(future?.startsWith('v2:')).toBe(true);
      const attackerRing = await unwrapKeyring(copiedPublicMetadata, DEFAULT_PASSWORD);
      expect(open(future!, attackerRing.activeKey, 'flujo:secret:v2')).toBe('synthetic-future-private-credential');

      const intent: CredentialRecoveryManifest = {
        format: 'flujo-credential-recovery-manifest', version: 1, workspace: 'rekey-current-control',
        transactionId: 'd858dc1f-77d8-4198-9b6d-571fd2fd7a8f', sourceKeyId: keyId(originalRing),
        targetKeyId: privateMetadata.key_id, phase: 'prepared',
        entries: CREDENTIAL_RECOVERY_FILES.map(file => ({ file, before: { size: 1, sha256: 'a'.repeat(64) },
          after: { size: 1, sha256: 'b'.repeat(64) } })),
      };
      expect(() => encryptCredentialRecoveryManifest(intent, Buffer.alloc(32, 0x11))).toThrow('Credential recovery input is invalid');
    });
  } finally {
    if (priorDataRoot === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataRoot;
    if (priorOperatorFile === undefined) delete process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
    else process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = priorOperatorFile;
    expect(path.dirname(await fs.realpath(root))).toBe(tempRoot);
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

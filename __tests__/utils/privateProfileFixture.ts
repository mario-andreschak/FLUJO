import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';
import { newKeyring, wrapKeyring, type EncryptionMetadata } from '@/utils/encryption/format';

const passphrase = 'explicit-test-private-profile-passphrase';
let profile: Promise<EncryptionMetadata> | undefined;

/** Real private wrapping and authentication for fixtures testing unlocked behavior. */
export async function installPrivateProfileFixture(persist?: (metadata: EncryptionMetadata) => Promise<void> | void) {
  const saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE']
    .map(key => [key, process.env[key]]));
  const priorDek = global.__flujo_server_dek;
  const priorSessions = global.__flujo_encryption_sessions;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-unlocked-private-fixture-'));
  await fs.mkdir(path.join(root, 'workspaces', 'default-workspace', 'db'), { recursive: true });
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  profile ??= wrapKeyring(newKeyring(), 'user', passphrase, 'passphrase');
  const metadata = structuredClone(await profile);
  if (persist) await persist(metadata);
  else {
    const { saveItem } = await import('@/utils/storage/backend');
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  }
  const secure = await import('@/utils/encryption/secure');
  if (!await secure.authenticate(passphrase) || await secure.isEncryptionLocked()) throw new Error('Private test profile did not unlock.');
  return {
    root,
    async restore() {
      global.__flujo_server_dek = priorDek;
      global.__flujo_encryption_sessions = priorSessions;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      // Absolute generated fixture directory; never a repository checkout.
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

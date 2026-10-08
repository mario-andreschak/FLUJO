import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';
import { newKeyring, wrapKeyring, type EncryptionMetadata } from '@/utils/encryption/format';
import { captureOwnedFixtureDirectory, removeOwnedFixtureDirectoryAsync } from '../mcp/fixtures/ownedFixtureDirectory';

const passphrase = 'explicit-test-private-profile-passphrase';
let profile: Promise<EncryptionMetadata> | undefined;

/** For existing disposable workspace fixtures, preserve their data-root selection. */
export async function unlockPrivateFixtureInCurrentWorkspace(persist?: (metadata: EncryptionMetadata) => Promise<void> | void) {
  profile ??= wrapKeyring(newKeyring(), 'user', passphrase, 'passphrase');
  const metadata = structuredClone(await profile);
  if (persist) await persist(metadata);
  else {
    const { saveItem } = await import('@/utils/storage/backend');
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  }
  const secure = await import('@/utils/encryption/secure');
  if (!await secure.authenticate(passphrase) || await secure.isEncryptionLocked()) throw new Error('Private test profile did not unlock.');
}

/** Real private wrapping and authentication for fixtures testing unlocked behavior. */
export async function installPrivateProfileFixture(persist?: (metadata: EncryptionMetadata) => Promise<void> | void) {
  const saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE']
    .map(key => [key, process.env[key]]));
  const priorDek = global.__flujo_server_dek;
  const priorSessions = global.__flujo_encryption_sessions;
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'flujo-unlocked-private-fixture-'));
  const rootOwnership = captureOwnedFixtureDirectory(root);
  await fs.mkdir(path.join(root, 'workspaces', 'default-workspace', 'db'), { recursive: true });
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  const restoreEnvironment = () => {
    global.__flujo_server_dek = priorDek;
    global.__flujo_encryption_sessions = priorSessions;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  try { await unlockPrivateFixtureInCurrentWorkspace(persist); }
  catch (primary) {
    // Preserve the owned root for inspection on failed actual setup, while
    // restoring the original globals/environment independently.
    try { restoreEnvironment(); }
    catch (cleanup) { throw Object.assign(new AggregateError([primary, cleanup], 'Private profile setup/environment restoration failed'), { root }); }
    throw Object.assign(new Error('Private profile setup failed; owned root preserved', { cause: primary }), { root });
  }
  return {
    root,
    restoreEnvironment,
    async restore() {
      restoreEnvironment();
      await removeOwnedFixtureDirectoryAsync(rootOwnership, parent, 'flujo-unlocked-private-fixture-');
    },
  };
}

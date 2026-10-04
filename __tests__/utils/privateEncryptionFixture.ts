import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { initializeEncryption, authenticate, isEncryptionInitialized, getEncryptionType } from '@/utils/encryption/secure';

const fixturePassword = randomBytes(32).toString('hex');

/** Enroll only the ordinary Jest-owned root, using the real metadata and auth APIs. */
export async function enrollPrivateEncryptionFixture(): Promise<void> {
  const root = path.resolve(process.env.FLUJO_DATA_DIR ?? '');
  const relative = path.relative(path.resolve(os.tmpdir()), root);
  if (!/^flujo-jest-data-[0-9]+-[A-Za-z0-9]+$/.test(relative)) {
    throw new Error('Private encryption fixture requires the ordinary Jest-owned root');
  }
  if (!await isEncryptionInitialized() && !await initializeEncryption(fixturePassword)) {
    throw new Error('Private encryption fixture enrollment failed');
  }
  if (await getEncryptionType() !== 'user' || !await authenticate(fixturePassword)) {
    throw new Error('Private encryption fixture authentication failed');
  }
}

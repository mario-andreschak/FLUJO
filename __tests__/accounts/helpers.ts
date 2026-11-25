import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetAccountsStoreCache } from '@/backend/services/accounts/store';
import { resetSignInThrottle } from '@/backend/services/accounts/signInThrottle';

/** A fresh, empty data folder for one test, with the accounts caches cleared. */
export async function useTemporaryDataDir(): Promise<{ dir: string; restore: () => Promise<void> }> {
  const previous = process.env.FLUJO_DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-accounts-'));
  process.env.FLUJO_DATA_DIR = dir;
  resetAccountsStoreCache();
  resetSignInThrottle();
  return {
    dir,
    restore: async () => {
      resetAccountsStoreCache();
      resetSignInThrottle();
      if (previous === undefined) delete process.env.FLUJO_DATA_DIR;
      else process.env.FLUJO_DATA_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Every file under a folder with its bytes, for byte-for-byte comparisons. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result[path.relative(root, full).split(path.sep).join('/')] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(root);
  return result;
}

/** Fast hashes for tests (2^14 instead of 2^17); production always uses SCRYPT_PARAMETERS. */
export const TEST_LOG_N = 14;

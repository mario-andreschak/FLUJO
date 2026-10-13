import { randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { readPlainFile } from '@/utils/readPlainFile';

export class StatisticsKeyAdmissionError extends Error {
  readonly code = 'UNSAFE_STATISTICS_KEY';

  constructor() {
    super('Statistics installation key is unavailable or unsafe.');
    this.name = 'StatisticsKeyAdmissionError';
  }
}

function ownerIsCurrentUser(stat: BigIntStats): boolean {
  if (process.platform === 'win32') return true;
  const uid = process.geteuid?.() ?? process.getuid?.();
  return uid !== undefined && stat.uid === BigInt(uid);
}

function admitDirectory(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerIsCurrentUser(stat)
      || (process.platform !== 'win32' && (stat.mode & BigInt(0o022)) !== BigInt(0))) {
    throw new StatisticsKeyAdmissionError();
  }
}

async function readKey(keyFile: string, verifyDirectory: () => Promise<void>, expected?: BigIntStats): Promise<Buffer> {
  const stat = expected ?? await fs.lstat(keyFile, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1) || stat.size !== BigInt(32)
      || !ownerIsCurrentUser(stat)
      || (process.platform !== 'win32' && (stat.mode & BigInt(0o077)) !== BigInt(0))) {
    throw new StatisticsKeyAdmissionError();
  }
  const bytes = await readPlainFile(keyFile, {
    expected: stat, maxBytes: 32, ownerOnly: true, verifyPath: verifyDirectory,
  });
  if (bytes.length !== 32) throw new StatisticsKeyAdmissionError();
  return bytes;
}

/** Preserve an admitted durable key; unsafe existing files are never repaired or replaced. */
export async function loadInstallationKey(directory: string): Promise<Buffer> {
  try {
    const resolved = path.resolve(directory);
    const keyFile = path.join(resolved, '.installation-key');
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const parent = await fs.lstat(resolved, { bigint: true });
    admitDirectory(parent);
    const canonical = await fs.realpath(resolved);
    const verifyDirectory = async (): Promise<void> => {
      const current = await fs.lstat(resolved, { bigint: true });
      admitDirectory(current);
      for (const field of ['dev', 'ino', 'mode', 'uid', 'gid'] as const) {
        if (current[field] !== parent[field]) throw new StatisticsKeyAdmissionError();
      }
      if (await fs.realpath(resolved) !== canonical) throw new StatisticsKeyAdmissionError();
    };
    await verifyDirectory();

    // Only absence at this first admission permits creation. A disappeared or
    // replaced key during a subsequent read must not generate a new identity.
    let existing: BigIntStats | undefined;
    try {
      existing = await fs.lstat(keyFile, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) return await readKey(keyFile, verifyDirectory, existing);

    await verifyDirectory();
    try {
      await fs.writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Both our publication and a concurrent creator's winner get identical
    // descriptor, path, ownership and length admission before any HMAC use.
    await verifyDirectory();
    return await readKey(keyFile, verifyDirectory);
  } catch {
    // Native errors and file metadata can contain paths or owner records.
    throw new StatisticsKeyAdmissionError();
  }
}

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { atomicWriteWithoutLinks, assertLinkFreeFileParent } from '@/backend/services/workspace/backupRestoreFs';
import { readPlainFile } from '@/utils/readPlainFile';

type Guard = () => Promise<void>;
const unavailable = () => new Error('Managed Codex runtime path is unsafe or changed.');

function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
    && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}

/** Admit ancestors individually; recursive mkdir would follow a planted alias. */
export async function admitCodexDirectory(directory: string, create = false): Promise<Guard> {
  const target = path.resolve(directory);
  const root = path.parse(target).root;
  const admitted: Array<{ name: string; stat: BigIntStats }> = [];
  let current = root;
  for (const segment of ['', ...path.relative(root, target).split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    let stat: BigIntStats;
    try { stat = await fs.lstat(current, { bigint: true }); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      for (const entry of admitted) {
        if (!sameDirectory(entry.stat, await fs.lstat(entry.name, { bigint: true }))) throw unavailable();
      }
      await fs.mkdir(current, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      stat = await fs.lstat(current, { bigint: true });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    admitted.push({ name: current, stat });
  }
  const canonical = await fs.realpath(target);
  if (path.relative(target, canonical) !== '') throw unavailable();
  const last = admitted[admitted.length - 1];
  if (create && process.platform !== 'win32') {
    if (last.stat.uid !== BigInt(process.getuid?.() ?? -1)) throw unavailable();
    // Tighten a legacy home using its admitted descriptor, never a path chmod.
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameDirectory(last.stat, await handle.stat({ bigint: true }))) throw unavailable();
      await handle.chmod(0o700);
      last.stat = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
  }
  const guard = async () => {
    for (const entry of admitted) {
      if (!sameDirectory(entry.stat, await fs.lstat(entry.name, { bigint: true }))) throw unavailable();
    }
    if (await fs.realpath(target) !== canonical) throw unavailable();
  };
  await guard();
  return guard;
}

async function assertPlainTarget(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)
        || (process.platform !== 'win32' && stat.uid !== BigInt(process.getuid?.() ?? -1))) throw unavailable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function writeCodexRuntimeFile(home: string, file: string, content: Buffer | string, guard: Guard): Promise<void> {
  await guard();
  await assertLinkFreeFileParent(home, file);
  await assertPlainTarget(file);
  await atomicWriteWithoutLinks(home, file, Buffer.isBuffer(content) ? content : Buffer.from(content), { mode: 0o600 });
  await guard();
  await assertPlainTarget(file);
}

export async function readCodexRuntimeFile(home: string, file: string, maxBytes: number, guard: Guard): Promise<Buffer> {
  await guard();
  await assertPlainTarget(file);
  return readPlainFile(file, { maxBytes, ownerOnly: true, verifyPath: async () => {
    await guard();
    await assertLinkFreeFileParent(home, file);
  } });
}

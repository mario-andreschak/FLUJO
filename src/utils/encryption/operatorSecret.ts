import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDataDir } from '@/utils/paths';
import { realpath } from '@/utils/realpath';

const MAX_BYTES = 1024;
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
    .every(field => a[field as keyof BigIntStats] === b[field as keyof BigIntStats]);
}

/** Returned only after a fresh bounded read and all file/permission checks. */
export async function readVerifiedOperatorSecret(): Promise<{ secret: string; identity: string } | null> {
  const configured = process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  if (configured === undefined) return null;
  if (!path.isAbsolute(configured)) throw new Error('Private encryption secret is unavailable');
  const file = path.resolve(configured);
  const roots = [path.resolve(getDataDir())];
  try { roots.push(await realpath(roots[0])); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (roots.some(root => {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) {
    throw new Error('Private encryption secret must be outside the data directory');
  }
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
      || before.size > BigInt(MAX_BYTES) || path.relative(await realpath(file), file) !== ''
      || (process.platform !== 'win32' && ((before.mode & BigInt(0o077)) !== BigInt(0)
        || before.uid !== BigInt(process.getuid?.() ?? -1)))) throw new Error('Private encryption secret is unavailable');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Private encryption secret changed');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (BigInt(length) !== opened.size || !sameFile(opened, await handle.stat({ bigint: true }))
        || !sameFile(opened, await fs.lstat(file, { bigint: true }))
        || path.relative(await realpath(file), file) !== '') throw new Error('Private encryption secret changed');
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9_-]{43,512}$/.test(secret)) throw new Error('Private encryption secret is invalid');
    const identity = createHash('sha256').update(JSON.stringify([file,
      ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
        .map(field => String(opened[field as keyof BigIntStats])),
    ])).digest('hex');
    return { secret, identity };
  } finally { await handle.close(); }
}

/** Operator-provisioned secret mount, never a generated key beside ciphertext. */
export async function readOperatorSecret(): Promise<string | null> {
  return (await readVerifiedOperatorSecret())?.secret ?? null;
}

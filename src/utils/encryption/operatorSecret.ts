import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/utils/paths';

const MAX_BYTES = 1024;
function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
    .every(field => a[field as keyof fs.BigIntStats] === b[field as keyof fs.BigIntStats]);
}

/** Operator-provisioned secret mount, never a generated key beside ciphertext. */
export function readOperatorSecret(): string | null {
  const configured = process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  if (configured === undefined) return null;
  if (!path.isAbsolute(configured)) throw new Error('Private encryption secret is unavailable');
  const file = path.resolve(configured);
  const roots = [path.resolve(getDataDir())];
  try { roots.push(fs.realpathSync(roots[0])); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (roots.some(root => {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) {
    throw new Error('Private encryption secret must be outside the data directory');
  }
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
      || before.size > BigInt(MAX_BYTES) || path.relative(fs.realpathSync(file), file) !== ''
      || (process.platform !== 'win32' && ((before.mode & BigInt(0o077)) !== BigInt(0)
        || before.uid !== BigInt(process.getuid?.() ?? -1)))) throw new Error('Private encryption secret is unavailable');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Private encryption secret changed');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (BigInt(length) !== opened.size || !sameFile(opened, fs.fstatSync(fd, { bigint: true }))
        || !sameFile(opened, fs.lstatSync(file, { bigint: true }))
        || path.relative(fs.realpathSync(file), file) !== '') throw new Error('Private encryption secret changed');
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9_-]{43,512}$/.test(secret)) throw new Error('Private encryption secret is invalid');
    return secret;
  } finally { fs.closeSync(fd); }
}

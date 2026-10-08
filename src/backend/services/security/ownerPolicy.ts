import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ownerPolicySchema, type OwnerPolicy } from './ownerCredentials';

export const MAX_OWNER_POLICY_BYTES = 64 * 1024;

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
    .every(field => first[field as keyof BigIntStats] === second[field as keyof BigIntStats]);
}

function assertPrivateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)
      || stat.size > BigInt(MAX_OWNER_POLICY_BYTES)
      || (process.platform !== 'win32' && ((stat.mode & BigInt(0o077)) !== BigInt(0)
        || stat.uid !== BigInt(process.getuid?.() ?? -1)))) throw new Error('Invalid owner policy file');
}

export function readOwnerPolicy(filename: string): OwnerPolicy {
  if (!path.isAbsolute(filename)) throw new Error('Invalid owner policy path');
  const resolved = path.resolve(filename);
  const before = lstatSync(resolved, { bigint: true });
  assertPrivateFile(before);
  const canonical = realpathSync(resolved);
  if (path.relative(canonical, resolved) !== '') throw new Error('Invalid owner policy path');
  const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    assertPrivateFile(stat);
    if (!sameFile(before, stat)) throw new Error('Owner policy changed');
    const bytes = Buffer.alloc(MAX_OWNER_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const finalNamed = lstatSync(resolved, { bigint: true });
    if (length > MAX_OWNER_POLICY_BYTES || BigInt(length) !== stat.size
        || !sameFile(stat, fstatSync(fd, { bigint: true })) || !sameFile(stat, finalNamed)
        || finalNamed.isSymbolicLink() || path.relative(canonical, realpathSync(resolved)) !== '') {
      throw new Error('Owner policy changed');
    }
    return ownerPolicySchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

export function ownerPolicyRevision(policy: OwnerPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

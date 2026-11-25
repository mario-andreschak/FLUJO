import { constants, promises as fs, type BigIntStats } from 'node:fs';
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

export async function readOwnerPolicy(filename: string): Promise<OwnerPolicy> {
  if (!path.isAbsolute(filename)) throw new Error('Invalid owner policy path');
  const resolved = path.resolve(filename);
  const before = await fs.lstat(resolved, { bigint: true });
  assertPrivateFile(before);
  const canonical = await fs.realpath(resolved);
  if (path.relative(canonical, resolved) !== '') throw new Error('Invalid owner policy path');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    assertPrivateFile(stat);
    if (!sameFile(before, stat)) throw new Error('Owner policy changed');
    const bytes = Buffer.alloc(MAX_OWNER_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const finalNamed = await fs.lstat(resolved, { bigint: true });
    if (length > MAX_OWNER_POLICY_BYTES || BigInt(length) !== stat.size
        || !sameFile(stat, await handle.stat({ bigint: true })) || !sameFile(stat, finalNamed)
        || finalNamed.isSymbolicLink() || path.relative(canonical, await fs.realpath(resolved)) !== '') {
      throw new Error('Owner policy changed');
    }
    return ownerPolicySchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    await handle.close();
  }
}

export function ownerPolicyRevision(policy: OwnerPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

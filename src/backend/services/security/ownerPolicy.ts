import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ownerPolicySchema, type OwnerPolicy } from './ownerCredentials';

export const MAX_OWNER_POLICY_BYTES = 64 * 1024;

export function readOwnerPolicy(filename: string): OwnerPolicy {
  if (!path.isAbsolute(filename)) throw new Error('Invalid owner policy path');
  const fd = openSync(filename, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_POLICY_BYTES
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Invalid owner policy file');
    }
    const bytes = Buffer.alloc(MAX_OWNER_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_OWNER_POLICY_BYTES) throw new Error('Owner policy too large');
    return ownerPolicySchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

export function ownerPolicyRevision(policy: OwnerPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

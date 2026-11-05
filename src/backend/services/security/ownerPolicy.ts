import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ownerPolicySchema, type OwnerCredential, type OwnerPolicy } from './ownerCredentials';

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

/** The people page replaces this file while requests read it, so one in-flight change is normal. */
const READ_ATTEMPTS = 4;
const READ_RETRY_WAIT_MS = 15;

function isTransientReadFailure(error: unknown): boolean {
  if (error instanceof Error && error.message === 'Owner policy changed') return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export function readOwnerPolicy(filename: string): OwnerPolicy {
  for (let attempt = 1; ; attempt += 1) {
    try { return readOwnerPolicyOnce(filename); }
    catch (error) {
      if (attempt >= READ_ATTEMPTS || !isTransientReadFailure(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_WAIT_MS);
    }
  }
}

function readOwnerPolicyOnce(filename: string): OwnerPolicy {
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

/** True only when a readable schema 2 policy is selected. Never throws. */
export function isNamedAccessOn(): boolean {
  const configured = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  if (!configured) return false;
  try { return readOwnerPolicy(configured).schemaVersion === 2; } catch { return false; }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** What decides authority. A new display name must not sign anybody out. */
function authorityOf(credential: OwnerCredential): unknown {
  const { name: _name, createdBy: _createdBy, ...authority } = credential;
  return authority;
}

/**
 * The revision that owner-level approvals are pinned to. Schema 1 keeps its
 * conservative rule: any change to the file counts. In schema 2 only the people
 * who hold administration count, so adding a colleague does not silently cancel
 * an approval that an administrator gave.
 */
export function ownerPolicyRevision(policy: OwnerPolicy): string {
  if (policy.schemaVersion !== 2) return sha256(policy);
  return sha256({ schemaVersion: policy.schemaVersion, ownerId: policy.ownerId,
    admins: policy.credentials
      .filter(credential => credential.scopes.includes('control:admin'))
      .map(authorityOf) });
}

/**
 * The revision one request, stream or browser session is pinned to. Schema 1 is
 * again the whole file. In schema 2 it is only that person's record, so managing
 * people never logs everyone out or cuts every running stream.
 */
export function ownerCredentialRevision(policy: OwnerPolicy, credentialId: string): string | null {
  const credential = policy.credentials.find(value => value.id === credentialId);
  if (!credential) return null;
  if (policy.schemaVersion !== 2) return sha256(policy);
  return sha256({ schemaVersion: policy.schemaVersion, ownerId: policy.ownerId, credential: authorityOf(credential) });
}

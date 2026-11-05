import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACCESS_ROLES, ACCESS_ROLE_SCOPES, OWNER_SCOPES, hasAdminPair, namedCredentialProblem,
  type AccessRoleOrCustom, type OwnerScope,
} from '../../../shared/types/access';
import {
  OWNER_CREDENTIAL_MAX_FLOWS, OWNER_CREDENTIAL_NAME_MAX_LENGTH, issueNamedCredential, ownerPolicySchema,
  type OwnerCredential, type OwnerPolicy,
} from './ownerCredentials';
import { MAX_OWNER_POLICY_BYTES, ownerCredentialRevision, ownerPolicyRevision, readOwnerPolicy } from './ownerPolicy';
import type { AccessActor } from './accessContext';

/** Managing people without opening the policy file. Every change is one atomic replacement. */

export class AccessPeopleError extends Error {
  constructor(readonly code: 'NAMED_ACCESS_OFF' | 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'LAST_ADMIN' | 'POLICY_FULL' | 'BUSY',
    message: string, readonly status: number) {
    super(message);
    this.name = 'AccessPeopleError';
  }
}

export interface PersonView {
  id: string;
  name: string;
  role: AccessRoleOrCustom;
  scopes: OwnerScope[];
  workspaceId?: string;
  flowIds?: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: 'active' | 'expired' | 'revoked';
  createdBy?: string;
  self: boolean;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;
const MAX_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CREDENTIALS = 128;

function policyFile(): string {
  const filename = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  if (!filename || !path.isAbsolute(filename)) {
    throw new AccessPeopleError('NAMED_ACCESS_OFF', 'Named access is off on this installation.', 409);
  }
  return filename;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialises changes across this server and the recovery tool. A crashed holder
 * cannot block forever: a lock older than 30 seconds is taken over. Contention
 * waits briefly and then answers busy, so the caller can simply try again.
 */
function withPolicyLock<T>(filename: string, run: () => T): T {
  const lock = `${filename}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { /* The holder just finished. Try again at once. */ continue; }
      if (Date.now() > deadline) throw new AccessPeopleError('BUSY', 'Another change is in progress. Try again.', 503);
      sleepSync(25);
    }
  }
  try { return run(); }
  finally { try { fs.unlinkSync(lock); } catch { /* Stale takeover already removed it. */ } }
}

function replaceWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
      sleepSync(25 * attempt);
    }
  }
}

/** Keeps the last good policy beside the current one, so a bad edit has a way back. */
function writePolicy(filename: string, policy: OwnerPolicy): void {
  const valid = ownerPolicySchema.parse(policy);
  const bytes = JSON.stringify(valid);
  if (Buffer.byteLength(bytes) > MAX_OWNER_POLICY_BYTES) {
    throw new AccessPeopleError('POLICY_FULL', 'The access list is full. Revoke people you no longer need, or shorten flow lists.', 409);
  }
  const staged = path.join(path.dirname(filename), `.owner-policy-${randomUUID()}`);
  const fd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try {
    try { fs.copyFileSync(filename, `${filename}.previous`); fs.chmodSync(`${filename}.previous`, 0o600); }
    catch { /* The backup is a convenience. It must not stop a valid change. */ }
    replaceWithRetry(staged, filename);
  } catch (error) {
    try { fs.unlinkSync(staged); } catch { /* Nothing more can be done here. */ }
    throw error;
  }
}

function statusOf(credential: OwnerCredential, now: number): PersonView['status'] {
  if (credential.revokedAt !== null) return 'revoked';
  return credential.expiresAt <= now ? 'expired' : 'active';
}

function viewOf(credential: OwnerCredential, actor: AccessActor | undefined, now: number): PersonView {
  return {
    id: credential.id,
    name: credential.name ?? `Credential ${credential.id.slice(0, 8)}`,
    role: credential.role ?? 'custom',
    scopes: [...credential.scopes],
    ...(credential.workspaceId === undefined ? {} : { workspaceId: credential.workspaceId }),
    ...(credential.flowIds === undefined ? {} : { flowIds: [...credential.flowIds] }),
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    status: statusOf(credential, now),
    ...(credential.createdBy === undefined ? {} : { createdBy: credential.createdBy }),
    self: credential.id === actor?.credentialId,
  };
}

function activeAdminCount(policy: OwnerPolicy, now: number): number {
  return policy.credentials.filter(credential => statusOf(credential, now) === 'active'
    && hasAdminPair(credential.scopes) && credential.scopes.includes('access:manage')).length;
}

function requireNamedPolicy(filename: string): OwnerPolicy {
  const policy = readOwnerPolicy(filename);
  if (policy.schemaVersion !== 2) {
    throw new AccessPeopleError('NAMED_ACCESS_OFF', 'Named access is off. An administrator can turn it on first.', 409);
  }
  return policy;
}

/** Nobody hands out more than they hold, and a site manager stays inside the site. */
function assertWithinActor(actor: AccessActor, target: { scopes: readonly OwnerScope[]; workspaceId?: string }): void {
  if (actor.isAdmin) return;
  if (target.scopes.some(scope => !actor.scopes.includes(scope))) {
    throw new AccessPeopleError('FORBIDDEN', 'You cannot grant or change access you do not hold yourself.', 403);
  }
  if (actor.workspaceId !== undefined && target.workspaceId !== actor.workspaceId) {
    throw new AccessPeopleError('FORBIDDEN', 'You can only manage people in your own workspace.', 403);
  }
}

function validName(value: unknown): string {
  if (typeof value !== 'string') throw new AccessPeopleError('INVALID', 'A name is required.', 400);
  const name = value.trim();
  if (!name || name.length > OWNER_CREDENTIAL_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AccessPeopleError('INVALID', `A name must be 1 to ${OWNER_CREDENTIAL_NAME_MAX_LENGTH} plain characters.`, 400);
  }
  return name;
}

function validExpiry(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > now + MAX_EXPIRY_MS) {
    throw new AccessPeopleError('INVALID', 'The expiry must be a time within the next ten years.', 400);
  }
  return value;
}

function validScopes(role: unknown, scopes: unknown): { role: AccessRoleOrCustom; scopes: OwnerScope[] } {
  if (role !== undefined && role !== 'custom' && !(ACCESS_ROLES as readonly unknown[]).includes(role)) {
    throw new AccessPeopleError('INVALID', 'Unknown role.', 400);
  }
  if (role !== undefined && role !== 'custom') {
    if (scopes !== undefined) throw new AccessPeopleError('INVALID', 'Choose either a role or a custom scope list.', 400);
    return { role: role as AccessRoleOrCustom, scopes: [...ACCESS_ROLE_SCOPES[role as keyof typeof ACCESS_ROLE_SCOPES]] };
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !(OWNER_SCOPES as readonly unknown[]).includes(scope))) {
    throw new AccessPeopleError('INVALID', 'A custom role needs a list of known scopes.', 400);
  }
  return { role: 'custom', scopes: scopes as OwnerScope[] };
}

function validFlows(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > OWNER_CREDENTIAL_MAX_FLOWS
    || new Set(value).size !== value.length
    || value.some(item => typeof item !== 'string' || !item || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item))) {
    throw new AccessPeopleError('INVALID', `A flow limit is a list of 1 to ${OWNER_CREDENTIAL_MAX_FLOWS} flow ids.`, 400);
  }
  return value as string[];
}

function validWorkspace(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new AccessPeopleError('INVALID', 'That is not a valid workspace name.', 400);
  }
  return value;
}

function assertRules(fields: Parameters<typeof namedCredentialProblem>[0]): void {
  const problem = namedCredentialProblem(fields);
  if (problem) throw new AccessPeopleError('INVALID', problem, 400);
}

/** Long-revoked and long-expired entries make room first, so the list recovers on its own. */
function pruneForSpace(policy: OwnerPolicy, now: number): OwnerCredential[] {
  const keep = policy.credentials.filter(credential => {
    const ended = credential.revokedAt ?? (credential.expiresAt <= now ? credential.expiresAt : null);
    return ended === null || now - ended < PRUNE_AFTER_MS;
  });
  if (keep.length < MAX_CREDENTIALS) return keep;
  const ended = keep.filter(credential => statusOf(credential, now) !== 'active')
    .sort((first, second) => (first.revokedAt ?? first.expiresAt) - (second.revokedAt ?? second.expiresAt));
  const oldest = ended[0];
  if (!oldest) {
    throw new AccessPeopleError('POLICY_FULL', 'The access list is full. Revoke people you no longer need.', 409);
  }
  return keep.filter(credential => credential.id !== oldest.id);
}

export function listPeople(actor: AccessActor, now = Date.now()): PersonView[] {
  const policy = requireNamedPolicy(policyFile());
  return policy.credentials
    .filter(credential => actor.workspaceId === undefined || credential.workspaceId === actor.workspaceId)
    .map(credential => viewOf(credential, actor, now));
}

export function createPerson(actor: AccessActor, input: {
  name: unknown; role?: unknown; scopes?: unknown; expiresAt: unknown; workspaceId?: unknown; flowIds?: unknown;
}, now = Date.now()): { person: PersonView; token: string } {
  const name = validName(input.name);
  const { role, scopes } = validScopes(input.role, input.scopes);
  const expiresAt = validExpiry(input.expiresAt, now);
  if (expiresAt <= now) throw new AccessPeopleError('INVALID', 'The expiry must be in the future.', 400);
  const flowIds = validFlows(input.flowIds);
  const workspaceId = validWorkspace(input.workspaceId) ?? actor.workspaceId;
  assertRules({ scopes, role, ...(workspaceId === undefined ? {} : { workspaceId }), ...(flowIds === undefined ? {} : { flowIds }) });
  assertWithinActor(actor, { scopes, ...(workspaceId === undefined ? {} : { workspaceId }) });
  const filename = policyFile();
  return withPolicyLock(filename, () => {
    const policy = requireNamedPolicy(filename);
    const issued = issueNamedCredential({
      name, scopes, expiresAt, role, createdBy: actor.credentialId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(flowIds === undefined ? {} : { flowIds }),
    }, now);
    writePolicy(filename, { ...policy, credentials: [...pruneForSpace(policy, now), issued.record] });
    return { person: viewOf(issued.record, actor, now), token: issued.token };
  });
}

export function updatePerson(actor: AccessActor, id: string, patch: {
  name?: unknown; role?: unknown; scopes?: unknown; expiresAt?: unknown; workspaceId?: unknown; flowIds?: unknown;
}, now = Date.now()): PersonView {
  const filename = policyFile();
  return withPolicyLock(filename, () => {
    const policy = requireNamedPolicy(filename);
    const current = policy.credentials.find(credential => credential.id === id);
    if (!current || (actor.workspaceId !== undefined && current.workspaceId !== actor.workspaceId)) {
      throw new AccessPeopleError('NOT_FOUND', 'That person was not found.', 404);
    }
    assertWithinActor(actor, current);
    if (current.revokedAt !== null && patch.name === undefined) {
      throw new AccessPeopleError('INVALID', 'A revoked credential stays revoked. Create a new one instead.', 400);
    }
    const next: OwnerCredential = { ...current };
    if (patch.name !== undefined) next.name = validName(patch.name);
    if (patch.role !== undefined || patch.scopes !== undefined) {
      if (id === actor.credentialId && !actor.isAdmin) {
        throw new AccessPeopleError('FORBIDDEN', 'You cannot change your own access.', 403);
      }
      const access = validScopes(patch.role, patch.scopes);
      next.role = access.role;
      next.scopes = access.scopes;
    }
    if (patch.expiresAt !== undefined) {
      // "Expire now" must stay valid even for a record issued this very millisecond.
      next.expiresAt = Math.max(validExpiry(patch.expiresAt, now), next.issuedAt + 1);
    }
    if (patch.workspaceId !== undefined) {
      const workspaceId = validWorkspace(patch.workspaceId);
      if (workspaceId === undefined) delete next.workspaceId; else next.workspaceId = workspaceId;
    }
    if (patch.flowIds !== undefined) {
      const flowIds = validFlows(patch.flowIds);
      if (flowIds === undefined) delete next.flowIds; else next.flowIds = flowIds;
    }
    assertRules(next);
    assertWithinActor(actor, next);
    const updated: OwnerPolicy = { ...policy, credentials: policy.credentials.map(item => item.id === id ? next : item) };
    if (activeAdminCount(updated, now) === 0) {
      throw new AccessPeopleError('LAST_ADMIN', 'This is the last administrator. Add another one first, so nobody is locked out.', 409);
    }
    writePolicy(filename, updated);
    return viewOf(next, actor, now);
  });
}

export function revokePerson(actor: AccessActor, id: string, now = Date.now()): PersonView {
  const filename = policyFile();
  return withPolicyLock(filename, () => {
    const policy = requireNamedPolicy(filename);
    const current = policy.credentials.find(credential => credential.id === id);
    if (!current || (actor.workspaceId !== undefined && current.workspaceId !== actor.workspaceId)) {
      throw new AccessPeopleError('NOT_FOUND', 'That person was not found.', 404);
    }
    assertWithinActor(actor, current);
    if (current.revokedAt !== null) return viewOf(current, actor, now);
    const next: OwnerCredential = { ...current, revokedAt: now };
    const updated: OwnerPolicy = { ...policy, credentials: policy.credentials.map(item => item.id === id ? next : item) };
    if (activeAdminCount(updated, now) === 0) {
      throw new AccessPeopleError('LAST_ADMIN', 'This is the last administrator. Add another one first, so nobody is locked out.', 409);
    }
    writePolicy(filename, updated);
    return viewOf(next, actor, now);
  });
}

/**
 * Turns a schema 1 policy into schema 2. Existing administrators become the admin
 * role, keep their secret, and keep their browser sessions, so turning this on
 * cannot lock the owner out. Other existing credentials keep exactly their scopes.
 */
export function enableNamedAccess(now = Date.now()): { changed: boolean } {
  const filename = policyFile();
  return withPolicyLock(filename, () => {
    const policy = readOwnerPolicy(filename);
    if (policy.schemaVersion === 2) return { changed: false };
    let adminNumber = 0;
    const credentials = policy.credentials.map((credential): OwnerCredential => {
      if (!hasAdminPair(credential.scopes)) {
        return { ...credential, role: 'custom', name: `Credential ${credential.id.slice(0, 8)}` };
      }
      adminNumber += 1;
      return {
        ...credential, scopes: [...ACCESS_ROLE_SCOPES.admin], role: 'admin',
        name: adminNumber === 1 ? 'Owner' : `Owner ${adminNumber}`,
      };
    });
    const upgraded: OwnerPolicy = { ...policy, schemaVersion: 2, credentials };
    if (activeAdminCount(upgraded, now) === 0) {
      throw new AccessPeopleError('LAST_ADMIN', 'The policy has no active administrator, so turning this on would lock everyone out.', 409);
    }
    writePolicy(filename, upgraded);
    migrateSessions(filename, policy, upgraded);
    return { changed: true };
  });
}

/** Browser sessions are pinned to a revision whose meaning just changed; carry them across once. */
function migrateSessions(filename: string, before: OwnerPolicy, after: OwnerPolicy): void {
  const directory = `${filename}.sessions`;
  let files: string[];
  try { files = fs.readdirSync(directory); } catch { return; }
  const oldRevision = ownerPolicyRevision(before);
  for (const file of files.filter(item => item.endsWith('.json'))) {
    const full = path.join(directory, file);
    try {
      const record = JSON.parse(fs.readFileSync(full, 'utf8')) as { credentialId: string; policyRevision: string };
      if (record.policyRevision !== oldRevision) continue;
      const revision = ownerCredentialRevision(after, record.credentialId);
      if (!revision) continue;
      const staged = `${full}.${randomUUID()}.tmp`;
      fs.writeFileSync(staged, JSON.stringify({ ...record, policyRevision: revision }), { mode: 0o600, flag: 'wx' });
      replaceWithRetry(staged, full);
    } catch { /* A session that cannot be carried across simply asks to sign in again. */ }
  }
}

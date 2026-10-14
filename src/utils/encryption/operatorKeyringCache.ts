import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { assertCredentialMigrationReady } from './credentialMigrationState';
import { readVerifiedOperatorSecret } from './operatorSecret';
import { keyId, metadataRevision, unwrapKeyring, type EncryptionMetadata, type Keyring } from './format';

interface VerifiedOperatorKeyring {
  namespace: string;
  identity: string;
  ring: Readonly<Keyring>;
}
interface AccessCheck { namespace: string; invalidated: boolean }
interface OperatorKeyringState {
  version: 2;
  entries: Map<string, Readonly<VerifiedOperatorKeyring>>;
  checks: Set<AccessCheck>;
}
const MAX_VERIFIED_OPERATOR_KEYRINGS = 16;
declare global {
  // Bounded verified entries across route bundles; none authorizes an access alone.
  var __flujo_verified_operator_keyring: OperatorKeyringState | undefined;
}

export class OperatorKeyringContextChangedError extends Error {
  constructor() { super('Private encryption context changed; retry with the current profile'); }
}

function namespace(): string {
  return workspaceCacheKey(path.resolve(getWorkspaceDataDir()));
}

/** Revoke this namespace's result and already-running access checks. */
export function invalidateOperatorKeyring(): void {
  const state = global.__flujo_verified_operator_keyring;
  if (!state) return;
  if (state.version !== 2) {
    global.__flujo_verified_operator_keyring = undefined;
    for (const check of state.checks ?? []) check.invalidated = true;
    return;
  }
  let current: string;
  try { current = namespace(); }
  catch {
    state.entries.clear();
    for (const check of state.checks ?? []) check.invalidated = true;
    return;
  }
  state.entries.delete(current);
  for (const check of state.checks ?? []) {
    if (check.namespace === current) check.invalidated = true;
  }
}

type ReadMetadata = () => Promise<EncryptionMetadata | null>;

async function currentIdentity(readMetadata: ReadMetadata) {
  await assertCredentialMigrationReady();
  const metadata = await readMetadata();
  if (!metadata || metadata.encryption_version !== 2 || metadata.encryption_type !== 'user'
      || metadata.key_protection !== 'operator-file') throw new OperatorKeyringContextChangedError();
  const namedRoot = path.resolve(getWorkspaceDataDir());
  const canonicalRoot = await fs.realpath(namedRoot);
  const root = await fs.stat(namedRoot, { bigint: true });
  if (!root.isDirectory()) throw new OperatorKeyringContextChangedError();
  const mount = readVerifiedOperatorSecret();
  if (!mount) throw new OperatorKeyringContextChangedError();
  const scope = workspaceCacheKey(path.resolve(getDataDir()), namedRoot, canonicalRoot,
    root.dev.toString(), root.ino.toString(), String(isWorkerMode()));
  const revision = metadataRevision(metadata); // Entire record, including unknown fields.
  const secretDigest = createHash('sha256').update(mount.secret).digest('hex');
  return { metadata, secret: mount.secret, revision,
    identity: JSON.stringify([scope, revision, mount.identity, secretDigest]) };
}

/** Reuse only a completed authenticated unwrap of these exact current inputs.
 * Every call still rereads the metadata/migration state and protected mount.
 * No password, browser flag, server-unlocked state or elapsed time grants access.
 */
export async function verifiedOperatorKeyring(expected: EncryptionMetadata, readMetadata: ReadMetadata): Promise<Keyring> {
  let state = global.__flujo_verified_operator_keyring;
  if (state?.version !== 2) {
    for (const previous of state?.checks ?? []) previous.invalidated = true;
    global.__flujo_verified_operator_keyring = state = { version: 2, entries: new Map(), checks: new Set() };
  }
  const check = { namespace: namespace(), invalidated: false };
  state.checks.add(check);
  try {
    const before = await currentIdentity(readMetadata);
    if (before.revision !== metadataRevision(expected) || global.__flujo_verified_operator_keyring !== state
        || check.invalidated || check.namespace !== namespace()) {
      throw new OperatorKeyringContextChangedError();
    }
    const cached = state.entries.get(check.namespace);
    if (cached?.namespace === check.namespace && cached.identity === before.identity
        && keyId(cached.ring) === before.metadata.key_id) {
      state.entries.delete(check.namespace);
      state.entries.set(check.namespace, cached);
      return { ...cached.ring };
    }
    // Derive at the unchanged canonical KDF cost; no pending or unverified entry.
    const ring = await unwrapKeyring(before.metadata, before.secret);
    const after = await currentIdentity(readMetadata);
    if (after.identity !== before.identity || global.__flujo_verified_operator_keyring !== state
        || check.invalidated || check.namespace !== namespace()) {
      throw new OperatorKeyringContextChangedError();
    }
    state.entries.delete(check.namespace);
    state.entries.set(check.namespace, Object.freeze({ namespace: check.namespace, identity: after.identity, ring: Object.freeze({ ...ring }) }));
    while (state.entries.size > MAX_VERIFIED_OPERATOR_KEYRINGS) {
      const oldest = state.entries.keys().next();
      if (oldest.done) { state.entries.clear(); break; }
      state.entries.delete(oldest.value);
    }
    return { ...ring };
  } catch (error) {
    state.entries.delete(check.namespace);
    for (const active of state.checks) {
      if (active.namespace === check.namespace) active.invalidated = true;
    }
    throw error;
  } finally {
    state.checks.delete(check);
  }
}

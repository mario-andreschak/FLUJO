import { createHash } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { WorkspaceRecoveryMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { getDataDir } from '@/utils/paths';
import { readStableFile } from '@/utils/readStableFile';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  assertCredentialRecoveryIdentity, CREDENTIAL_RECOVERY_FILES, CREDENTIAL_RECOVERY_FILE_LIMIT,
  CREDENTIAL_RECOVERY_MANIFEST_LIMIT, CredentialRecoveryFormatError,
  decryptCredentialRecoveryObject, encryptCredentialRecoveryObject, type CredentialRecoveryFile,
} from './credentialRecoveryFormat';
import {
  decryptCredentialRecoveryManifest, encryptCredentialRecoveryManifest, parseCredentialRecoveryManifest,
  type CredentialRecoveryManifest, type CredentialRecoveryWitness,
} from './credentialRecoveryManifest';

export type CredentialRecoveryImage = Record<CredentialRecoveryFile, Buffer | null>;
export interface CredentialRecoveryBackup {
  manifest: CredentialRecoveryManifest;
  /** Owned plaintext buffers. Clear these after inspection or recovery. */
  before: CredentialRecoveryImage;
  after: CredentialRecoveryImage;
}
interface Directory { file: string; stat: BigIntStats; parent?: Directory }
const BACKUP_DIRECTORY = '.credential-recovery';
const MANIFEST_NAME = 'manifest.json';
const wireLimit = (limit: number) => 4 * Math.ceil(limit / 3) + 4096;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const emptyImage = (): CredentialRecoveryImage => Object.fromEntries(CREDENTIAL_RECOVERY_FILES.map(file => [file, null])) as CredentialRecoveryImage;

export class CredentialRecoveryBackupError extends Error {
  readonly code = 'RECOVERY_BACKUP';
  constructor() {
    super('Credential recovery backup is unavailable or changed; retain all original files and recovery objects before retrying.');
    this.name = 'CredentialRecoveryBackupError';
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink;
}
function owned(stat: Readonly<BigIntStats>): boolean {
  return stat.nlink === BigInt(1) && (!process.getuid || stat.uid === BigInt(process.getuid()));
}
function privateMode(stat: Readonly<BigIntStats>, directory: boolean): boolean {
  return (!process.getuid || stat.uid === BigInt(process.getuid()))
    && (process.platform === 'win32' || ((stat.mode & BigInt(0o077)) === BigInt(0)
      && (!directory || (stat.mode & BigInt(0o700)) === BigInt(0o700))));
}
async function checkedDirectory(file: string, parent?: Directory, privateDirectory = false): Promise<Directory> {
  if (parent) await assertDirectory(parent);
  const stat = await fs.lstat(file, { bigint: true });
  const canonical = await fs.realpath(file);
  const after = await fs.lstat(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, after)
      || (parent && path.dirname(canonical) !== parent.file)
      || (privateDirectory && !privateMode(stat, true))) throw new CredentialRecoveryBackupError();
  // Preserve native canonical spelling, including the Windows drive letter.
  return { file: canonical, stat, parent };
}
async function assertDirectory(directory: Directory): Promise<void> {
  if (directory.parent) await assertDirectory(directory.parent);
  const current = await fs.lstat(directory.file, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.stat.dev
      || current.ino !== directory.stat.ino || current.mode !== directory.stat.mode
      || current.uid !== directory.stat.uid || current.gid !== directory.stat.gid
      || await fs.realpath(directory.file) !== directory.file) throw new CredentialRecoveryBackupError();
}
async function assertOperation(operation: WorkspaceRecoveryMutation, transactionId: string): Promise<void> {
  assertCredentialRecoveryIdentity({ workspace: operation.workspace, transactionId, role: 'manifest' });
  if (getCurrentWorkspace() !== operation.workspace) throw new CredentialRecoveryBackupError();
  await operation.assertOwned();
  if (getCurrentWorkspace() !== operation.workspace) throw new CredentialRecoveryBackupError();
}
async function directories(operation: WorkspaceRecoveryMutation): Promise<{ workspace: Directory; db: Directory }> {
  const root = await checkedDirectory(path.resolve(getDataDir()));
  const workspaces = await checkedDirectory(path.join(root.file, 'workspaces'), root);
  const workspace = await checkedDirectory(path.join(workspaces.file, operation.workspace), workspaces);
  const db = await checkedDirectory(path.join(workspace.file, 'db'), workspace);
  return { workspace, db };
}
async function syncDirectory(directory: Directory): Promise<void> {
  await assertDirectory(directory);
  // Windows Node does not expose directory fsync. File sync/readback still
  // applies there; power-loss durability and ACL protection need installed proof.
  if (process.platform === 'win32') return;
  const named = await fs.lstat(directory.file, { bigint: true });
  const handle = await fs.open(directory.file, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameFile(named, opened)) throw new CredentialRecoveryBackupError();
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fs.lstat(directory.file, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, namedAfter) || namedAfter.isSymbolicLink()) throw new CredentialRecoveryBackupError();
  } finally { await handle.close(); }
  await assertDirectory(directory);
}
async function createDirectory(parent: Directory, name: string, exclusive: boolean): Promise<Directory> {
  await assertDirectory(parent);
  const file = path.join(parent.file, name);
  try { await fs.mkdir(file, { mode: 0o700 }); }
  catch (error) {
    if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const result = await checkedDirectory(file, parent, true);
  await syncDirectory(parent);
  return result;
}
async function writeImmutable(
  directory: Directory, name: string, wire: Buffer, operation: WorkspaceRecoveryMutation, transactionId: string,
): Promise<void> {
  await assertOperation(operation, transactionId);
  await assertDirectory(directory);
  const file = path.join(directory.file, name);
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !owned(opened) || !privateMode(opened, false)) throw new CredentialRecoveryBackupError();
    await handle.writeFile(wire);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (!after.isFile() || !owned(after) || !privateMode(after, false)
        || after.dev !== opened.dev || after.ino !== opened.ino || after.mode !== opened.mode
        || after.uid !== opened.uid || after.gid !== opened.gid || after.size !== BigInt(wire.length)
        || !sameFile(after, named) || named.isSymbolicLink()) throw new CredentialRecoveryBackupError();
    await assertDirectory(directory);
    await assertOperation(operation, transactionId);
  } finally { await handle.close(); }
  await syncDirectory(directory);
}
async function readObject(directory: Directory, name: string, limit: number): Promise<Buffer> {
  await assertDirectory(directory);
  const bytes = await readStableFile(path.join(directory.file, name), limit, {
    validateOpenedFile: (stat, canonical) => owned(stat) && privateMode(stat, false) && path.dirname(canonical) === directory.file,
  });
  await assertDirectory(directory);
  return bytes;
}
async function readOriginal(db: Directory, file: CredentialRecoveryFile): Promise<Buffer | null> {
  await assertDirectory(db);
  const target = path.join(db.file, file);
  try { await fs.lstat(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const bytes = await readStableFile(target, CREDENTIAL_RECOVERY_FILE_LIMIT, {
    validateOpenedFile: (stat, canonical) => owned(stat) && path.dirname(canonical) === db.file,
  });
  try {
    await assertDirectory(db);
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}
function witness(bytes: Buffer | null): CredentialRecoveryWitness | null {
  return bytes === null ? null : { size: bytes.length, sha256: sha256(bytes) };
}
function matches(bytes: Buffer | null, expected: CredentialRecoveryWitness | null): boolean {
  return bytes === null ? expected === null : expected !== null && bytes.length === expected.size && sha256(bytes) === expected.sha256;
}
function copyImage(value: CredentialRecoveryImage): CredentialRecoveryImage {
  const image = emptyImage();
  try {
    if (!value || typeof value !== 'object' || Object.keys(value).length !== CREDENTIAL_RECOVERY_FILES.length) throw new CredentialRecoveryBackupError();
    for (const file of CREDENTIAL_RECOVERY_FILES) {
      if (!Object.hasOwn(value, file) || (value[file] !== null && !Buffer.isBuffer(value[file]))) throw new CredentialRecoveryBackupError();
      if (value[file] && value[file]!.length > CREDENTIAL_RECOVERY_FILE_LIMIT) throw new CredentialRecoveryFormatError('RECOVERY_SIZE');
      image[file] = value[file] === null ? null : Buffer.from(value[file]!);
    }
    return image;
  } catch (error) { clearCredentialRecoveryImage(image); throw error; }
}
function copyKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new CredentialRecoveryFormatError('RECOVERY_INPUT');
  return Buffer.from(key);
}
export function clearCredentialRecoveryImage(image: CredentialRecoveryImage): void {
  for (const file of CREDENTIAL_RECOVERY_FILES) image[file]?.fill(0);
}

/**
 * Persist/read back encrypted immutable core before/after objects under the
 * existing exclusive lease. Never modify active credential files or erase a
 * partial backup. The trusted caller still owes conversion and key-ID proof.
 */
export async function createCredentialRecoveryBackup(
  operation: WorkspaceRecoveryMutation,
  intent: { transactionId: string; sourceKeyId: string | null; targetKeyId: string; after: CredentialRecoveryImage },
  recoveryKey: Buffer,
): Promise<CredentialRecoveryManifest> {
  // Capture caller-owned inputs before the first await; asynchronous mutation
  // cannot replace the staged bytes or retained key mid-operation.
  const key = copyKey(recoveryKey);
  let after: CredentialRecoveryImage | undefined;
  const before = emptyImage();
  try {
    if (!intent || typeof intent !== 'object') throw new CredentialRecoveryBackupError();
    const transactionId = intent.transactionId;
    const sourceKeyId = intent.sourceKeyId;
    const targetKeyId = intent.targetKeyId;
    after = copyImage(intent.after);
    await assertOperation(operation, transactionId);
    const { workspace, db } = await directories(operation);
    for (const file of CREDENTIAL_RECOVERY_FILES) {
      await assertOperation(operation, transactionId);
      before[file] = await readOriginal(db, file);
    }
    const manifest = parseCredentialRecoveryManifest({ format: 'flujo-credential-recovery-manifest', version: 1,
      workspace: operation.workspace, transactionId, sourceKeyId, targetKeyId, phase: 'prepared',
      entries: CREDENTIAL_RECOVERY_FILES.map(file => ({ file, before: witness(before[file]), after: witness(after![file]) })),
    }, { workspace: operation.workspace, transactionId });
    const vault = await createDirectory(workspace, BACKUP_DIRECTORY, false);
    await assertOperation(operation, transactionId);
    const transaction = await createDirectory(vault, transactionId, true);
    for (const role of ['before', 'after'] as const) {
      const image = role === 'before' ? before : after;
      for (const file of CREDENTIAL_RECOVERY_FILES) {
        if (image[file] === null) continue;
        const wire = encryptCredentialRecoveryObject(image[file]!, key, { workspace: operation.workspace, transactionId, role, file });
        await writeImmutable(transaction, `${role}-${file}`, wire, operation, transactionId);
      }
    }
    // Publishing the encrypted manifest last identifies a complete candidate,
    // but acknowledgement additionally requires authenticated full readback.
    await writeImmutable(transaction, MANIFEST_NAME, encryptCredentialRecoveryManifest(manifest, key), operation, transactionId);
    const verified = await readCredentialRecoveryBackup(operation, transactionId, key);
    try {
      if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new CredentialRecoveryBackupError();
      for (const entry of manifest.entries) {
        const current = await readOriginal(db, entry.file);
        try { if (!matches(current, entry.before)) throw new CredentialRecoveryBackupError(); }
        finally { current?.fill(0); }
      }
    } finally {
      clearCredentialRecoveryImage(verified.before);
      clearCredentialRecoveryImage(verified.after);
    }
    await assertOperation(operation, transactionId);
    return manifest;
  } catch (error) {
    if (error instanceof CredentialRecoveryFormatError) throw error;
    throw new CredentialRecoveryBackupError();
  } finally {
    key.fill(0);
    clearCredentialRecoveryImage(before);
    if (after) clearCredentialRecoveryImage(after);
  }
}

/** Explicit authenticated inspection only; never auto-resume or delete objects. */
export async function readCredentialRecoveryBackup(
  operation: WorkspaceRecoveryMutation, transactionId: string, recoveryKey: Buffer,
): Promise<CredentialRecoveryBackup> {
  const key = copyKey(recoveryKey);
  const before = emptyImage();
  const after = emptyImage();
  try {
    await assertOperation(operation, transactionId);
    const { workspace } = await directories(operation);
    const vault = await checkedDirectory(path.join(workspace.file, BACKUP_DIRECTORY), workspace, true);
    const transaction = await checkedDirectory(path.join(vault.file, transactionId), vault, true);
    const wire = await readObject(transaction, MANIFEST_NAME, wireLimit(CREDENTIAL_RECOVERY_MANIFEST_LIMIT));
    const manifest = decryptCredentialRecoveryManifest(wire, key, { workspace: operation.workspace, transactionId });
    const expectedNames = [MANIFEST_NAME];
    for (const entry of manifest.entries) {
      for (const role of ['before', 'after'] as const) {
        const expected = entry[role];
        if (expected === null) continue;
        await assertOperation(operation, transactionId);
        const name = `${role}-${entry.file}`;
        expectedNames.push(name);
        const bytes = decryptCredentialRecoveryObject(await readObject(transaction, name, wireLimit(CREDENTIAL_RECOVERY_FILE_LIMIT)),
          key, { workspace: operation.workspace, transactionId, role, file: entry.file });
        (role === 'before' ? before : after)[entry.file] = bytes;
        if (!matches(bytes, expected)) throw new CredentialRecoveryBackupError();
      }
    }
    // An extra object for a claimed absence or unknown store is ambiguous,
    // never silently accepted or removed by recovery inspection.
    await assertDirectory(transaction);
    const names = await fs.readdir(transaction.file);
    if (names.length !== expectedNames.length || expectedNames.some(name => !names.includes(name))) throw new CredentialRecoveryBackupError();
    await assertDirectory(transaction);
    await assertOperation(operation, transactionId);
    return { manifest, before, after };
  } catch (error) {
    clearCredentialRecoveryImage(before);
    clearCredentialRecoveryImage(after);
    if (error instanceof CredentialRecoveryFormatError) throw error;
    throw new CredentialRecoveryBackupError();
  } finally { key.fill(0); }
}

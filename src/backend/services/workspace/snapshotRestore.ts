import { promises as fs } from 'node:fs';
import { readPlainFile } from '@/utils/readPlainFile';
import { createHash } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import applicationPackage from '../../../../package.json';
import { getDataDir } from '@/utils/paths';
import { unlockServer } from '@/utils/encryption/session';
import { isValidEncryptionSessionKey } from '@/utils/encryption/format';
import {
  assertValidWorkspaceName, getWorkspaceDir, getWorkspacesDir, WORKSPACE_SUBTREES,
  getCurrentWorkspace,
} from '@/utils/workspace';
import type { WorkspaceMcpTransferPlan } from '@/backend/services/packages/workspaceMcpTransfer';
import { isChatGptAuthCache } from '@/backend/services/model/adapters/codexAuth';
import { atomicWriteWithoutLinks, assertLinkFreeFileParent } from './backupRestoreFs';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { WORKER_SNAPSHOT_FORMAT_VERSION } from './workerCompatibility';
import { isWorkerMode, setWorkerBootstrapStatus } from './workerMode';
import { decryptSnapshotEnvelope } from './snapshotEnvelope';

const MANIFEST_PATH = 'snapshot-manifest.json';
const RESTORE_MARKER = '.flujo-worker-snapshot.json';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MEMBERS = 100_000;
const SHA256 = /^[a-f0-9]{64}$/;

export interface WorkerSnapshotRestoreResult {
  workspace: string;
  archiveSha256: string;
  mcpTransfer: WorkspaceMcpTransferPlan;
  codexAuth: 'chatgpt' | 'none';
  encryption: 'default' | 'user';
}

interface WorkerManifest {
  formatVersion: 2;
  layoutVersion: number;
  workspace: string;
  externalRootsIncluded: false;
  source: { version: string; platform: string };
  subtrees: string[];
  files: Array<{ path: string; size: number; sha256: string }>;
  runtime: { mcpTransfer: WorkspaceMcpTransferPlan; codexAuth: 'chatgpt' | 'none'; encryption: 'default' | 'user' };
}

declare global {
  var __flujo_worker_snapshot_restore:
    { key: string; promise: Promise<WorkerSnapshotRestoreResult> } | undefined;
}

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(content: string, message: string): unknown {
  try { return JSON.parse(content); }
  catch { throw new Error(message); }
}

function safeMember(name: string, directory = false): string {
  const normalized = directory ? name.replace(/\/$/, '') : name;
  const parts = normalized.split('/');
  if (!normalized || normalized.includes('\\') || normalized.includes('\0')
      || parts.some(part => !part || part === '.' || part === '..' || part.includes(':')
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Snapshot contains an unsafe archive path.');
  }
  if (normalized !== MANIFEST_PATH && normalized !== '.workspace.json'
      && !(WORKSPACE_SUBTREES as readonly string[]).includes(parts[0])) {
    throw new Error('Snapshot contains a file outside the supported workspace roots.');
  }
  if (directory && (normalized === MANIFEST_PATH || normalized === '.workspace.json')) {
    throw new Error('Snapshot metadata must be a file.');
  }
  if (!directory && (WORKSPACE_SUBTREES as readonly string[]).includes(normalized)) {
    throw new Error('Snapshot workspace roots must be directories.');
  }
  return normalized;
}

interface ZipMember { name: string; directory: boolean; size: number; mode: number }

/** Inspect ZIP32's central directory before JSZip normalizes paths or merges duplicates. */
function inspectArchive(bytes: Buffer, maxFileBytes: number, maxBytes: number): ZipMember[] {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid snapshot ZIP directory.');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
      || bytes.readUInt16LE(end + 8) !== count || count === 0xffff
      || count > MAX_MEMBERS || offset + directorySize !== end) {
    throw new Error('Unsupported snapshot ZIP structure.');
  }
  const names = new Map<string, boolean>();
  const members: ZipMember[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid snapshot ZIP member.');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || ![0, 8].includes(method) || next > end
        || bytes.readUInt32LE(offset + 20) === 0xffffffff || size === 0xffffffff) {
      throw new Error('Unsupported snapshot ZIP member encoding.');
    }
    const name = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const directory = name.endsWith('/');
    const safeName = safeMember(name, directory);
    const key = safeName.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('Snapshot contains duplicate or case-aliased archive paths.');
    names.set(key, directory);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const fileType = mode & 0o170000;
    if (fileType !== 0 && fileType !== (directory ? 0o040000 : 0o100000)) {
      throw new Error('Snapshot links and special files are unsupported.');
    }
    const memberLimit = name === MANIFEST_PATH ? MAX_MANIFEST_BYTES : maxFileBytes;
    if (size > memberLimit || (directory && size !== 0)) throw new Error('Snapshot file exceeds the restore size limit.');
    total += size;
    if (total > maxBytes + MAX_MANIFEST_BYTES) throw new Error('Snapshot exceeds the restore size limit.');
    members.push({ name, directory, size, mode });
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid snapshot ZIP directory length.');
  for (const { name, directory } of members) {
    const parts = safeMember(name, directory).split('/');
    for (let length = 1; length < parts.length; length++) {
      if (names.get(parts.slice(0, length).join('/').normalize('NFC').toLowerCase()) === false) {
        throw new Error('Snapshot contains a file/directory path conflict.');
      }
    }
  }
  return members;
}

function validateManifest(value: unknown): WorkerManifest {
  if (!record(value) || value.formatVersion !== WORKER_SNAPSHOT_FORMAT_VERSION || value.layoutVersion !== WORKSPACE_LAYOUT_VERSION
      || value.externalRootsIncluded !== false || !record(value.source)
      || value.source.version !== applicationPackage.version || typeof value.source.platform !== 'string'
      || !record(value.runtime) || !record(value.runtime.mcpTransfer)
      || value.runtime.mcpTransfer.formatVersion !== 1
      || typeof value.runtime.mcpTransfer.sourceWorkspaceRoot !== 'string'
      || !Array.isArray(value.runtime.mcpTransfer.servers)
      || !['chatgpt', 'none'].includes(value.runtime.codexAuth as string)
      || !['default', 'user'].includes(value.runtime.encryption as string)
      || !Array.isArray(value.files) || !Array.isArray(value.subtrees)
      || value.subtrees.length !== WORKSPACE_SUBTREES.length
      || WORKSPACE_SUBTREES.some(root => !(value.subtrees as unknown[]).includes(root))) {
    throw new Error('Snapshot format, FLUJO version, layout, or portable runtime metadata is incompatible.');
  }
  assertValidWorkspaceName(value.workspace);
  return value as unknown as WorkerManifest;
}

async function plainDirectory(target: string, create = false): Promise<void> {
  if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Worker restore destination must be a plain directory.');
}

async function optionalStat(target: string) {
  try { return await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Only the image's pre-created, empty subtree skeleton may be replaced. */
async function removeEmptySkeleton(target: string): Promise<void> {
  await plainDirectory(target);
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (!(WORKSPACE_SUBTREES as readonly string[]).includes(entry.name)
        || !entry.isDirectory() || entry.isSymbolicLink()
        || (await fs.readdir(path.join(target, entry.name))).length !== 0) {
      throw new Error('Worker snapshot restore refuses to overwrite an existing workspace.');
    }
  }
  for (const entry of entries) await fs.rmdir(path.join(target, entry.name));
  await fs.rmdir(target);
}

export async function verifyWorkerCodexAuth(
  result: WorkerSnapshotRestoreResult, workspaceRoot = getWorkspaceDir(result.workspace),
): Promise<void> {
  if (result.codexAuth !== 'chatgpt') return;
  const root = path.join(workspaceRoot, 'db', 'codex-runtime');
  const credentials: Buffer[] = [];
  for (const file of ['auth.json', 'flujo-auth-source.json']) {
    const stat = await fs.lstat(path.join(root, file), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > BigInt(1) || stat.size > BigInt(1024 * 1024)) {
      throw new Error('Worker Codex authentication is not a valid workspace credential file.');
    }
    const credentialPath = path.join(root, file);
    credentials.push(await readPlainFile(credentialPath, {
      expected: stat, maxBytes: 1024 * 1024,
      verifyPath: () => assertLinkFreeFileParent(workspaceRoot, credentialPath),
    }));
  }
  const [auth, markerBytes] = credentials;
  const marker = parseJson(markerBytes.toString('utf8'), 'Worker Codex authentication marker is invalid.');
  if (!isChatGptAuthCache(auth) || !record(marker) || marker.version !== 1 || marker.source !== 'workspace') {
    throw new Error('Worker Codex ChatGPT authentication is missing or invalid.');
  }
}

async function readWorkerUnlockKey(result: WorkerSnapshotRestoreResult, root = getWorkspaceDir(result.workspace)): Promise<string | null> {
  if (result.encryption !== 'user') return null;
  const keyPath = path.join(root, 'db', 'worker-bootstrap-secrets.json');
  const stat = await fs.lstat(keyPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > BigInt(1) || stat.size > BigInt(4096)) {
    throw new Error('Worker workspace encryption requires valid bootstrap credentials.');
  }
  if (process.platform !== 'win32' && (stat.mode & BigInt(0o077)) !== BigInt(0)) {
    throw new Error('Worker workspace encryption credentials must be owner-only.');
  }
  const value = parseJson((await readPlainFile(keyPath, {
    expected: stat, maxBytes: 4096, ownerOnly: true,
    verifyPath: () => assertLinkFreeFileParent(root, keyPath),
  })).toString('utf8'), 'Worker workspace encryption bootstrap credentials are invalid.');
  // Validate v2 keyrings and the effective v1 AES key with the crypto module's
  // shared parser. Never truncate keys to the old random-byte count.
  if (!record(value) || value.version !== 1 || typeof value.workspaceDek !== 'string'
      || !isValidEncryptionSessionKey(value.workspaceDek)) {
    throw new Error('Worker workspace encryption bootstrap credentials are invalid.');
  }
  return value.workspaceDek;
}

/** Called only in the selected worker workspace's AsyncLocalStorage context. */
export async function unlockWorkerSnapshot(result: WorkerSnapshotRestoreResult): Promise<void> {
  if (getCurrentWorkspace() !== result.workspace) throw new Error('Worker encryption unlock workspace mismatch.');
  const key = await readWorkerUnlockKey(result);
  if (key) unlockServer(key);
}

async function restoreArchive(archivePath: string, digest: string): Promise<WorkerSnapshotRestoreResult> {
  setWorkerBootstrapStatus({ state: 'restoring', archiveSha256: digest, error: undefined });
  const maxFileBytes = limit('FLUJO_SNAPSHOT_MAX_FILE_BYTES', 256 * 1024 * 1024);
  const maxBytes = limit('FLUJO_SNAPSHOT_MAX_BYTES', 1024 * 1024 * 1024);
  const encrypted = Boolean(process.env.FLUJO_WORKER_SNAPSHOT_KEY);
  const maxArchiveBytes = maxBytes + MAX_MANIFEST_BYTES;
  const maxInputBytes = encrypted ? Math.ceil(maxArchiveBytes * 4 / 3) + 4096 : maxArchiveBytes;
  const stat = await fs.lstat(archivePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxInputBytes)) {
    throw new Error('Worker snapshot must be an ordinary archive file within the size limit.');
  }
  let bytes = await readPlainFile(archivePath, { expected: stat, maxBytes: maxInputBytes });
  if (bytes.length > maxInputBytes) throw new Error('Worker snapshot exceeds the size limit.');
  const inputDigest = createHash('sha256').update(bytes).digest('hex');
  let envelopeVersion: 1 | 2 | undefined;
  if (encrypted || bytes[0] === 0x7b) {
    const decrypted = decryptSnapshotEnvelope(bytes, process.env.FLUJO_WORKER_SNAPSHOT_KEY, maxArchiveBytes);
    bytes = decrypted.bytes;
    envelopeVersion = decrypted.version;
  }
  // New reports bind the encrypted wire bytes. Legacy v1 bridge archives used
  // the plaintext ZIP digest, which remains a read-only compatibility contract.
  const actualDigest = envelopeVersion === 2 ? inputDigest : createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== digest) throw new Error('Worker snapshot SHA-256 mismatch.');
  const members = inspectArchive(bytes, maxFileBytes, maxBytes);
  const zip = await JSZip.loadAsync(bytes);
  const manifestEntry = zip.file(MANIFEST_PATH);
  if (!manifestEntry) throw new Error('Worker snapshot manifest is missing.');
  const manifest = validateManifest(parseJson(await manifestEntry.async('string'), 'Worker snapshot manifest is invalid JSON.'));
  const result: WorkerSnapshotRestoreResult = {
    workspace: manifest.workspace, archiveSha256: digest,
    mcpTransfer: manifest.runtime.mcpTransfer, codexAuth: manifest.runtime.codexAuth,
    encryption: manifest.runtime.encryption,
  };
  setWorkerBootstrapStatus({ workspace: result.workspace });
  const expected = new Map<string, { size: number; sha256: string }>();
  let total = 0;
  for (const member of manifest.files) {
    if (!record(member) || typeof member.path !== 'string' || member.path === MANIFEST_PATH
        || !Number.isSafeInteger(member.size) || member.size < 0 || member.size > maxFileBytes
        || typeof member.sha256 !== 'string' || !SHA256.test(member.sha256)) {
      throw new Error('Invalid snapshot manifest member.');
    }
    safeMember(member.path);
    if (expected.has(member.path)) throw new Error('Snapshot manifest has duplicate members.');
    total += member.size;
    if (total > maxBytes) throw new Error('Snapshot manifest exceeds the restore size limit.');
    expected.set(member.path, member);
  }
  const files: Array<{ name: string; content: Buffer; mode: number }> = [];
  for (const member of members) {
    if (member.directory || member.name === MANIFEST_PATH) continue;
    const declared = expected.get(member.name);
    if (!declared || declared.size !== member.size) throw new Error('Snapshot archive does not match its manifest.');
    const content = await zip.file(member.name)!.async('nodebuffer');
    if (content.length !== declared.size || createHash('sha256').update(content).digest('hex') !== declared.sha256) {
      throw new Error('Snapshot member integrity check failed.');
    }
    expected.delete(member.name);
    files.push({ name: member.name, content, mode: member.mode & 0o111 ? 0o700 : 0o600 });
  }
  if (expected.size) throw new Error('Snapshot archive is missing a manifest member.');

  // The complete archive is validated before any workspace is modified.
  await plainDirectory(getDataDir(), true);
  await plainDirectory(getWorkspacesDir(), true);
  const target = getWorkspaceDir(result.workspace);
  const aliases = (await fs.readdir(getWorkspacesDir())).filter(name => name.toLowerCase() === result.workspace.toLowerCase());
  if (aliases.some(name => name !== result.workspace)) throw new Error('Worker workspace has a case-alias conflict.');
  const existing = await optionalStat(target);
  if (existing) {
    await plainDirectory(target);
    const markerPath = path.join(target, RESTORE_MARKER);
    if (await optionalStat(markerPath)) {
      const markerStat = await fs.lstat(markerPath, { bigint: true });
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > BigInt(1) || markerStat.size > BigInt(4096)) {
        throw new Error('Invalid worker restore marker.');
      }
      const marker = parseJson((await readPlainFile(markerPath, {
        expected: markerStat, maxBytes: 4096,
        verifyPath: () => assertLinkFreeFileParent(target, markerPath),
      })).toString('utf8'), 'Worker restore marker is invalid.');
      if (!record(marker) || marker.formatVersion !== 1 || marker.archiveSha256 !== digest
          || marker.workspace !== result.workspace) throw new Error('Worker snapshot does not match the existing workspace.');
      await verifyWorkerCodexAuth(result);
      await readWorkerUnlockKey(result);
      return result;
    }
  }
  const staging = await fs.mkdtemp(path.join(getWorkspacesDir(), '.worker-restore-'));
  let published = false;
  try {
    await fs.chmod(staging, 0o700);
    for (const subtree of WORKSPACE_SUBTREES) await fs.mkdir(path.join(staging, subtree), { mode: 0o700 });
    for (const member of members.filter(entry => entry.directory)) {
      // Paths and entry types were validated above, and this private staging
      // tree contains no archive-created links. Preserve empty directories too.
      await fs.mkdir(path.join(staging, ...safeMember(member.name, true).split('/')), { recursive: true, mode: 0o700 });
    }
    for (const file of files) {
      // Host external roots are not part of the snapshot and cannot be inherited.
      const content = file.name === '.workspace.json' ? Buffer.from('{"roots":[]}\n') : file.content;
      await atomicWriteWithoutLinks(staging, path.join(staging, ...file.name.split('/')), content, { mode: file.mode });
    }
    await verifyWorkerCodexAuth(result, staging);
    await readWorkerUnlockKey(result, staging);
    await atomicWriteWithoutLinks(staging, path.join(staging, RESTORE_MARKER), Buffer.from(JSON.stringify({
      formatVersion: 1, workspace: result.workspace, archiveSha256: digest,
    })));
    if (existing) await removeEmptySkeleton(target);
    else if (await optionalStat(target)) throw new Error('Worker restore destination was created concurrently.');
    await fs.rename(staging, target);
    published = true;
    await verifyWorkerCodexAuth(result);
    return result;
  } finally {
    // This path was allocated by this invocation and never contains an existing workspace.
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Runs inside the installation layout barrier, before any workspace service starts. */
export function restoreConfiguredWorkerSnapshot(): Promise<WorkerSnapshotRestoreResult | null> {
  if (!isWorkerMode()) return Promise.resolve(null);
  const archivePath = process.env.FLUJO_WORKER_SNAPSHOT?.trim();
  const digest = process.env.FLUJO_WORKER_SNAPSHOT_SHA256?.trim().toLowerCase();
  if (!archivePath || !digest || !SHA256.test(digest) || !path.isAbsolute(archivePath)) {
    const message = 'Worker mode requires an absolute FLUJO_WORKER_SNAPSHOT path and FLUJO_WORKER_SNAPSHOT_SHA256.';
    setWorkerBootstrapStatus({ state: 'error', error: message });
    return Promise.reject(new Error(message));
  }
  const keyFingerprint = createHash('sha256').update(process.env.FLUJO_WORKER_SNAPSHOT_KEY ?? '').digest('hex');
  const key = `${getWorkspacesDir()}\0${archivePath}\0${digest}\0${keyFingerprint}`;
  if (global.__flujo_worker_snapshot_restore?.key === key) return global.__flujo_worker_snapshot_restore.promise;
  const promise = restoreArchive(archivePath, digest).catch(error => {
    setWorkerBootstrapStatus({ state: 'error', error: error instanceof Error ? error.message : 'Worker restore failed.' });
    if (global.__flujo_worker_snapshot_restore?.promise === promise) global.__flujo_worker_snapshot_restore = undefined;
    throw error;
  });
  global.__flujo_worker_snapshot_restore = { key, promise };
  return promise;
}

import { promises as fs, type Stats, type BigIntStats } from 'node:fs';
import { readPlainFile, PlainFileReadError } from '@/utils/readPlainFile';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { getSnapshotLimits } from './snapshotTransfer';
import { SnapshotInput } from './snapshotInput';
import { writeSnapshotStream } from './snapshotStreaming';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { WORKSPACE_SUBTREES, runWithWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { WORKER_SNAPSHOT_FORMAT_VERSION } from './workerCompatibility';
import { addFolderToZipLinkSafe, assertLinkFreeFileParent } from './backupRestoreFs';
import { buildWorkspaceMcpTransferPlan, pinWorkspaceMcpTransferPlan, selectWorkspaceFlowDependencies, type WorkspaceMcpTransferPlan } from '@/backend/services/packages/workspaceMcpTransfer';
import { isCredentialMigrationPending } from '@/utils/encryption/credentialMigrationState';
import { getOperatorWorkerBootstrapKey } from '@/utils/encryption/secure';
import type { EncryptionMetadata } from '@/utils/encryption/format';
import { CODEX_AUTH_SOURCE_FILE, WORKSPACE_CODEX_AUTH_SOURCE, readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { CREDENTIAL_TRANSFER_STORES, transformCredentialValues } from './credentialTransfer';
import { StorageKey } from '@/shared/types/storage';
import { getServerDek } from '@/utils/encryption/session';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Model } from '@/shared/types/model';
import type { Flow } from '@/shared/types/flow';
import appPackage from '../../../../package.json';

const WORKSPACE_METADATA_FILE = '.workspace.json';

export interface SnapshotManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode?: number;
}

export interface WorkspaceSnapshotManifest {
  formatVersion: typeof WORKER_SNAPSHOT_FORMAT_VERSION;
  layoutVersion: number;
  workspace: string;
  generation: number;
  createdAt: string;
  coherence: 'registered-flujo-writers';
  externalRootsIncluded: false;
  subtrees: readonly string[];
  files: SnapshotManifestFile[];
  source: { version: string; platform: string };
  runtime: {
    mcpTransfer: WorkspaceMcpTransferPlan;
    codexAuth: 'chatgpt' | 'none';
    encryption: 'default' | 'user';
    selectedFlowIds?: string[];
  };
  /** Runtime directories rebuilt by the same FLUJO/package installers. */
  excludedRuntimePaths: string[];
}

export interface CapturedWorkspaceSnapshot {
  zip: JSZip;
  manifest: WorkspaceSnapshotManifest;
  files: number;
  bytes: number;
  dispose?: () => Promise<void>;
}

export interface WorkspaceArchiveResult {
  archivePath: string;
  stagingDir: string;
  sha256: string;
  plaintextSha256: string;
  encrypted: boolean;
  recipientKeyUsed?: boolean;
  encryptionVersion?: 0 | 1 | 2;
  size: number;
  files: number;
  bytes: number;
}

export class SnapshotArchiveError extends Error {
  constructor(
    readonly code: 'UNSAFE_ENTRY' | 'SIZE_LIMIT' | 'WORKSPACE_UNAVAILABLE' | 'CREDENTIALS_UNAVAILABLE' | 'MCP_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotArchiveError';
  }
}

const captureStores = new WeakMap<CapturedWorkspaceSnapshot, { store: SnapshotInput; members: Map<string, { position: number; size: number; file: JSZip.JSZipObject }> }>();
const captureKeys = new WeakMap<CapturedWorkspaceSnapshot, { key: Buffer | null; recipientKeyUsed: boolean }>();
export function resolveSnapshotKey(recipientKey?: string): Buffer | null {
  if (recipientKey !== undefined && typeof recipientKey !== 'string') throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Configure a canonical base64 32-byte worker snapshot encryption key.');
  const value = recipientKey ?? process.env.FLUJO_WORKER_SNAPSHOT_KEY;
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length !== 44) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Configure a canonical base64 32-byte worker snapshot encryption key.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    key.fill(0);
    throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Configure a canonical base64 32-byte worker snapshot encryption key.');
  }
  return key;
}

async function hasStoredCredentials(zip: JSZip): Promise<boolean> {
  let found = false;
  const inspect = async (value: string, credential: boolean) => {
    if (value && !/^\$\{global:[^}]+\}$/.test(value)
        && (credential || /^(?:encrypted:|encrypted_failed:|v2:)/.test(value))) found = true;
    return value;
  };
  try {
    for (const store of CREDENTIAL_TRANSFER_STORES) {
      const file = zip.file(`db/${store}.json`);
      if (!file) continue;
      const record: unknown = JSON.parse(await file.async('string'));
      if (store === StorageKey.GLOBAL_ENV_VARS && record && typeof record === 'object') {
        for (const value of Object.values(record)) await transformCredentialValues(value, inspect, true);
      } else await transformCredentialValues(record, inspect, false, 0, false,
        store === StorageKey.MCP_SERVERS ? async (_kind, value) => {
          if (value && (typeof value !== 'object' || Object.keys(value).length)) found = true;
          return value;
        } : undefined);
    }
    return found;
  } catch {
    throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Credential inventory cannot be verified for plaintext export.');
  }
}

function isInside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return allowRoot;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function addWorkspaceMetadata(
  zip: JSZip,
  root: string,
  recordFile: (archivePath: string, content: Buffer) => void,
  maxFileBytes: number,
  signal?: AbortSignal,
  stream?: { consume: (chunk: Buffer) => Promise<void>; complete: (stats: BigIntStats) => void },
): Promise<void> {
  signal?.throwIfAborted();
  const metadataPath = path.join(root, WORKSPACE_METADATA_FILE);
  let before: BigIntStats;
  try {
    before = await fs.lstat(metadataPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!before.isFile() || before.isSymbolicLink() || before.nlink > BigInt(1)) {
    throw new SnapshotArchiveError(
      'UNSAFE_ENTRY',
      'Workspace metadata is not a plain, singly-linked file.',
    );
  }
  if (before.size > BigInt(maxFileBytes)) throw new SnapshotArchiveError('SIZE_LIMIT', 'Workspace metadata exceeds the configured file limit.');

  const canonicalRoot = await fs.realpath(root);
  const canonicalMetadata = await fs.realpath(metadataPath);
  if (!isInside(canonicalRoot, canonicalMetadata)) {
    throw new SnapshotArchiveError(
      'UNSAFE_ENTRY',
      'Workspace metadata resolves outside the workspace.',
    );
  }

  try {
    const content = await readPlainFile(metadataPath, {
      expected: before, maxBytes: maxFileBytes, signal, consume: stream?.consume,
      verifyPath: async () => {
        await assertLinkFreeFileParent(root, metadataPath);
        if (!isInside(canonicalRoot, await fs.realpath(metadataPath))) {
          throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Workspace metadata resolves outside the workspace.');
        }
      },
    });
    if (stream) stream.complete(before);
    else { recordFile(WORKSPACE_METADATA_FILE, content); zip.file(WORKSPACE_METADATA_FILE, content); }
  } catch (error) {
    if (error instanceof PlainFileReadError) {
      throw new SnapshotArchiveError(error.code === 'SIZE_LIMIT' ? 'SIZE_LIMIT' : 'UNSAFE_ENTRY', 'Workspace metadata changed or is unsafe.');
    }
    throw error;
  }
}

/**
 * Copy the managed workspace generation into immutable authenticated ciphertext
 * spool ranges. The caller holds the workspace mutation boundary during this phase;
 * compression and archive persistence happen after the boundary is released.
 */
export async function captureWorkspaceSnapshot(
  workspace: string,
  generation: number,
  options: { signal?: AbortSignal; flowIds?: string[]; recipientKey?: string } = {},
): Promise<CapturedWorkspaceSnapshot> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (await isCredentialMigrationPending(workspace)) {
    throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Resume or roll back credential migration before creating a worker snapshot.');
  }
  const encryptionKey = resolveSnapshotKey(options.recipientKey);
  const root = getWorkspaceDataDir(workspace);
  let rootStats: Stats;
  try {
    rootStats = await fs.lstat(root);
  } catch {
    encryptionKey?.fill(0);
    throw new SnapshotArchiveError('WORKSPACE_UNAVAILABLE', 'Workspace directory is unavailable.');
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    encryptionKey?.fill(0);
    throw new SnapshotArchiveError(
      'WORKSPACE_UNAVAILABLE',
      'Workspace directory is not a real directory.',
    );
  }

  const limits = getSnapshotLimits();
  const maxFileBytes = limits.maxFileBytes;
  const maxSnapshotBytes = limits.maxUncompressedBytes;
  const files: SnapshotManifestFile[] = [];
  let totalBytes = 0;
  const zip = new JSZip();
  let store: SnapshotInput;
  try { store = await SnapshotInput.create(); } catch (error) { encryptionKey?.fill(0); throw error; }
  const members = new Map<string, { position: number; size: number; file: JSZip.JSZipObject }>();
  try {

    const recordFile = (archivePath: string, content: Buffer, stats?: BigIntStats): void => {
      signal?.throwIfAborted();
      if (content.byteLength > maxFileBytes) throw new SnapshotArchiveError('SIZE_LIMIT', 'Snapshot member exceeds the configured file limit.');
      // FLUJO's JSON state is portable. Opaque live databases in user data need
      // their owner's online-backup contract; do not silently produce a bad copy.
      if (content.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
        throw new SnapshotArchiveError('UNSAFE_ENTRY', `Live SQLite state is not portable: ${archivePath}. Export it with its owning tool first.`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > maxSnapshotBytes) {
        throw new SnapshotArchiveError(
          'SIZE_LIMIT',
          'Workspace snapshot exceeds the configured total size limit.',
        );
      }
      files.push({
        path: archivePath,
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        mode: stats ? 0o600 | Number(stats.mode & BigInt(0o100)) : 0o600,
      });
    };

    const metadataPosition = store.size;
    const metadataHash = createHash('sha256');
    let metadataPrefix = Buffer.alloc(0);
    await addWorkspaceMetadata(zip, root, recordFile, maxFileBytes, signal, {
      consume: async chunk => {
        if (store.size + chunk.length > maxSnapshotBytes) throw new SnapshotArchiveError('SIZE_LIMIT', 'Workspace snapshot exceeds the configured total size limit.');
        if (metadataPrefix.length < 16) metadataPrefix = Buffer.concat([metadataPrefix, chunk.subarray(0, 16 - metadataPrefix.length)]);
        metadataHash.update(chunk);
        await store.append(chunk);
      },
      complete: stats => {
        if (metadataPrefix.equals(Buffer.from('SQLite format 3\0'))) throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Live SQLite state is not portable: .workspace.json. Export it with its owning tool first.');
        const size = Number(stats.size);
        totalBytes += size;
        files.push({ path: WORKSPACE_METADATA_FILE, size, sha256: metadataHash.digest('hex'), mode: 0o600 });
        zip.file(WORKSPACE_METADATA_FILE, Buffer.alloc(0));
        members.set(WORKSPACE_METADATA_FILE, { position: metadataPosition, size, file: zip.file(WORKSPACE_METADATA_FILE)! });
      },
    });

    const excludedRuntimePaths = [
      'mcp-servers', 'db/codex-runtime', 'db/antigravity-cli-runtime', 'userdata/mcp-runtime',
      'browser-profile', 'bash-utils', 'db/worker-bootstrap-secrets.json',
      // Original receipts, payloads and host bindings are runtime authority.
      'db/native-tool-journal', 'db/native-session-payloads',
      'db/native-session-origins',
    ];
    const skipRuntimePath = (entryPath: string): boolean =>
      excludedRuntimePaths.some(prefix => entryPath === prefix || entryPath.startsWith(`${prefix}/`))
        || /^db\/codex-private-[^/]*(?:\/|$)/i.test(entryPath);

    for (const subtree of WORKSPACE_SUBTREES) {
      signal?.throwIfAborted();
      if (skipRuntimePath(subtree)) { zip.folder(subtree); continue; }
      const source = path.join(root, subtree);
      let subtreeStats: Stats;
      try {
        subtreeStats = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          zip.folder(subtree);
          continue;
        }
        throw error;
      }
      if (!subtreeStats.isDirectory() || subtreeStats.isSymbolicLink()) {
        throw new SnapshotArchiveError(
          'UNSAFE_ENTRY',
          `Workspace subtree ${subtree} is not a real directory.`,
        );
      }

      zip.folder(subtree);
      await addFolderToZipLinkSafe(
        zip,
        source,
        subtree,
        root,
        (entryPath, reason) => {
          throw new SnapshotArchiveError(
            reason.includes('size limit') ? 'SIZE_LIMIT' : 'UNSAFE_ENTRY',
            `Cannot safely snapshot ${entryPath}: ${reason}`,
          );
        },
        {
          maxFileBytes,
          skippedDirectories: new Set(['node_modules', '.venv', '__pycache__']),
          skipPath: skipRuntimePath,
          signal,
          preserveMode: true,
          allowHardLinks: true,
          onFileStream: async (archivePath, chunks, stats) => {
            const size = Number(stats.size);
            if (totalBytes + size > maxSnapshotBytes) throw new SnapshotArchiveError('SIZE_LIMIT', 'Workspace snapshot exceeds the configured total size limit.');
            const position = store.size;
            const hash = createHash('sha256');
            let prefix = Buffer.alloc(0);
            for await (const chunk of chunks) {
              signal?.throwIfAborted();
              if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
              hash.update(chunk);
              await store.append(chunk);
            }
            if (store.size - position !== size) throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Snapshot member changed while being captured.');
            if (prefix.equals(Buffer.from('SQLite format 3\0'))) throw new SnapshotArchiveError('UNSAFE_ENTRY', `Live SQLite state is not portable: ${archivePath}. Export it with its owning tool first.`);
            totalBytes += size;
            files.push({ path: archivePath, size, sha256: hash.digest('hex'), mode: 0o600 | Number(stats.mode & BigInt(0o100)) });
            zip.file(archivePath, Buffer.alloc(0), { unixPermissions: Number(stats.mode & BigInt(0o100777)) });
            members.set(archivePath, { position, size, file: zip.file(archivePath)! });
          },
        },
      );
    }

    await store.finish();
    const capturedContents = async (name: string): Promise<Buffer> => {
      const member = members.get(name);
      if (member && zip.file(name) === member.file) {
        const chunks: Buffer[] = [];
        for await (const chunk of store.range(member.position, member.size)) chunks.push(chunk);
        return Buffer.concat(chunks);
      }
      return zip.file(name)!.async('nodebuffer');
    };
    // Every inspection receives a fresh immutable member stream, including repeated reads.
    for (const [name, member] of members) {
      member.file.async = ((type, onUpdate) => {
        const inspection = new JSZip();
        inspection.file(name, Readable.from(store.range(member.position, member.size), { objectMode: false, highWaterMark: 64 * 1024 }));
        return inspection.file(name)!.async(type, onUpdate);
      }) as typeof member.file.async;
    }
    const readCapturedJson = async <T>(name: string, fallback: T): Promise<T> => {
      const file = zip.file(name);
      if (!file) return fallback;
      try { return JSON.parse((await capturedContents(name)).toString('utf8')) as T; }
      catch { throw new SnapshotArchiveError('UNSAFE_ENTRY', `Invalid workspace configuration: ${name}`); }
    };
    const storedServers = await readCapturedJson<Record<string, Partial<MCPServerConfig>>>('db/mcp_servers.json', {});
    if (!storedServers || typeof storedServers !== 'object' || Array.isArray(storedServers)
      || Object.values(storedServers).some(config => !config || typeof config !== 'object')) {
      throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Invalid workspace configuration: db/mcp_servers.json');
    }
    const models = await readCapturedJson<Model[]>('db/models.json', []);
    if (!Array.isArray(models) || models.some(model => !model || typeof model !== 'object')) {
      throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Invalid workspace configuration: db/models.json');
    }
    const putPrivateFile = (name: string, content: Buffer): void => {
      const existing = files.findIndex(file => file.path === name);
      if (existing !== -1) totalBytes -= files.splice(existing, 1)[0].size;
      recordFile(name, content);
      zip.file(name, content, { unixPermissions: 0o100600 });
    };
    const flows = new Map<string, Flow>();
    if (options.flowIds) {
      const legacy = await readCapturedJson<Flow[]>('db/flows.json', []);
      if (!Array.isArray(legacy)) throw new SnapshotArchiveError('UNSAFE_ENTRY', 'Invalid workspace configuration: db/flows.json');
      for (const flow of legacy) flows.set(flow.id, flow);
      for (const name of Object.keys(zip.files).filter(name => /^db\/flows\/[^/]+\.json$/.test(name))) {
        const flow = await readCapturedJson<Flow | null>(name, null);
        if (!flow || typeof flow.id !== 'string' || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
          throw new SnapshotArchiveError('UNSAFE_ENTRY', `Invalid workspace flow: ${name}`);
        }
        flows.set(flow.id, flow);
      }
    }
    let mcpTransfer: WorkspaceMcpTransferPlan;
    let requiresCodexAuth: boolean;
    let selectedFlowIds: string[] | undefined;
    try {
      const selection = selectWorkspaceFlowDependencies(options.flowIds, {
        flows: [...flows.values()], models,
        mcpServers: Object.entries(storedServers).map(([name, config]) => ({
          ...config, name, transport: config.transport || 'stdio',
        } as MCPServerConfig)),
      });
      requiresCodexAuth = selection.requiresCodexAuth;
      selectedFlowIds = options.flowIds ? selection.flowIds : undefined;
      if (selectedFlowIds) {
        putPrivateFile('db/mcp_servers.json', Buffer.from(JSON.stringify(Object.fromEntries(
          selection.configs.map(config => [config.name, config]),
        ))));
      }
      mcpTransfer = await pinWorkspaceMcpTransferPlan(buildWorkspaceMcpTransferPlan(selection.configs, root,
        { requiredServerNames: selectedFlowIds ? selection.mcpServerNames : undefined }), { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw new SnapshotArchiveError('MCP_UNSUPPORTED', error instanceof Error ? error.message : 'MCP runtime cannot be reconstructed.');
    }
    if (!encryptionKey && await hasStoredCredentials(zip)) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Credential-bearing snapshots require encryption.');
    let codexAuth: 'chatgpt' | 'none' = 'none';
    if (requiresCodexAuth) {
      if (!encryptionKey) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'ChatGPT authentication requires an encrypted workspace snapshot.');
      try {
        const auth = await readCodexAuthForTransfer(workspace);
        signal?.throwIfAborted();
        putPrivateFile('db/codex-runtime/auth.json', auth);
        putPrivateFile(`db/codex-runtime/${CODEX_AUTH_SOURCE_FILE}`, Buffer.from(JSON.stringify(WORKSPACE_CODEX_AUTH_SOURCE)));
        codexAuth = 'chatgpt';
      } catch {
        signal?.throwIfAborted();
        throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Codex authentication is unavailable for encrypted transfer.');
      }
    }
    const encryptionMetadata = await readCapturedJson<EncryptionMetadata>('db/encryption_key.json', {} as EncryptionMetadata);
    const encryption = encryptionMetadata.encryption_type === 'user' ? 'user' : 'default';
    if (encryption === 'user') {
      if (!encryptionKey) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Private workspace bootstrap requires an encrypted snapshot.');
      let workspaceDek: string | null;
      try {
        workspaceDek = encryptionMetadata.key_protection === 'operator-file'
          ? await runWithWorkspace(workspace, () => getOperatorWorkerBootstrapKey(encryptionMetadata))
          : getServerDek();
      } catch {
        throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Restore the matching independent operator secret before creating a worker snapshot.');
      }
      if (!workspaceDek) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Unlock this workspace before creating a worker snapshot.');
      putPrivateFile('db/worker-bootstrap-secrets.json', Buffer.from(JSON.stringify({ version: 1, workspaceDek })));
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: WorkspaceSnapshotManifest = {
      formatVersion: WORKER_SNAPSHOT_FORMAT_VERSION,
      layoutVersion: WORKSPACE_LAYOUT_VERSION,
      workspace,
      generation,
      createdAt: new Date().toISOString(),
      coherence: 'registered-flujo-writers',
      externalRootsIncluded: false,
      subtrees: WORKSPACE_SUBTREES,
      files,
      source: { version: appPackage.version, platform: process.platform },
      runtime: { mcpTransfer, codexAuth, encryption, ...(selectedFlowIds ? { selectedFlowIds } : {}) },
      excludedRuntimePaths,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    if (manifestBytes.length > limits.maxManifestBytes || Object.keys(zip.files).length + 1 > limits.maxMembers) throw new SnapshotArchiveError('SIZE_LIMIT', 'Snapshot manifest or member count exceeds the restore limit.');
    zip.file('snapshot-manifest.json', manifestBytes);

    let disposed = false;
    const captured: CapturedWorkspaceSnapshot = { zip, manifest, files: files.length, bytes: totalBytes, dispose: async () => {
      if (disposed) return;
      encryptionKey?.fill(0);
      await store.close();
      disposed = true;
    } };
    signal?.throwIfAborted();
    captureStores.set(captured, { store, members });
    zip.generateInternalStream = ((options: Parameters<JSZip['generateInternalStream']>[0]) =>
      zipForCapturedSnapshot(captured).generateInternalStream(options)) as typeof zip.generateInternalStream;
    captureKeys.set(captured, { key: encryptionKey, recipientKeyUsed: options.recipientKey !== undefined });
    return captured;
  } catch (error) {
    encryptionKey?.fill(0);
    await store.close().catch(() => undefined);
    throw error;
  }
}

function zipForCapturedSnapshot(captured: CapturedWorkspaceSnapshot): JSZip {
  const stored = captureStores.get(captured);
  if (!stored) return captured.zip;
  const zip = new JSZip();
  for (const [name, file] of Object.entries(captured.zip.files)) {
    const member = stored.members.get(name);
    if (file.dir) zip.folder(name);
    else if (member && member.file === file) zip.file(name,
      Readable.from(stored.store.range(member.position, member.size), { objectMode: false, highWaterMark: 64 * 1024 }),
      { unixPermissions: file.unixPermissions ?? undefined });
    else zip.file(name, file.async('nodebuffer'), { unixPermissions: file.unixPermissions ?? undefined });
  }
  return zip;
}

export async function writeWorkspaceSnapshotArchive(
  captured: CapturedWorkspaceSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceArchiveResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const capture = captureKeys.get(captured);
  const key = capture?.recipientKeyUsed ? Buffer.from(capture.key!) : resolveSnapshotKey();
  try {
    if (captureKeys.has(captured)) {
      const original = capture?.key;
      if (Boolean(original) !== Boolean(key) || (original && key && !timingSafeEqual(original, key))) {
        key?.fill(0);
        throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Snapshot encryption key changed. Start a new capture.');
      }
    }
    const paths = Object.keys(captured.zip.files);
    if (paths.length > getSnapshotLimits().maxMembers) {
      throw new SnapshotArchiveError('SIZE_LIMIT', 'Snapshot exceeds the archive member limit.');
    }
    const allowedRuntime = new Set(['db/codex-runtime/', 'db/codex-runtime/auth.json', `db/codex-runtime/${CODEX_AUTH_SOURCE_FILE}`]);
    if (paths.some(name => /^db\/codex-private-/i.test(name))
        || paths.some(name => /^db\/codex-runtime(?:\/|$)/i.test(name) && !allowedRuntime.has(name))
        || (!key && (captured.manifest.runtime.codexAuth === 'chatgpt' || captured.manifest.runtime.encryption === 'user' || paths.includes('db/worker-bootstrap-secrets.json') || await hasStoredCredentials(captured.zip) || paths.some(name => /^db\/codex-runtime(?:\/|$)/i.test(name))))) {
      key?.fill(0);
      throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Credential-bearing snapshots require encryption; runtime homes cannot be exported.');
    }
    if (await isCredentialMigrationPending(captured.manifest.workspace)) {
      throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Resume or roll back credential migration before creating a worker snapshot.');
    }
    const stagingDir = await fs.mkdtemp(path.join(tmpdir(), 'flujo-hot-clone-'));
    await fs.chmod(stagingDir, 0o700).catch(() => undefined);
    const archivePath = path.join(stagingDir, 'workspace.snapshot.zip');

    try {
      const zip = zipForCapturedSnapshot(captured);
      const source = zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'UNIX',
      }, () => signal?.throwIfAborted());
      const persisted = await writeSnapshotStream(new Readable({ highWaterMark: 64 * 1024 }).wrap(source as Readable), archivePath, key, signal);
      await fs.chmod(archivePath, 0o600).catch(() => undefined);
      signal?.throwIfAborted();

      return {
        archivePath,
        stagingDir,
        sha256: persisted.sha256,
        plaintextSha256: persisted.plaintextSha256,
        encrypted: Boolean(key),
        encryptionVersion: key ? 2 : 0,
        recipientKeyUsed: capture?.recipientKeyUsed ?? false,
        size: persisted.size,
        files: captured.files,
        bytes: captured.bytes,
      };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    key?.fill(0);
  }
}

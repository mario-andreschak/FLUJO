import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { WORKSPACE_SUBTREES, getWorkspaceDataDir } from '@/utils/workspace';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { addFolderToZipLinkSafe } from './backupRestoreFs';
import { buildWorkspaceMcpTransferPlan, pinWorkspaceMcpTransferPlan, selectWorkspaceFlowDependencies, type WorkspaceMcpTransferPlan } from '@/backend/services/packages/workspaceMcpTransfer';
import { CODEX_AUTH_SOURCE_FILE, WORKSPACE_CODEX_AUTH_SOURCE, readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { getServerDek } from '@/utils/encryption/session';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { Model } from '@/shared/types/model';
import type { Flow } from '@/shared/types/flow';
import appPackage from '../../../../package.json';

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const WORKSPACE_METADATA_FILE = '.workspace.json';

export interface SnapshotManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode?: number;
}

export interface WorkspaceSnapshotManifest {
  formatVersion: 2;
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
}

export interface WorkspaceArchiveResult {
  archivePath: string;
  stagingDir: string;
  sha256: string;
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

function configuredLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sameFileIdentity(first: Stats, second: Stats): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs;
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
): Promise<void> {
  signal?.throwIfAborted();
  const metadataPath = path.join(root, WORKSPACE_METADATA_FILE);
  let before: Stats;
  try {
    before = await fs.lstat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    throw new SnapshotArchiveError(
      'UNSAFE_ENTRY',
      'Workspace metadata is not a plain, singly-linked file.',
    );
  }
  if (before.size > maxFileBytes) throw new SnapshotArchiveError('SIZE_LIMIT', 'Workspace metadata exceeds the configured file limit.');

  const canonicalRoot = await fs.realpath(root);
  const canonicalMetadata = await fs.realpath(metadataPath);
  if (!isInside(canonicalRoot, canonicalMetadata)) {
    throw new SnapshotArchiveError(
      'UNSAFE_ENTRY',
      'Workspace metadata resolves outside the workspace.',
    );
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.open(metadataPath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || !sameFileIdentity(before, opened)) {
      throw new SnapshotArchiveError(
        'UNSAFE_ENTRY',
        'Workspace metadata changed while it was opened.',
      );
    }
    const content = await handle.readFile({ signal });
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || content.byteLength !== opened.size) {
      throw new SnapshotArchiveError(
        'UNSAFE_ENTRY',
        'Workspace metadata changed while it was read.',
      );
    }
    recordFile(WORKSPACE_METADATA_FILE, content);
    zip.file(WORKSPACE_METADATA_FILE, content);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read the complete managed workspace generation into immutable in-memory ZIP
 * inputs. The caller holds the workspace mutation boundary during this phase;
 * compression and archive persistence happen after the boundary is released.
 */
export async function captureWorkspaceSnapshot(
  workspace: string,
  generation: number,
  options: { signal?: AbortSignal; flowIds?: string[] } = {},
): Promise<CapturedWorkspaceSnapshot> {
  const { signal } = options;
  signal?.throwIfAborted();
  const root = getWorkspaceDataDir(workspace);
  let rootStats: Stats;
  try {
    rootStats = await fs.lstat(root);
  } catch {
    throw new SnapshotArchiveError('WORKSPACE_UNAVAILABLE', 'Workspace directory is unavailable.');
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new SnapshotArchiveError(
      'WORKSPACE_UNAVAILABLE',
      'Workspace directory is not a real directory.',
    );
  }

  const maxFileBytes = configuredLimit(
    'FLUJO_SNAPSHOT_MAX_FILE_BYTES',
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxSnapshotBytes = configuredLimit(
    'FLUJO_SNAPSHOT_MAX_BYTES',
    DEFAULT_MAX_SNAPSHOT_BYTES,
  );
  const files: SnapshotManifestFile[] = [];
  let totalBytes = 0;
  const zip = new JSZip();

  const recordFile = (archivePath: string, content: Buffer, stats?: Stats): void => {
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
      mode: stats ? 0o600 | (stats.mode & 0o100) : 0o600,
    });
  };

  await addWorkspaceMetadata(zip, root, recordFile, maxFileBytes, signal);

  const excludedRuntimePaths = [
    'mcp-servers', 'db/codex-runtime', 'userdata/mcp-runtime',
    'browser-profile', 'bash-utils', 'db/worker-bootstrap-secrets.json',
  ];
  const skipRuntimePath = (entryPath: string): boolean =>
    excludedRuntimePaths.some(prefix => entryPath === prefix || entryPath.startsWith(`${prefix}/`));

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
        onFile: recordFile,
      },
    );
  }

  const readCapturedJson = async <T>(name: string, fallback: T): Promise<T> => {
    const file = zip.file(name);
    if (!file) return fallback;
    try { return JSON.parse(await file.async('string')) as T; }
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
  let codexAuth: 'chatgpt' | 'none' = 'none';
  if (requiresCodexAuth) {
    try {
      const auth = await readCodexAuthForTransfer(workspace);
      signal?.throwIfAborted();
      putPrivateFile('db/codex-runtime/auth.json', auth);
      putPrivateFile(`db/codex-runtime/${CODEX_AUTH_SOURCE_FILE}`, Buffer.from(JSON.stringify(WORKSPACE_CODEX_AUTH_SOURCE)));
      codexAuth = 'chatgpt';
    } catch (error) {
      signal?.throwIfAborted();
      throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', error instanceof Error ? error.message : 'Codex login is unavailable.');
    }
  }
  const encryptionMetadata = await readCapturedJson<{ encryption_type?: string }>('db/encryption_key.json', {});
  const encryption = encryptionMetadata.encryption_type === 'user' ? 'user' : 'default';
  if (encryption === 'user') {
    const workspaceDek = getServerDek();
    if (!workspaceDek) throw new SnapshotArchiveError('CREDENTIALS_UNAVAILABLE', 'Unlock this workspace before creating a worker snapshot.');
    putPrivateFile('db/worker-bootstrap-secrets.json', Buffer.from(JSON.stringify({ version: 1, workspaceDek })));
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkspaceSnapshotManifest = {
    formatVersion: 2,
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
  zip.file('snapshot-manifest.json', JSON.stringify(manifest, null, 2));

  return {
    zip,
    manifest,
    files: files.length,
    bytes: totalBytes,
  };
}

export async function writeWorkspaceSnapshotArchive(
  captured: CapturedWorkspaceSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceArchiveResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const stagingDir = await fs.mkdtemp(path.join(tmpdir(), 'flujo-hot-clone-'));
  await fs.chmod(stagingDir, 0o700).catch(() => undefined);
  const archivePath = path.join(stagingDir, 'workspace.snapshot.zip');

  try {
    const archive = await captured.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
    }, () => signal?.throwIfAborted());
    signal?.throwIfAborted();
    await fs.writeFile(archivePath, archive, { mode: 0o600 });
    await fs.chmod(archivePath, 0o600).catch(() => undefined);
    signal?.throwIfAborted();

    return {
      archivePath,
      stagingDir,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
      files: captured.files,
      bytes: captured.bytes,
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

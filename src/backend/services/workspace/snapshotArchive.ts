import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { WORKSPACE_SUBTREES, getWorkspaceDataDir } from '@/utils/workspace';
import { WORKSPACE_LAYOUT_VERSION } from './layoutVersion';
import { addFolderToZipLinkSafe } from './backupRestoreFs';

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const WORKSPACE_METADATA_FILE = '.workspace.json';

export interface SnapshotManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface WorkspaceSnapshotManifest {
  formatVersion: 1;
  layoutVersion: number;
  workspace: string;
  generation: number;
  createdAt: string;
  coherence: 'registered-flujo-writers';
  externalRootsIncluded: false;
  subtrees: readonly string[];
  files: SnapshotManifestFile[];
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
    readonly code: 'UNSAFE_ENTRY' | 'SIZE_LIMIT' | 'WORKSPACE_UNAVAILABLE',
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
): Promise<void> {
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
    const content = await handle.readFile();
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
): Promise<CapturedWorkspaceSnapshot> {
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

  const recordFile = (archivePath: string, content: Buffer): void => {
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
    });
  };

  await addWorkspaceMetadata(zip, root, recordFile);

  for (const subtree of WORKSPACE_SUBTREES) {
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
        skippedDirectories: new Set<string>(),
        allowHardLinks: true,
        onFile: recordFile,
      },
    );
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkspaceSnapshotManifest = {
    formatVersion: 1,
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    workspace,
    generation,
    createdAt: new Date().toISOString(),
    coherence: 'registered-flujo-writers',
    externalRootsIncluded: false,
    subtrees: WORKSPACE_SUBTREES,
    files,
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
): Promise<WorkspaceArchiveResult> {
  const stagingDir = await fs.mkdtemp(path.join(tmpdir(), 'flujo-hot-clone-'));
  await fs.chmod(stagingDir, 0o700).catch(() => undefined);
  const archivePath = path.join(stagingDir, 'workspace.snapshot.zip');

  try {
    const archive = await captured.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fs.writeFile(archivePath, archive, { mode: 0o600 });
    await fs.chmod(archivePath, 0o600).catch(() => undefined);

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

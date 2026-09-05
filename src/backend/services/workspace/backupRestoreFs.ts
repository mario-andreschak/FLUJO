import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type JSZip from 'jszip';

const MAX_ARCHIVE_FILE_BYTES = 10 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

export type ArchiveSkipReporter = (entryPath: string, reason: string) => void;

export interface ArchiveTraversalOptions {
  maxFileBytes?: number;
  skippedDirectories?: ReadonlySet<string>;
  allowHardLinks?: boolean;
  onFile?: (entryPath: string, content: Buffer, stats: Stats) => void;
  /** Rebuildable runtime paths can be omitted before following or inspecting them. */
  skipPath?: (entryPath: string) => boolean;
  signal?: AbortSignal;
  preserveMode?: boolean;
}

function isInside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return allowRoot;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function lstatOptional(candidate: string): Promise<Stats | null> {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertPlainDirectory(stats: Stats | null, label: string): asserts stats is Stats {
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link or junction.`);
  }
}

function sameFileIdentity(first: Stats, second: Stats): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs;
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof fs.open>>, size: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, offset, Math.min(size - offset, 1024 * 1024), offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

function archiveSegments(relativePath: string): string[] | null {
  if (
    !relativePath
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)
  ) return null;

  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    return null;
  }
  return segments;
}

function safeArchiveTarget(targetRoot: string, relativePath: string): string | null {
  const segments = archiveSegments(relativePath);
  if (!segments) return null;
  const candidate = path.resolve(targetRoot, ...segments);
  return isInside(targetRoot, candidate) ? candidate : null;
}

/**
 * Validate every existing path component from boundary to directory and create
 * missing components one at a time. Recursive mkdir/access would follow an
 * attacker-planted symlink or Windows junction.
 */
async function ensureLinkFreeDirectory(
  boundaryPath: string,
  directory: string,
  create: boolean,
): Promise<void> {
  const boundary = path.resolve(boundaryPath);
  const target = path.resolve(directory);
  assertPlainDirectory(await lstatOptional(boundary), 'Workspace restore boundary');
  if (!isInside(boundary, target, true)) {
    throw new Error(`Restore directory escapes workspace boundary: ${target}`);
  }

  const relative = path.relative(boundary, target);
  let current = boundary;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stats = await lstatOptional(current);
    if (!stats && create) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stats = await lstatOptional(current);
    }
    assertPlainDirectory(stats, `Restore path component ${current}`);
  }

  // Defense in depth for platforms with unusual reparse-point reporting.
  const canonicalBoundary = await fs.realpath(boundary);
  const canonicalTarget = await fs.realpath(target);
  if (!isInside(canonicalBoundary, canonicalTarget, true)) {
    throw new Error(`Restore directory resolves outside workspace boundary: ${target}`);
  }
}

/**
 * Add a folder without ever dereferencing symlinks/junctions. File handles are
 * identity-checked after open so a path swapped between lstat and open is also
 * skipped rather than archived.
 */
export async function addFolderToZipLinkSafe(
  zip: JSZip,
  folderPath: string,
  zipPath: string,
  boundaryPath: string,
  onSkip: ArchiveSkipReporter = () => undefined,
  options: ArchiveTraversalOptions = {},
): Promise<void> {
  const maxFileBytes = options.maxFileBytes ?? MAX_ARCHIVE_FILE_BYTES;
  const skippedDirectories = options.skippedDirectories ?? SKIPPED_DIRECTORIES;
  const boundary = path.resolve(boundaryPath);
  const root = path.resolve(folderPath);
  assertPlainDirectory(await lstatOptional(boundary), 'Workspace backup boundary');
  assertPlainDirectory(await lstatOptional(root), 'MCP backup root');
  if (!isInside(boundary, root)) throw new Error('MCP backup root escapes its workspace.');

  const canonicalBoundary = await fs.realpath(boundary);
  const canonicalRoot = await fs.realpath(root);
  if (!isInside(canonicalBoundary, canonicalRoot)) {
    throw new Error('MCP backup root resolves outside its workspace.');
  }

  const visit = async (directory: string, archiveDirectory: string): Promise<void> => {
    options.signal?.throwIfAborted();
    const directoryStats = await lstatOptional(directory);
    if (!directoryStats || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      onSkip(archiveDirectory, 'directory is a symbolic link, junction, or no longer exists');
      return;
    }
    const canonicalDirectory = await fs.realpath(directory);
    if (!isInside(canonicalRoot, canonicalDirectory, true)) {
      onSkip(archiveDirectory, 'directory resolves outside MCP backup root');
      return;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const fullPath = path.join(directory, entry.name);
      const archivePath = path.posix.join(archiveDirectory, entry.name);
      if (options.skipPath?.(archivePath)) continue;
      let stats: Stats | null;
      try {
        stats = await lstatOptional(fullPath);
      } catch (error) {
        onSkip(archivePath, `lstat failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (!stats || stats.isSymbolicLink()) {
        onSkip(archivePath, 'symbolic links and junctions are not backed up');
        continue;
      }

      if (stats.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue;
        let canonicalChild: string;
        try {
          canonicalChild = await fs.realpath(fullPath);
        } catch {
          onSkip(archivePath, 'directory disappeared while being inspected');
          continue;
        }
        if (!isInside(canonicalRoot, canonicalChild)) {
          onSkip(archivePath, 'directory resolves outside MCP backup root');
          continue;
        }
        zip.folder(archivePath);
        await visit(fullPath, archivePath);
        continue;
      }

      if (!stats.isFile()) {
        onSkip(archivePath, 'non-regular filesystem entry');
        continue;
      }
      // A hard link can alias a file outside the workspace without any
      // symlink bit for lstat to reveal. Never archive multiply-linked files.
      if (stats.nlink > 1 && !options.allowHardLinks) {
        onSkip(archivePath, 'hard-linked files are not backed up');
        continue;
      }
      if (stats.size > maxFileBytes) {
        onSkip(archivePath, 'file exceeds backup size limit');
        continue;
      }

      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
        handle = await fs.open(fullPath, fsConstants.O_RDONLY | noFollow);
        const openedStats = await handle.stat();
        const canonicalFile = await fs.realpath(fullPath);
        if (
          !openedStats.isFile()
          || (openedStats.nlink > 1 && !options.allowHardLinks)
          || openedStats.size > maxFileBytes
          || !sameFileIdentity(stats, openedStats)
          || !isInside(canonicalRoot, canonicalFile)
        ) {
          onSkip(archivePath, 'file changed or escaped while being opened');
          continue;
        }
        const content = await readBoundedFile(handle, openedStats.size, options.signal);
        const finalStats = await handle.stat();
        if (content.byteLength !== openedStats.size || !sameFileIdentity(openedStats, finalStats)) {
          onSkip(archivePath, 'file changed while being read');
          continue;
        }
        options.signal?.throwIfAborted();
        options.onFile?.(archivePath, content, finalStats);
        zip.file(archivePath, content, options.preserveMode
          ? { unixPermissions: finalStats.mode & 0o100777 }
          : undefined);
      } catch (error) {
        options.signal?.throwIfAborted();
        onSkip(archivePath, `file could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
  };

  await visit(root, zipPath);
}

export async function atomicWriteWithoutLinks(
  boundaryPath: string,
  destination: string,
  content: Buffer,
  options: { mode?: number } = {},
): Promise<void> {
  const parent = path.dirname(destination);
  await ensureLinkFreeDirectory(boundaryPath, parent, true);
  const existing = await lstatOptional(destination);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic link or junction: ${destination}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`Refusing to replace non-file restore target: ${destination}`);
  }

  const temporary = path.join(parent, `.flujo-restore-${randomUUID()}.tmp`);
  let created = false;
  try {
    // Only owner permissions are restored; never import setuid or broad secret access.
    const mode = 0o600 | ((options.mode ?? 0) & 0o100);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Revalidate immediately before the atomic rename. rename replaces a final
    // symlink itself; it never writes through that link to its target.
    await ensureLinkFreeDirectory(boundaryPath, parent, false);
    const currentTarget = await lstatOptional(destination);
    if (currentTarget?.isSymbolicLink() || (currentTarget && !currentTarget.isFile())) {
      throw new Error(`Restore target became unsafe: ${destination}`);
    }
    await fs.rename(temporary, destination);
    created = false;
  } finally {
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Restore ordinary files only, never following a link in any target component. */
export async function restoreFolderFromZipLinkSafe(
  zip: JSZip,
  zipPath: string,
  targetPath: string,
  boundaryPath: string,
  onSkip: ArchiveSkipReporter = () => undefined,
  options: { maxFileBytes?: number; preserveMode?: boolean } = {},
): Promise<void> {
  const targetRoot = path.resolve(targetPath);
  await ensureLinkFreeDirectory(boundaryPath, targetRoot, true);

  const prefix = `${zipPath}/`;
  const entries = Object.keys(zip.files)
    .filter(entryPath => entryPath.startsWith(prefix) && entryPath !== prefix)
    .map(entryPath => {
      const entry = zip.files[entryPath];
      const rawRelative = entryPath.slice(prefix.length);
      return {
        entry,
        entryPath,
        relativePath: entry.dir ? rawRelative.replace(/\/+$/, '') : rawRelative,
      };
    });

  for (const item of entries.filter(item => item.entry.dir)) {
    const directory = safeArchiveTarget(targetRoot, item.relativePath);
    if (!directory) {
      onSkip(item.entryPath, 'unsafe archive directory path');
      continue;
    }
    try {
      await ensureLinkFreeDirectory(boundaryPath, directory, true);
    } catch (error) {
      onSkip(item.entryPath, error instanceof Error ? error.message : String(error));
    }
  }

  for (const item of entries.filter(item => !item.entry.dir)) {
    const destination = safeArchiveTarget(targetRoot, item.relativePath);
    if (!destination) {
      onSkip(item.entryPath, 'unsafe archive file path');
      continue;
    }
    try {
      const content = await item.entry.async('nodebuffer');
      if (content.length > (options.maxFileBytes ?? MAX_ARCHIVE_FILE_BYTES)) {
        onSkip(item.entryPath, 'file exceeds restore size limit');
        continue;
      }
      await atomicWriteWithoutLinks(boundaryPath, destination, content, {
        mode: options.preserveMode ? Number(item.entry.unixPermissions) : undefined,
      });
    } catch (error) {
      onSkip(item.entryPath, error instanceof Error ? error.message : String(error));
    }
  }
}

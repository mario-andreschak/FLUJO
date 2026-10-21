import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync, mkdirSync, fsyncSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { windowsStorage } from './windows-storage.js';

const unsafe = () => new Error('Controller storage must be private, locally owned and free of links.');

const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === BigInt(1);

function directoryPath(directory: string, privateLeaf: boolean): string {
  const windows = process.platform === 'win32';
  if (!isAbsolute(directory) || directory.includes('\0') || (!windows
      && (!process.getuid || process.getuid() === 0 || process.geteuid?.() !== process.getuid()))) throw unsafe();
  const absolute = resolve(directory);
  const actual = realpathSync.native(absolute);
  if (absolute === parse(absolute).root || (windows ? actual.toLowerCase() !== absolute.toLowerCase() : actual !== absolute)) throw unsafe();
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep)) {
    current = resolve(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    if (!windows && ((stat.mode & BigInt(0o022)) !== BigInt(0) || (stat.uid !== BigInt(0) && stat.uid !== BigInt(process.getuid!())))) throw unsafe();
  }
  const stat = lstatSync(absolute, { bigint: true });
  if (windows) windowsStorage(absolute, { directory: true, privateLeaf });
  else if (privateLeaf && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & BigInt(0o077)) !== BigInt(0))) throw unsafe();
  if (!sameIdentity(stat, lstatSync(absolute, { bigint: true }))) throw unsafe();
  return absolute;
}

/** Native Windows ACLs and POSIX ownership protect the same local boundary. */
export function assertPrivateDirectory(directory: string): string { return directoryPath(directory, true); }

/** Existing public certificate stores may be readable, but never replaceable by
 * another local account. This does not relax checks on controller secrets. */
export function assertStableDirectory(directory: string): string { return directoryPath(directory, false); }

/** Bootstrap only a new directory. Never change the ACL of an existing tree. */
export function createPrivateDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw unsafe();
  const absolute = resolve(directory);
  directoryPath(dirname(absolute), false);
  mkdirSync(absolute, { mode: 0o700 });
  const created = lstatSync(absolute, { bigint: true });
  if (process.platform === 'win32') windowsStorage(absolute, { directory: true, privateLeaf: true, protect: true });
  assertPrivateDirectory(absolute);
  if (!sameIdentity(created, lstatSync(absolute, { bigint: true }))) throw unsafe();
  return absolute;
}

export function assertPrivateFile(filename: string): void {
  assertPrivateDirectory(dirname(filename));
  const stat = lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) throw unsafe();
  if (process.platform === 'win32') windowsStorage(resolve(filename), { directory: false, privateLeaf: true });
  else if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & BigInt(0o077)) !== BigInt(0)) throw unsafe();
  if (!sameIdentity(stat, lstatSync(filename, { bigint: true }))) throw unsafe();
}

export function readPrivateFile(filename: string, maxBytes = 1024 * 1024): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw unsafe();
  assertPrivateFile(filename);
  const before = lstatSync(filename, { bigint: true });
  if (before.size > BigInt(maxBytes)) throw unsafe();
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw unsafe();
    const contents = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < contents.length) {
      const count = readSync(fd, contents, bytes, contents.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    assertPrivateFile(filename);
    if (bytes !== Number(before.size) || !sameFile(before, fstatSync(fd, { bigint: true }))
        || !sameFile(before, lstatSync(filename, { bigint: true }))) throw unsafe();
    return contents.subarray(0, bytes);
  } finally { closeSync(fd); }
}

export function createPrivateFile(filename: string): number {
  assertPrivateDirectory(dirname(filename));
  const fd = openSync(filename, 'wx', 0o600);
  try {
    assertPrivateFile(filename);
    if (!sameFile(lstatSync(filename, { bigint: true }), fstatSync(fd, { bigint: true }))) throw unsafe();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function syncPrivateDirectory(directory: string): void {
  // Windows does not expose directory fsync through Node. File data is fsynced
  // before rename; provisioning retains its SQLite recovery journal and always
  // revalidates config/runtime identity after restart. Power-loss qualification
  // remains part of installed release acceptance, not an assumed fsync guarantee.
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

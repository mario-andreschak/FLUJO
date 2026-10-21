import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

const unsafe = () => new Error('Controller storage must be private, locally owned and free of links.');

/** Initial deployment profile: a dedicated POSIX account on a local disk.
 * Windows requires a DACL implementation before it can host this controller.
 * Never pretend chmod supplies that boundary on Windows.
 */
export function assertPrivateDirectory(directory: string): string {
  if (process.platform === 'win32' || !process.getuid || process.getuid() === 0
      || process.geteuid?.() !== process.getuid() || !isAbsolute(directory)) throw unsafe();
  const absolute = resolve(directory);
  if (absolute === parse(absolute).root || realpathSync(absolute) !== absolute) throw unsafe();
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep)) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    // Ancestors must not be replaceable by another ordinary user (including /tmp).
    if ((stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== process.getuid())) throw unsafe();
  }
  const stat = lstatSync(absolute);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw unsafe();
  return absolute;
}

export function assertPrivateFile(filename: string): void {
  assertPrivateDirectory(dirname(filename));
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw unsafe();
}

export function readPrivateFile(filename: string, maxBytes = 1024 * 1024): Buffer {
  assertPrivateFile(filename);
  const before = lstatSync(filename);
  if (before.size > maxBytes) throw unsafe();
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw unsafe();
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (contents.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw unsafe();
    return contents;
  } finally { closeSync(fd); }
}

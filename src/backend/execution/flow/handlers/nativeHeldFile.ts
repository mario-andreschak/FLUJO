import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Open first. All admission and bounded reads refer to the held descriptor;
 * named-file and parent identities must remain unchanged before returning. */
export async function readNativeHeldFile(file: string, maximum: number, options: { privateOwner?: boolean } = {}): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let buffer: Buffer | undefined;
  let admitted = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.size < BigInt(1)
      || opened.size > BigInt(maximum) || (options.privateOwner && process.platform !== 'win32'
        && ((opened.mode & BigInt(0o077)) !== BigInt(0) || opened.uid !== BigInt(process.getuid!())))) {
      throw new Error('Native source file is unsafe.');
    }
    const directories: Array<[string, BigIntStats]> = [];
    let directory = path.dirname(path.resolve(file));
    while (true) {
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs.realpath(directory)) !== canonical(directory)) {
        throw new Error('Native source directory changed.');
      }
      directories.push([directory, stat]);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const assertCurrent = async () => {
      const named = await fs.lstat(file, { bigint: true });
      if (named.isSymbolicLink() || !same(opened, named) || !same(opened, await handle.stat({ bigint: true }))) {
        throw new Error('Native source file changed.');
      }
      for (const [name, identity] of directories) {
        const current = await fs.lstat(name, { bigint: true });
        // Other records may be published in a parent directory concurrently.
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
          || current.mode !== identity.mode || current.uid !== identity.uid || current.gid !== identity.gid
          || canonical(await fs.realpath(name)) !== canonical(name)) throw new Error('Native source directory changed.');
      }
    };
    await assertCurrent();
    buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (BigInt(length) !== opened.size) throw new Error('Native source file changed.');
    await assertCurrent();
    admitted = true;
    return buffer.subarray(0, length);
  } finally {
    if (!admitted) buffer?.fill(0);
    await handle.close();
  }
}

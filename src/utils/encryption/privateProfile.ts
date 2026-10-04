import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/utils/paths';
import { DEFAULT_PASSWORD } from './format';

const MAX_PASSPHRASE_BYTES = 1024;

/** No plaintext secret is accepted through an environment variable. */
export function hasOperatorPassphrase(): boolean {
  return process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE !== undefined;
}

export function isPrivatePassphrase(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && value !== DEFAULT_PASSWORD && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAX_PASSPHRASE_BYTES;
}

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalDataRoot(): Promise<string> {
  let directory = path.resolve(getDataDir());
  const missing: string[] = [];
  while (true) {
    try { return path.join(await fs.realpath(directory), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
      missing.push(path.basename(directory));
      directory = path.dirname(directory);
    }
  }
}

/**
 * Operator-owned file outside the complete data tree. POSIX ownership/mode are
 * enforced; Windows ACL and independent volume/secret-manager protection are
 * operator responsibilities. This is not an OS-keystore implementation.
 */
export async function readOperatorPassphrase(): Promise<string> {
  try {
    const configured = process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
    if (!configured || !path.isAbsolute(configured)) throw new Error();
    const file = path.resolve(configured);
    const canonical = await fs.realpath(file);
    const data = await canonicalDataRoot();
    const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(canonical) !== comparable(file) || contained(data, canonical)) throw new Error();
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_PASSPHRASE_BYTES + 2
        || (process.platform !== 'win32' && ((before.mode & 0o077) !== 0
          || (process.getuid && before.uid !== process.getuid())))) throw new Error();
    const handle = await fs.open(file, 'r');
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
      const buffer = Buffer.alloc(MAX_PASSPHRASE_BYTES + 3);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, result.bytesRead);
      const after = await fs.lstat(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs || after.mode !== before.mode || after.uid !== before.uid
          || after.nlink !== before.nlink
          || bytes.length !== before.size) throw new Error();
    } finally { await handle.close(); }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    if (!isPrivatePassphrase(value) || Buffer.byteLength(value, 'utf8') < 32
        || /[\r\n]/.test(value)) throw new Error();
    return value;
  } catch {
    // Never propagate filesystem paths, contents, decoder or parser diagnostics.
    throw new Error('Operator encryption secret is unavailable or invalid');
  }
}

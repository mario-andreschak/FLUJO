import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/utils/paths';
import { readStableFile } from '@/utils/readStableFile';
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
    const data = await canonicalDataRoot();
    const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const bytes = await readStableFile(file, MAX_PASSPHRASE_BYTES + 2, {
      validateOpenedFile: (stat, canonical) =>
        comparable(canonical) === comparable(file) && !contained(data, canonical)
        && stat.nlink === BigInt(1)
        && (process.platform === 'win32' || ((stat.mode & BigInt(0o077)) === BigInt(0)
          && (!process.getuid || stat.uid === BigInt(process.getuid())))),
    });
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    if (!isPrivatePassphrase(value) || Buffer.byteLength(value, 'utf8') < 32
        || /[\r\n]/.test(value)) throw new Error();
    return value;
  } catch {
    // Never propagate filesystem paths, contents, decoder or parser diagnostics.
    throw new Error('Operator encryption secret is unavailable or invalid');
  }
}

import path from 'node:path';
import { readStableFileSync } from '../../../utils/readStableFileSync';

export const MAX_PRIVATE_POLICY_BYTES = 64 * 1024;

/** Return policy bytes only after private-file admission and unchanged descriptor/name checks. */
export function readPrivatePolicyJson(filename: string | undefined): unknown {
  try {
    if (filename === undefined || !path.isAbsolute(filename.trim())) throw new Error('Invalid policy path');
    const bytes = readStableFileSync(filename.trim(), MAX_PRIVATE_POLICY_BYTES, {
      validateOpenedFile: stat => stat.nlink === BigInt(1) && (process.platform === 'win32'
        || ((stat.mode & BigInt(0o077)) === BigInt(0)
          && (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())))),
    });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch { throw new Error('Private policy read unavailable'); }
}

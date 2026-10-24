import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPrivateFile, readPrivateFile, syncPrivateDirectory } from './private-storage.js';

/** Caller owns the controller process lock. Keep incomplete candidates private
 * for recovery; publish only over the exact expected content (or absent file). */
export function publishPrivateFile(filename: string, contents: string | Buffer, expected?: Buffer): void {
  const candidate = join(dirname(filename), `.candidate-${randomBytes(16).toString('hex')}`);
  const fd = createPrivateFile(candidate);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  if (expected ? !readPrivateFile(filename).equals(expected) : existsSync(filename)) {
    throw new Error('Private configuration changed during publication.');
  }
  renameSync(candidate, filename);
  syncPrivateDirectory(dirname(filename));
}

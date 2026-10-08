import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '@/utils/readPlainFile';

async function actual(filename: string, signal?: AbortSignal) {
  return readPlainFile(filename, { signal, maxBytes: 1024 * 1024, verifyPath: async () => {
    const fs = await import('node:fs/promises');
    let parent = path.dirname(filename);
    for (;;) {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked npm evidence parent');
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
  } });
}
/** Actual installed distribution identity and license bytes. Whole directory
 * and dependency-file closure is separately captured by the lookup witnesses.
 * Neither a manifest version nor a license hash establishes registry origin.
 */
export async function inspectPackageRunnerNpmEvidence(root: string, signal?: AbortSignal) {
  if (!path.isAbsolute(root)) throw new Error('npm distribution root is not absolute');
  const manifestBytes = await actual(path.join(root, 'package.json'), signal);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  const execBytes = await actual(path.join(root, 'node_modules', 'libnpmexec', 'package.json'), signal);
  const exec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(execBytes));
  if (manifest.name !== 'npm' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
      || manifest.bin?.npx !== 'bin/npx-cli.js' || exec.name !== 'libnpmexec'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exec.version)) throw new Error('Unsupported npm distribution identity');
  const licenseBytes = await actual(path.join(root, 'LICENSE'), signal);
  const license = new TextDecoder('utf-8', { fatal: true }).decode(licenseBytes);
  if (!license.trim()) throw new Error('npm distribution license is missing');
  return Object.freeze({ npmVersion: manifest.version as string, libnpmexecVersion: exec.version as string,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    execManifestSha256: createHash('sha256').update(execBytes).digest('hex'),
    licenseSha256: createHash('sha256').update(licenseBytes).digest('hex') });
}

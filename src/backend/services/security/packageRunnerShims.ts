import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '@/utils/readPlainFile';
import { buildControlledNpmExecRevision } from './packageRunnerControlledNpm';

function quoted(filename: string) {
  if (!path.isAbsolute(filename) || /[\0\r\n"'`$%!&|<>^]/.test(filename)) throw new Error('Unsafe fixed runner shim path');
  return '"' + filename + '"';
}
/** Exact Windows launcher/bin code, without npm-prefix or Node PATH fallback.
 * Merely returning these strings does not stage, approve, or execute them.
 */
export function fixedPackageRunnerShimSources(node: string, npmRoot: string, packageBin: string) {
  if (process.platform !== 'win32') throw new Error('Fixed Windows runner shims require Windows');
  return {
    launcher: `@echo off\r\nsetlocal\r\n${quoted(node)} ${quoted(path.join(npmRoot, 'bin', 'npx-cli.js'))} %*\r\nexit /b %errorlevel%\r\n`,
    bin: `@echo off\r\nsetlocal\r\n${quoted(node)} ${quoted(packageBin)} %*\r\nexit /b %errorlevel%\r\n`,
  };
}
async function actual(filename: string, signal?: AbortSignal) {
  return readPlainFile(filename, { maxBytes: 128 * 1024, signal, verifyPath: async () => {
    const fs = await import('node:fs/promises');
    let parent = path.dirname(filename);
    for (;;) {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked controlled runner asset parent');
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
  } });
}

/** Verify real staged bytes against recomputed fixed shims and an explicitly
 * controlled npm revision. This remains inspection evidence, not a grant.
 */
export async function inspectControlledPackageRunnerAssets(input: {
  node: string; npmRoot: string; upstreamNpmRoot: string; launcher: string;
  packageBin: string; binShim: string; binName: string; cwd: string; packageName: string; version: string;
}, signal?: AbortSignal): Promise<string> {
  if (path.basename(input.launcher).toLowerCase() !== 'npx.cmd') throw new Error('Original npx launcher identity is required');
  const shims = fixedPackageRunnerShimSources(input.node, input.npmRoot, input.packageBin);
  const revision = await buildControlledNpmExecRevision(input.upstreamNpmRoot, input, signal);
  const expected = [
    [input.launcher, shims.launcher], [input.binShim, shims.bin],
    [path.join(input.npmRoot, 'node_modules', 'libnpmexec', 'lib', 'index.js'), revision.source],
  ];
  for (const [filename, content] of expected) {
    if (!(await actual(filename, signal)).equals(Buffer.from(content, 'utf8'))) throw new Error('Actual controlled runner asset differs from fixed reviewed code');
  }
  // The retained npx entrypoint must be actual upstream CLI bytes, not a direct
  // package/Node replacement behind a launcher named npx.
  const upstreamCli = await actual(path.join(input.upstreamNpmRoot, 'bin', 'npx-cli.js'), signal);
  const stagedCli = await actual(path.join(input.npmRoot, 'bin', 'npx-cli.js'), signal);
  if (!upstreamCli.equals(stagedCli)) throw new Error('Staged npx CLI differs from upstream CLI');
  return createHash('sha256').update(JSON.stringify({ revision,
    cli: createHash('sha256').update(stagedCli).digest('hex'), shims })).digest('hex');
}

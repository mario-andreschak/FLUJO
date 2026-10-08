import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '@/utils/readPlainFile';

export interface ControlledNpmResolution {
  cwd: string;
  packageName: string;
  version: string;
  binName: string;
  binShim: string;
}
/** Produce a reviewable, explicitly modified npm resolver revision. It keeps
 * npm's npx CLI, local Arborist and run-script execution, but removes resolver
 * fallback/fetch/reify paths. This is NOT an unmodified-npm acceptance receipt,
 * a grant, a staged executable, or a production launch integration.
 */
export async function buildControlledNpmExecRevision(npmRoot: string, input: ControlledNpmResolution,
  signal?: AbortSignal): Promise<{ source: string; upstreamSha256: string; controlledSha256: string }> {
  if (!path.isAbsolute(npmRoot) || !path.isAbsolute(input.cwd) || !path.isAbsolute(input.binShim)
      || [input.cwd, input.binShim].some(value => /[\0\r\n"'`$%!&|<>^]/.test(value))
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input.packageName)
      || !/^[a-z0-9][a-z0-9._-]*$/.test(input.binName)
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error('Invalid controlled npm resolution');
  }
  const shimRoot = path.join(input.cwd, 'node_modules', '.bin');
  if (path.dirname(input.binShim) !== shimRoot || ![input.binName, `${input.binName}.cmd`].includes(path.basename(input.binShim))) {
    throw new Error('Controlled npm bin is not the exact local shim');
  }
  const filename = path.join(npmRoot, 'node_modules', 'libnpmexec', 'lib', 'index.js');
  const bytes = await readPlainFile(filename, { maxBytes: 128 * 1024, signal, verifyPath: async () => {
    const fs = await import('node:fs/promises');
    let parent = path.dirname(filename);
    for (;;) {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked npm resolver source parent');
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
  } });
  const original = bytes.toString('utf8');
  let source = original;
  function replaceOnce(before: string, after: string) {
    if (source.split(before).length !== 2) throw new Error('Unsupported npm resolver revision; exact anchor unavailable');
    source = source.replace(before, after);
  }
  replaceOnce('const exec = async (opts) => {', `const exec = async (opts) => {
  if (opts.call || (opts.packages && opts.packages.length) || !Array.isArray(opts.args) ||
      opts.args.length !== 1 || opts.args[0] !== ${JSON.stringify(input.packageName)} ||
      require('node:path').resolve(opts.path || '.') !== ${JSON.stringify(input.cwd)} ||
      require('node:path').resolve(opts.runPath || '.') !== ${JSON.stringify(input.cwd)}) {
    throw new Error('Controlled npx request differs from the reviewed original package request')
  }`);
  replaceOnce('const manifest = await pacote.manifest(spec, { ...flatOptions, preferOnline: true })',
    "const manifest = (() => { throw new Error('Controlled npx refuses manifest fetch/cache fallback') })()");
  replaceOnce('if (await hasPkgBin(p, args[0], flatOptions)) {', 'if (false) { // Controlled npx never substitutes a root/workspace package');
  replaceOnce("const localBinPath = await localFileExists(dir, args[0], '/')", 'const localBinPath = null // Ancestor command search is prohibited');
  replaceOnce('} else if (globalPath && await fileExists(`${globalBin}/${args[0]}`)) {',
    '} else if (false) { // Global command substitution is prohibited');
  replaceOnce('args[0] = getBinFromManifest(commandManifest)', `if (!commandManifest || commandManifest.name !== ${JSON.stringify(input.packageName)} ||
        commandManifest.version !== ${JSON.stringify(input.version)} ||
        getBinFromManifest(commandManifest) !== ${JSON.stringify(input.binName)} || needInstall.length) {
      throw new Error('Controlled npx local package identity/bin differs from the reviewed closure')
    }
    args[0] = ${JSON.stringify('"' + input.binShim + '"')}`);
  replaceOnce('if (needInstall.length > 0 && globalPath) {', 'if (false) { // Global package lookup is prohibited');
  replaceOnce('if (needInstall.length > 0) {', "if (needInstall.length > 0) {\n    throw new Error('Controlled npx refuses cache installation or reify')");
  return { source, upstreamSha256: createHash('sha256').update(bytes).digest('hex'),
    controlledSha256: createHash('sha256').update(source).digest('hex') };
}

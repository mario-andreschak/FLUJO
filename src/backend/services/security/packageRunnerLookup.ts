import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '@/utils/readPlainFile';

export interface PackageRunnerLookupRequest {
  cwd: string;
  home: string;
  globalBin: string;
  cache: string;
  npmRoot: string;
  configFiles: readonly string[];
}
export interface PackageRunnerLookupWitness {
  readonly sha256: string;
  readonly files: number;
  readonly bytes: number;
}
const prepared = new WeakMap<object, { request: PackageRunnerLookupRequest; sha256: string }>();

/** Observe actual local/ancestor/global bin trees, npm source, cache and config.
 * No resolver is invoked and no launch authority is conferred. The protected
 * stage/native authority and resolver-version-specific interpretation remain
 * mandatory in the grant integration. Missing paths are witnessed explicitly.
 */
export async function preparePackageRunnerLookup(input: PackageRunnerLookupRequest,
  signal?: AbortSignal): Promise<PackageRunnerLookupWitness> {
  const request = { ...input, configFiles: [...input.configFiles] };
  if (request.configFiles.length > 8 || Object.values(request).some(value => typeof value === 'string'
      && (!path.isAbsolute(value) || value.includes('\0')))
      || request.configFiles.some(value => !path.isAbsolute(value) || value.includes('\0'))) {
    throw new Error('Invalid bounded npm lookup request');
  }
  const targets = new Set([request.npmRoot, request.globalBin, request.cache, ...request.configFiles,
    path.join(request.home, '.npmrc'), path.join(request.cwd, 'package.json'), path.join(request.cwd, '.npmrc')]);
  let ancestor = path.resolve(request.cwd);
  for (;;) {
    targets.add(path.join(ancestor, 'node_modules', '.bin'));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let files = 0;
  let bytes = 0;
  const records: Array<[string, string]> = [];
  async function parents(filename: string) {
    let directory = path.dirname(filename);
    for (;;) {
      try {
        const stat = await fs.lstat(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked npm lookup parent');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  async function visit(filename: string) {
    signal?.throwIfAborted();
    if (++files > 32_768) throw new Error('npm lookup member bound exceeded');
    await parents(filename);
    let before;
    try { before = await fs.lstat(filename, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      records.push([filename, 'absent']);
      await parents(filename);
      return;
    }
    if (before.isSymbolicLink()) throw new Error('Linked npm lookup member');
    if (before.isDirectory()) {
      const names = (await fs.readdir(filename)).sort();
      records.push([filename, JSON.stringify(names)]);
      for (const name of names) await visit(path.join(filename, name));
      const after = await fs.lstat(filename, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs || JSON.stringify(names) !== JSON.stringify((await fs.readdir(filename)).sort())) {
        throw new Error('npm lookup directory changed');
      }
      return;
    }
    if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(512 * 1024 * 1024 - bytes)) {
      throw new Error('Unsafe or oversized npm lookup member');
    }
    const hash = createHash('sha256');
    await readPlainFile(filename, { expected: before, signal, maxBytes: 512 * 1024 * 1024 - bytes,
      verifyPath: () => parents(filename), consume: async chunk => { hash.update(chunk); } });
    bytes += Number(before.size);
    records.push([filename, hash.digest('hex')]);
  }
  for (const target of [...targets].sort()) await visit(path.resolve(target));
  const sha256 = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const witness = Object.freeze({ sha256, files, bytes });
  prepared.set(witness, { request, sha256 });
  return witness;
}

export async function revalidatePackageRunnerLookup(witness: PackageRunnerLookupWitness, signal?: AbortSignal) {
  const original = prepared.get(witness);
  if (!original) throw new Error('npm lookup witness was not prepared in this process');
  if ((await preparePackageRunnerLookup(original.request, signal)).sha256 !== original.sha256) {
    throw new Error('Actual npm lookup state changed');
  }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '@/utils/readPlainFile';
import { verifyPackageRunnerArtifact } from './packageRunnerArtifact';

const MAX_FILES = 16_384;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
const prepared = new WeakMap<object, { root: string; packageName: string; witness: string;
  artifactFiles?: Readonly<Record<string, string>> }>();
export interface ResolvedPackageTree {
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly packageRoot: string;
  readonly bin: string;
  readonly treeSha256: string;
  readonly lockfileSha256: string;
  readonly dependencyGraphSha256: string;
  readonly artifactsVerified: boolean;
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function descendant(root: string, filename: string) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Package member escapes its owned tree');
  }
}
async function parents(filename: string) {
  let directory = path.dirname(filename);
  for (;;) {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Package parent is not a plain directory');
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

/** Actual bounded filesystem witness only: never grants consent or launches npm.
 * N's native protected-stage/issuer gate must additionally admit the stage,
 * npm/launcher/config/lookup closure and rebind this object before any effect.
 */
export async function prepareResolvedPackageTree(rootInput: string, packageName: string,
  signal?: AbortSignal, artifactInput?: Readonly<Record<string, string>>): Promise<ResolvedPackageTree> {
  const artifactFiles = artifactInput && Object.freeze({ ...artifactInput });
  if (!path.isAbsolute(rootInput) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error('Invalid isolated package resolution request');
  }
  const root = path.resolve(rootInput);
  await parents(path.join(root, 'package-lock.json'));
  let count = 0;
  let total = 0;
  const records: Array<[string, string]> = [];
  const metadata = new Map<string, Buffer>();
  async function walk(directory: string) {
    signal?.throwIfAborted();
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Linked package directory');
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      if (++count > MAX_FILES) throw new Error('Package closure exceeds member bound');
      const filename = path.join(directory, name);
      descendant(root, filename);
      const stat = await fs.lstat(filename, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) { await walk(filename); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) throw new Error('Non-plain package member');
      if (stat.size > BigInt(MAX_BYTES - total)) throw new Error('Package closure exceeds byte bound');
      const hash = createHash('sha256');
      const relative = path.relative(root, filename).split(path.sep).join('/');
      const capture = name === 'package.json' || relative === 'package-lock.json';
      if (capture && stat.size > BigInt(MAX_METADATA)) throw new Error('Package metadata exceeds bound');
      const bytes = await readPlainFile(filename, { expected: stat, maxBytes: MAX_BYTES - total, signal,
        verifyPath: () => parents(filename), ...(capture ? {} : { consume: async (chunk: Buffer) => { hash.update(chunk); } }) });
      total += Number(stat.size);
      records.push([relative, capture ? sha(bytes) : hash.digest('hex')]);
      if (capture) metadata.set(relative, bytes);
    }
    const after = await fs.lstat(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || JSON.stringify(names) !== JSON.stringify((await fs.readdir(directory)).sort())) {
      throw new Error('Package directory changed during resolution');
    }
  }
  await walk(root);
  const lockBytes = metadata.get('package-lock.json');
  if (!lockBytes) throw new Error('Missing exact package lock');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new Error('Unsupported package lock');
  const packageKey = `node_modules/${packageName}`;
  const entry = lock.packages[packageKey];
  const packageBytes = metadata.get(`${packageKey}/package.json`);
  if (!packageBytes || !entry) throw new Error('Requested package is not installed locally');
  const manifest = JSON.parse(packageBytes.toString('utf8'));
  const graph: Array<[string, string, string]> = [];
  for (const [key, raw] of Object.entries(lock.packages)) {
    if (key === '') continue;
    const node = raw as Record<string, unknown>;
    if (!key.startsWith('node_modules/') || key.split('/').some(part => !part || part === '.' || part === '..')
        || node.link || typeof node.version !== 'string' || typeof node.integrity !== 'string'
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(node.integrity)) throw new Error('Unpinned or linked dependency');
    const installed = metadata.get(`${key}/package.json`);
    if (!installed || JSON.parse(installed.toString('utf8')).version !== node.version) throw new Error('Dependency differs from lock');
    graph.push([key, node.version, node.integrity]);
  }
  for (const key of metadata.keys()) {
    if (/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/.test(key)
        && !lock.packages[key.slice(0, -'/package.json'.length)]) throw new Error('Unrecorded installed package');
  }
  if (artifactFiles) {
    const packageKeys = graph.map(([key]) => key).sort((a, b) => b.length - a.length);
    if (Object.keys(artifactFiles).length !== packageKeys.length
        || packageKeys.some(key => !artifactFiles[key])) throw new Error('Incomplete exact dependency artifact set');
    for (const key of packageKeys) {
      const owned = new Map(records.filter(([member]) => member.startsWith(key + '/')
        && packageKeys.find(candidate => member.startsWith(candidate + '/')) === key)
        .map(([member, digest]) => [member.slice(key.length + 1), digest]));
      await verifyPackageRunnerArtifact(artifactFiles[key], lock.packages[key].integrity, owned, signal);
    }
  }
  if (manifest.name !== packageName || manifest.version !== entry.version) throw new Error('Package identity differs from lock');
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  if (bins.length !== 1 || typeof bins[0] !== 'string') throw new Error('Ambiguous package bin');
  const packageRoot = path.join(root, ...packageKey.split('/'));
  const bin = path.resolve(packageRoot, bins[0]); descendant(packageRoot, bin);
  if (!records.some(([key]) => key === path.relative(root, bin).split(path.sep).join('/'))) throw new Error('Missing package bin');
  const result = Object.freeze({ packageName, version: manifest.version as string, integrity: entry.integrity as string,
    packageRoot, bin, treeSha256: sha(JSON.stringify(records.sort(([a], [b]) => a.localeCompare(b)))),
    lockfileSha256: sha(lockBytes), dependencyGraphSha256: sha(JSON.stringify(graph.sort(([a], [b]) => a.localeCompare(b)))),
    artifactsVerified: artifactFiles !== undefined });
  prepared.set(result, { root, packageName, witness: JSON.stringify(result), artifactFiles });
  return result;
}

/** Reject caller-built/hash-only objects and observe actual files again. */
export async function revalidateResolvedPackageTree(value: ResolvedPackageTree, signal?: AbortSignal): Promise<void> {
  const original = prepared.get(value);
  if (!original) throw new Error('Package resolution was not prepared in this process');
  const fresh = await prepareResolvedPackageTree(original.root, original.packageName, signal, original.artifactFiles);
  if (JSON.stringify(fresh) !== original.witness) throw new Error('Prepared package closure changed');
}

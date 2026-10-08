import fs, { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';

const MAX_FILES = 16_384;
const MAX_BYTES = 256 * 1024 * 1024;
const dependencyName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function linkFree(filename: string): Promise<void> {
  const resolved = path.resolve(filename), actual = await fs.promises.realpath(filename);
  const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (canonical(actual) !== canonical(resolved)) throw new Error('Linked installation asset refused.');
}

function same(first: fs.BigIntStats, second: fs.BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs && first.mode === second.mode;
}

async function settledBatch<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/** Drain independent metadata reads before reporting the original ordered refusal. */
async function checkpoint(filename: string, identity: fs.BigIntStats, handle?: FileHandle, length?: number,
  refusal = 'Dependency asset changed.'): Promise<void> {
  const results = await Promise.allSettled([
    linkFree(filename),
    ...(handle ? [handle.stat({ bigint: true })] : []),
    fs.promises.lstat(filename, { bigint: true }),
  ]);
  const canonical = results[0];
  if (canonical.status === 'rejected') throw canonical.reason;
  if (length !== undefined && BigInt(length) !== identity.size) throw new Error(refusal);
  for (const result of results.slice(1)) {
    if (result.status === 'rejected') throw result.reason;
    if (!result.value || !same(identity, result.value)) throw new Error(refusal);
  }
  // Parallel observations may precede the final canonical-path yield. Reread
  // every identity after all operations settle, without another await between
  // the descriptor and named-file observations and the caller's publication.
  if (handle && !same(identity, fs.fstatSync(handle.fd, { bigint: true }))) throw new Error(refusal);
  if (!same(identity, fs.lstatSync(filename, { bigint: true }))) throw new Error(refusal);
}

/** Declared dependency inspection only: never loads package code or conveys consent. */
export async function inspectBundledMcpDependencyGraph(installationRoot: string, initialDirectories: readonly string[], signal?: AbortSignal) {
  const installation = await fs.promises.realpath(installationRoot);
  await linkFree(installation);
  const pending = [...initialDirectories];
  const visited = new Set<string>();
  const packages: Array<{ directory: string; digest: string }> = [];
  const edges: Array<{ from: string; name: string; to: string }> = [];
  const identities = new Map<string, fs.BigIntStats>();
  let members = 0, bytes = 0;
  const live = () => { if (signal?.aborted) throw new Error('Dependency inspection cancelled.'); };
  const read = async (filename: string, maximum: number, hashOnly = false): Promise<{ content?: Buffer; digest: string }> => {
    live();
    const handle = await fs.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash('sha256');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(maximum)) throw new Error('Dependency asset exceeds its bounds.');
      const previous = identities.get(filename);
      if (previous && !same(previous, before)) throw new Error('Dependency asset changed between reads.');
      await checkpoint(filename, before);
      let length = 0;
      while (true) {
        live();
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
        if (length > maximum) throw new Error('Dependency asset exceeds its bounds.');
        hash.update(buffer.subarray(0, result.bytesRead));
        if (!hashOnly) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      }
      await checkpoint(filename, before, handle, length);
      identities.set(filename, before);
      return { content: hashOnly ? undefined : Buffer.concat(chunks), digest: hash.digest('hex') };
    } finally { buffer.fill(0); for (const chunk of chunks) chunk.fill(0); await handle.close(); }
  };
  while (pending.length) {
    live();
    const directory = await fs.promises.realpath(pending.shift()!);
    if (!within(installation, directory)) throw new Error('Dependency resolves outside the inspected installation.');
    if (visited.has(directory)) continue;
    visited.add(directory);
    if (visited.size > 256) throw new Error('Dependency graph exceeds its package bound.');
    await linkFree(directory);
    const manifestFile = path.join(directory, 'package.json');
    const manifestRead = await read(manifestFile, 64 * 1024);
    const manifestBytes = manifestRead.content!;
    const manifestDigest = manifestRead.digest;
    let manifest: { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown> };
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
    finally { manifestBytes.fill(0); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid dependency manifest.');
    for (const fields of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      if (fields !== undefined && (!fields || typeof fields !== 'object' || Array.isArray(fields)
          || Object.values(fields).some(value => typeof value !== 'string' || value.length > 2048))) throw new Error('Invalid dependency declarations.');
    }
    const tree = createHash('sha256').update('flujo:mcp:installed-dependency:v1\0');
    const walk = async (current: string): Promise<void> => {
      live();
      if (++members > MAX_FILES) throw new Error('Dependency graph exceeds its member bound.');
      await linkFree(current);
      const before = await fs.promises.lstat(current, { bigint: true });
      if (!before.isDirectory()) throw new Error('Dependency directory refused.');
      identities.set(current, before);
      tree.update(JSON.stringify(['directory', path.relative(directory, current), String(before.mode)]));
      // Files in each directory use bounded parallel I/O; digest order remains
      // the same sorted depth-first order. Every started read settles on refusal.
      const names = (await fs.promises.readdir(current)).sort().filter(name => name !== 'node_modules');
      for (let offset = 0; offset < names.length; offset += 16) {
        const entries = await settledBatch(names.slice(offset, offset + 16).map(async name => {
          live();
          const filename = path.join(current, name), stat = await fs.promises.lstat(filename, { bigint: true });
          if (stat.isDirectory() && !stat.isSymbolicLink()) return { filename, stat, digest: undefined };
          if (++members > MAX_FILES || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Dependency member refused.');
          // Reserve the complete observed size before yielding to another read.
          const length = Number(stat.size);
          bytes += length;
          if (bytes > MAX_BYTES) throw new Error('Dependency graph exceeds its byte bound.');
          const { digest } = await read(filename, length, true);
          if (!same(stat, identities.get(filename)!)) throw new Error('Dependency member changed before reading.');
          if (filename === manifestFile && digest !== manifestDigest) throw new Error('Parsed dependency manifest differs from the fingerprinted manifest.');
          return { filename, stat, digest };
        }));
        for (const entry of entries) {
          if (entry.digest === undefined) await walk(entry.filename);
          else tree.update(JSON.stringify(['file', path.relative(directory, entry.filename), String(entry.stat.mode), entry.digest]));
        }
      }
      await linkFree(current);
      if (!same(before, await fs.promises.lstat(current, { bigint: true }))) throw new Error('Dependency directory changed.');
    };
    await walk(directory);
    packages.push({ directory, digest: tree.digest('hex') });
    const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
    const resolver = nativeCreateRequire(manifestFile);
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    if (names.size > 128) throw new Error('Dependency manifest exceeds its name bound.');
    for (const name of [...names].sort()) {
      if (!dependencyName.test(name)) throw new Error('Invalid dependency name.');
      let target: string | undefined;
      for (const candidate of resolver.resolve.paths(name) ?? []) {
        try { target = await fs.promises.realpath(path.join(candidate, name)); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!target) {
        if (Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, name)) throw new Error('Required installation dependency missing.');
        continue;
      }
      if (!within(installation, target)) throw new Error('Dependency resolves outside the inspected installation.');
      edges.push({ from: directory, name, to: target }); pending.push(target);
    }
  }
  live();
  const observed = [...identities];
  for (let offset = 0; offset < observed.length; offset += 32) {
    await settledBatch(observed.slice(offset, offset + 32).map(async ([filename, identity]) => {
      live(); await checkpoint(filename, identity, undefined, undefined, 'Installation changed during dependency inspection.');
    }));
  }
  packages.sort((a, b) => a.directory.localeCompare(b.directory));
  edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { installation, packages, edges, digest: createHash('sha256').update(JSON.stringify({ domain: 'flujo:mcp:installed-dependency-graph:v1', installation, packages, edges })).digest('hex') };
}

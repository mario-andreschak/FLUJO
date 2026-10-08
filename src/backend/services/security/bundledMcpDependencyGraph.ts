import fs, { constants } from 'node:fs';
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
  const read = async (filename: string, maximum: number): Promise<Buffer> => {
    live();
    const handle = await fs.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const chunks: Buffer[] = [];
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(maximum)) throw new Error('Dependency asset exceeds its bounds.');
      const previous = identities.get(filename);
      if (previous && !same(previous, before)) throw new Error('Dependency asset changed between reads.');
      await linkFree(filename);
      if (!same(before, await fs.promises.lstat(filename, { bigint: true }))) throw new Error('Dependency asset changed.');
      let length = 0;
      while (true) {
        live();
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const result = await handle.read(chunk, 0, chunk.length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
        if (length > maximum) throw new Error('Dependency asset exceeds its bounds.');
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      await linkFree(filename);
      if (BigInt(length) !== before.size || !same(before, await handle.stat({ bigint: true }))
          || !same(before, await fs.promises.lstat(filename, { bigint: true }))) throw new Error('Dependency asset changed.');
      identities.set(filename, before);
      return Buffer.concat(chunks);
    } finally { for (const chunk of chunks) chunk.fill(0); await handle.close(); }
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
    const manifestBytes = await read(manifestFile, 64 * 1024);
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
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
      for (const name of (await fs.promises.readdir(current)).sort()) {
        // Runtime resolution of declared dependencies is separately pinned below.
        if (name === 'node_modules') continue;
        const filename = path.join(current, name), stat = await fs.promises.lstat(filename, { bigint: true });
        if (stat.isDirectory() && !stat.isSymbolicLink()) { await walk(filename); continue; }
        if (++members > MAX_FILES || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Dependency member refused.');
        const content = await read(filename, MAX_BYTES - bytes);
        try {
          const digest = createHash('sha256').update(content).digest('hex');
          if (filename === manifestFile && digest !== manifestDigest) throw new Error('Parsed dependency manifest differs from the fingerprinted manifest.');
          bytes += content.length; tree.update(JSON.stringify(['file', path.relative(directory, filename), String(stat.mode), digest]));
        }
        finally { content.fill(0); }
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
  for (const [filename, identity] of identities) {
    live(); await linkFree(filename);
    if (!same(identity, await fs.promises.lstat(filename, { bigint: true }))) throw new Error('Installation changed during dependency inspection.');
  }
  packages.sort((a, b) => a.directory.localeCompare(b.directory));
  edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { installation, packages, edges, digest: createHash('sha256').update(JSON.stringify({ domain: 'flujo:mcp:installed-dependency-graph:v1', installation, packages, edges })).digest('hex') };
}

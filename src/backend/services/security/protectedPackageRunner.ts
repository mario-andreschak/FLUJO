import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const absolute = z.string().min(1).max(2048).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const exactVersion = z.string().max(256).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/);
/** Only a previously materialized local closure is eligible; this is not installer authority. */
export const protectedPackageRunnerSchema = z.object({
  packageName: z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  packageVersion: exactVersion,
  npmVersion: exactVersion,
  packageDirectory: absolute,
  binaryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  shell: absolute,
  shellDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProtectedPackageRunner = z.infer<typeof protectedPackageRunnerSchema>;

function contained(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function equal(a: string, b: string): boolean {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}
export function assertPackageRunnerDeclaration(input: {
  sourceRoot: string; entryPoint: string; command: string; cwd: string; args: string[];
  runner: ProtectedPackageRunner; environment: ReadonlyMap<string, string>;
}): void {
  const { sourceRoot, entryPoint, command, cwd, args, runner, environment } = input;
  if (!contained(sourceRoot, runner.packageDirectory) || !contained(sourceRoot, runner.shell)
      || !contained(sourceRoot, entryPoint) || path.basename(entryPoint) !== 'npx-cli.js'
      || path.basename(path.dirname(entryPoint)) !== 'bin' || contained(sourceRoot, cwd) || equal(sourceRoot, cwd)
      || !/^node(?:\.exe)?$/i.test(path.basename(command))
      || args[0] !== '-y' || args[1] !== `${runner.packageName}@${runner.packageVersion}`) throw new Error('Invalid package runner declaration');
  for (const [name] of environment) {
    if (/^npm_config_/i.test(name) && name.toUpperCase() !== 'NPM_CONFIG_CACHE') throw new Error('Ambient npm configuration is forbidden');
  }
  const selected = (name: string) => [...environment].find(([key]) => key.toUpperCase() === name)?.[1];
  if (!selected('NPM_CONFIG_CACHE') || !path.isAbsolute(selected('NPM_CONFIG_CACHE')!)) throw new Error('Declare the package runner cache');
  if (process.platform === 'win32' && (selected('COMSPEC') !== runner.shell || selected('PATHEXT') !== '.COM;.EXE;.BAT;.CMD')) {
    throw new Error('Declare the reviewed Windows shell and extensions');
  }
  const expectedPath = [path.join(runner.packageDirectory, 'node_modules', '.bin'), path.dirname(command)].join(path.delimiter);
  if (selected('PATH') !== expectedPath) throw new Error('Declare only the reviewed package and Node binary paths');
}

function readJson(filename: string): Record<string, unknown> {
  const assertPath = () => {
    for (let current = path.resolve(filename); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked package manifest path');
      if (path.dirname(current) === current) break;
    }
    if (!equal(fs.realpathSync(filename), filename)) throw new Error('Retargeted package manifest');
  };
  assertPath();
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let bytes: Buffer | undefined;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(1024 * 1024)) throw new Error('Invalid package manifest');
    bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (BigInt(offset) !== before.size) throw new Error('Manifest changed while reading');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filename, { bigint: true });
    assertPath();
    if (current.isSymbolicLink() || !current.isFile()
        || !(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const)
          .every(field => before[field] === after[field] && before[field] === current[field])) throw new Error('Manifest changed');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid package manifest');
    return value as Record<string, unknown>;
  } finally { bytes?.fill(0); fs.closeSync(descriptor); }
}

/** npm prepends the working directory and EVERY ancestor's .bin to PATH.
 * --prefix does not fence these candidates. They must stay absent at admission.
 * This is host consent and fresh resolution checking, not an OS containment claim. */
export function assertPackageRunnerResolution(sourceRoot: string, entryPoint: string, cwd: string, runner: ProtectedPackageRunner,
  runtime?: { command: string; home: string }) {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink() || !equal(fs.realpathSync(current), current)) throw new Error('Unsafe package runner working directory');
    for (const candidate of [path.join(current, 'node_modules', '.bin')]) {
      try { fs.lstatSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('Unreviewed npm ancestor resolution candidate');
    }
    if (path.dirname(current) === current) break;
  }
  const npm = readJson(path.join(path.dirname(path.dirname(entryPoint)), 'package.json'));
  if (npm.name !== 'npm' || npm.version !== runner.npmVersion) throw new Error('npm revision changed');
  const projectConfig = path.join(runner.packageDirectory, '.npmrc');
  try {
    const stat = fs.lstatSync(projectConfig);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw new Error('Unreviewed project npm configuration');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const config of ['runner-user.npmrc', 'runner-global.npmrc']) {
    const file = path.join(sourceRoot, config);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw new Error('npm control file changed');
  }
  const packageRoot = path.join(runner.packageDirectory, 'node_modules', ...runner.packageName.split('/'));
  const project = readJson(path.join(runner.packageDirectory, 'package.json'));
  if (project.bin !== undefined || project.workspaces !== undefined) throw new Error('Installation project may not redirect npm binary selection');
  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (manifest.name !== runner.packageName || manifest.version !== runner.packageVersion) throw new Error('Package revision changed');
  const bins = manifest.bin;
  const bin = typeof bins === 'string' && runner.binaryName === runner.packageName.split('/').at(-1) ? bins
    : bins && typeof bins === 'object' && !Array.isArray(bins) ? (bins as Record<string, unknown>)[runner.binaryName] : undefined;
  if (typeof bin !== 'string' || !contained(packageRoot, path.resolve(packageRoot, bin))) throw new Error('Package binary changed');
  const normalizedBins = typeof bins === 'string' ? { [runner.packageName.split('/').at(-1)!]: bins }
    : bins as Record<string, unknown>;
  const selectedBin = new Set(Object.values(normalizedBins)).size === 1 ? Object.keys(normalizedBins)[0]
    : normalizedBins[runner.packageName.split('/').at(-1)!] ? runner.packageName.split('/').at(-1) : undefined;
  if (selectedBin !== runner.binaryName) throw new Error('npm binary selection differs from the reviewed binary');
  const file = path.join(runner.packageDirectory, 'node_modules', '.bin', runner.binaryName + (process.platform === 'win32' ? '.cmd' : ''));
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Materialize the reviewed package binary shim');
  return assertPackageRuntimeClosure(sourceRoot, [path.dirname(path.dirname(entryPoint)), runner.packageDirectory], runtime);
}

/** Inspect declarations without requiring package code. A complete byte tree
 * cannot substitute for a complete local runtime dependency graph. */
function assertPackageRuntimeClosure(sourceRoot: string, roots: string[], runtime?: { command: string; home: string }) {
  const manifests = new Map<string, Record<string, unknown>>();
  const visited = new Set<string>();
  const inventory: Array<{ directory: string; name: string; version: string; dependencies: Array<{
    name: string; target: string; optional: boolean; directory: string | null;
  }> }> = [];
  let edges = 0;
  const manifestAt = (directory: string) => {
    let manifest = manifests.get(directory);
    if (!manifest) {
      if (manifests.size >= 1024) throw new Error('Package graph exceeds inspection bounds');
      manifest = readJson(path.join(directory, 'package.json'));
      if (typeof manifest.name !== 'string' || manifest.name.length > 214 || !exactVersion.safeParse(manifest.version).success) throw new Error('Package graph revision unavailable');
      manifests.set(directory, manifest);
    }
    return manifest;
  };
  const exists = (filename: string) => {
    try { fs.lstatSync(filename); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const visit = (directory: string): void => {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = manifestAt(directory);
    const node = { directory: path.relative(sourceRoot, directory).split(path.sep).join('/'),
      name: manifest.name as string, version: manifest.version as string,
      dependencies: [] as Array<{ name: string; target: string; optional: boolean; directory: string | null }> };
    inventory.push(node);
    const requested = new Map<string, { optional: boolean; target: string }>();
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const values = manifest[field];
      if (values === undefined) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 256) throw new Error('Invalid package dependencies');
      for (const [name, spec] of Object.entries(values)) {
        if (++edges > 8192 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
            || name.length > 214 || typeof spec !== 'string' || spec.length > 2048) throw new Error('Invalid package dependency declaration');
        const peerMeta = manifest.peerDependenciesMeta;
        const optionalPeer = field === 'peerDependencies' && peerMeta && typeof peerMeta === 'object'
          && (peerMeta as Record<string, { optional?: unknown }>)[name]?.optional === true;
        const alias = spec.startsWith('npm:') ? /^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(spec)?.[1] : undefined;
        if (spec.startsWith('npm:') && !alias) throw new Error('Invalid package alias');
        requested.set(name, { optional: field === 'optionalDependencies' || Boolean(optionalPeer), target: alias ?? name });
      }
    }
    const resolver = createRequire(path.join(directory, 'package.json'));
    for (const [name, declaration] of requested) {
      let selected: string | undefined;
      // Node's actual module-path ordering handles nested/scoped/hoisted trees.
      // Global paths are inspected below using the CHILD's reviewed Node/HOME.
      for (const candidateRoot of resolver.resolve.paths(name) ?? []) {
        if (path.basename(candidateRoot) !== 'node_modules') continue;
        if (!contained(sourceRoot, candidateRoot)) {
          if (exists(candidateRoot)) throw new Error('Ambient Node dependency directory');
          continue;
        }
        const candidate = path.join(candidateRoot, ...name.split('/'));
        if (['.js', '.json', '.node'].some(extension => exists(candidate + extension))) throw new Error('Package dependency redirected to an unreviewed file');
        if (!exists(candidate)) continue;
        selected = candidate;
        break;
      }
      if (!selected) {
        if (!declaration.optional) throw new Error(`Materialized runtime dependency missing: ${name}`);
        node.dependencies.push({ name, ...declaration, directory: null });
        continue;
      }
      if (manifestAt(selected).name !== declaration.target) throw new Error('Package dependency identity differs from its declaration');
      node.dependencies.push({ name, ...declaration, directory: path.relative(sourceRoot, selected).split(path.sep).join('/') });
      visit(selected);
    }
  };
  if (runtime) {
    const prefix = process.platform === 'win32' ? path.dirname(runtime.command) : path.dirname(path.dirname(runtime.command));
    const globals = [path.join(prefix, 'lib', 'node'), ...(runtime.home
      ? [path.join(runtime.home, '.node_modules'), path.join(runtime.home, '.node_libraries')] : [])];
    if (globals.some(directory => exists(directory))) throw new Error('Ambient global Node dependency directory');
  }
  for (const directory of roots) visit(directory);
  inventory.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);
  for (const node of inventory) node.dependencies.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { inventory, digest: createHash('sha256').update('flujo:mcp:local-npx-dependencies:v1\0').update(JSON.stringify(inventory)).digest('hex') };
}

export function packageRunnerArguments(sourceRoot: string, runner: ProtectedPackageRunner, entryPoint: string, args: readonly string[], cache: string): string[] {
  return [entryPoint, `--prefix=${runner.packageDirectory}`, '--offline', '--ignore-scripts', '--no-update-notifier', '--no-audit', '--no-fund', '--workspaces=false',
    `--userconfig=${path.join(sourceRoot, 'runner-user.npmrc')}`, `--globalconfig=${path.join(sourceRoot, 'runner-global.npmrc')}`,
    `--script-shell=${runner.shell}`, `--cache=${cache}`, ...args];
}

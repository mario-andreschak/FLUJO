import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as nodeModule from 'node:module';
import { SHIPPED_MCP_SERVERS, shippedMcpAppRoot } from './shippedServers';

// Application packages are templates. Copy only distributed code/build inputs,
// never a developer's node_modules, Git checkout, profile, or runtime userdata.
const PACKAGE_ASSETS = ['package.json', 'src', 'dist', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE'];
const PACKAGE_NAMES = new Set([...SHIPPED_MCP_SERVERS.map(item => item.packageDirectory), 'shared']);
const copiesInFlight = new Map<string, Promise<void>>();
const TEMPLATE_MARKER = '.flujo-template.json';

async function optionalStat(file: string) {
  return fs.lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
}

async function realDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Shipped package directory must not be a symlink or junction: ${directory}`);
  }
}

async function copyAsset(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Shipped package assets must not contain links: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination);
    for (const name of await fs.readdir(source)) {
      await copyAsset(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  } else {
    throw new Error(`Unsupported shipped package asset: ${source}`);
  }
}

async function packageDigest(root: string, runtimeOnly = false): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string, prefix: string) => {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!prefix && (['node_modules', '.git', TEMPLATE_MARKER].includes(name)
        || (runtimeOnly && !['package.json', 'dist', 'scripts'].includes(name)))) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('A copied package contains an unsupported linked asset.');
      if (stat.isDirectory()) {
        hash.update(`directory:${relative}\0`);
        await walk(file, relative);
      } else if (stat.isFile()) {
        hash.update(`file:${relative}\0${createHash('sha256').update(await fs.readFile(file)).digest('hex')}\0`);
      } else throw new Error('A copied package contains an unsupported asset.');
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

async function validatePackage(root: string, name: string): Promise<{ name: string; version?: string }> {
  await realDirectory(root);
  const manifestPath = path.join(root, 'package.json');
  const stat = await optionalStat(manifestPath);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Shipped package manifest is missing: ${name}`);
  let manifest: { name: string; version?: string };
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch { throw new Error(`Shipped package manifest is invalid: ${name}`); }
  const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === name);
  const expected = descriptor ? [descriptor.packageId, ...(descriptor.legacyPackageIds ?? [])] : ['@flujo-ai/mcp-shared'];
  if (!manifest || !expected.includes(manifest.name)) {
    throw new Error(`The existing ${name} directory belongs to a different package; it was not overwritten.`);
  }
  if (name !== 'shared') {
    await realDirectory(path.join(root, 'dist'));
    const entry = await optionalStat(path.join(root, 'dist', 'index.js'));
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Shipped package is not built: ${name}. Build its MCP package first.`);
    }
  }
  return manifest;
}

async function dependencyLayout(appRoot: string, name: string) {
  const manifestPath = path.join(appRoot, 'mcp-servers', name, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // This path belongs to an installed template, not a compile-time module.
  // Webpack erases a direct dynamic createRequire() call while warning about
  // its argument. Runtime lookup preserves native Node resolution and works
  // on Node 22.0, before process.getBuiltinModule was introduced in 22.3.
  const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
  const resolver = nativeCreateRequire(manifestPath);
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys({ ...manifest.devDependencies, ...manifest.optionalDependencies });
  const packages: Array<{ name: string; root: string; directory: string }> = [];
  for (const dependency of new Set([...required, ...optional])) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(dependency)) throw new Error('Invalid shipped package dependency name.');
    let found = false;
    for (const candidate of resolver.resolve.paths(dependency) ?? []) {
      const directory = path.join(candidate, dependency);
      if (!(await optionalStat(directory))) continue;
      const resolved = await fs.realpath(directory);
      await realDirectory(resolved);
      packages.push({ name: dependency, root: candidate, directory: resolved });
      found = true;
      break;
    }
    if (!found && required.includes(dependency)) throw new Error(`The installation is missing the ${dependency} dependency. Repair the application installation first.`);
  }
  const roots = [...new Set(packages.map(item => item.root))];
  return { packages, sharedRoot: roots.length === 1 ? await fs.realpath(roots[0]) : undefined };
}

async function ensureDependencies(root: string, appRoot: string, name: string): Promise<void> {
  const target = path.join(root, 'node_modules');
  const existing = await optionalStat(target);
  // Existing ordinary dependency installations belong to the workspace owner.
  if (existing?.isDirectory() && !existing.isSymbolicLink()
    && !(await optionalStat(path.join(target, '.flujo-dependencies.json')))) return;
  const layout = await dependencyLayout(appRoot, name);
  if (existing) {
    if (existing.isSymbolicLink() && layout.sharedRoot
      && await fs.realpath(target).catch(() => '') === layout.sharedRoot) return;
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      for (const dependency of layout.packages) {
        const link = path.join(target, dependency.name);
        if (!(await optionalStat(link))?.isSymbolicLink()
          || await fs.realpath(link).catch(() => '') !== dependency.directory) {
          throw new Error('The copied package dependency links are incomplete; existing dependencies were not replaced.');
        }
      }
      return;
    }
    throw new Error('The copied package dependency link is invalid; its existing dependencies were not replaced.');
  }
  try {
    if (layout.sharedRoot) {
      await fs.symlink(layout.sharedRoot, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      const stage = path.join(root, `.flujo-dependencies-${randomUUID()}`);
      await fs.mkdir(stage);
      try {
        await fs.writeFile(path.join(stage, '.flujo-dependencies.json'), JSON.stringify({ version: 1 }), { flag: 'wx' });
        for (const dependency of layout.packages) {
          const link = path.join(stage, dependency.name);
          await fs.mkdir(path.dirname(link), { recursive: true });
          await fs.symlink(dependency.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        await fs.rename(stage, target);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
      || !(await optionalStat(target))) throw error;
    await ensureDependencies(root, appRoot, name);
  }
}

/** Snapshot recipes cannot silently discard edits to workspace-owned package code. */
export async function shippedWorkspacePackageRuntimeDigest(root: string): Promise<string> {
  await realDirectory(root);
  const markerPath = path.join(root, TEMPLATE_MARKER);
  const stat = await optionalStat(markerPath);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error('This copied MCP package has no template provenance. Export it as a pinned GitHub package to transfer custom code.');
  }
  let marker: { version?: number; assetSha256?: string };
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
  catch { throw new Error('The copied MCP package template provenance is invalid.'); }
  if (marker.version !== 1 || marker.assetSha256 !== await packageDigest(root)) {
    throw new Error('This copied MCP package has local changes. Export it as a pinned GitHub package; a workspace snapshot will not discard those edits.');
  }
  return packageDigest(root, true);
}

async function clonePackage(root: string, appRoot: string, name: string): Promise<void> {
  if (!PACKAGE_NAMES.has(name)) throw new Error('Unknown shipped package directory.');
  const destination = path.join(root, name);
  const existing = await optionalStat(destination);
  if (existing) {
    await validatePackage(destination, name);
    // This may contain user edits or an earlier version. Startup is not an
    // update operation and must never overwrite or adopt its contents.
    await ensureDependencies(destination, appRoot, name);
    return;
  }

  const source = path.join(appRoot, 'mcp-servers', name);
  if (name === 'shared' && !(await optionalStat(source))) return; // npm ships embedded shared.js instead.
  const manifest = await validatePackage(source, name);

  const stage = path.join(root, `.flujo-copy-${name}-${randomUUID()}`);
  await fs.mkdir(stage);
  try {
    for (const asset of PACKAGE_ASSETS) {
      const input = path.join(source, asset);
      if (await optionalStat(input)) await copyAsset(input, path.join(stage, asset));
    }
    // ESM resolves dependencies from the copied file, not its process cwd.
    // Dependency code is installation-owned and shared; package code is copied.
    // No npm install or browser download is needed, including external data roots.
    await ensureDependencies(stage, appRoot, name);
    await fs.writeFile(path.join(stage, TEMPLATE_MARKER), JSON.stringify({
      version: 1,
      packageDirectory: name,
      copiedAt: new Date().toISOString(),
      sourcePackageVersion: manifest.version,
      sourceManifestSha256: createHash('sha256').update(await fs.readFile(path.join(source, 'package.json'))).digest('hex'),
      assetSha256: await packageDigest(stage),
      dependencyPolicy: 'installation-resolution',
    }), { flag: 'wx' });
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      // Another process may have completed the same initial copy. It owns its
      // result; never merge, replace, or remove the winning directory.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
        || !(await optionalStat(destination))) throw error;
      await validatePackage(destination, name);
      await ensureDependencies(destination, appRoot, name);
    }
  } finally {
    // Stage is a UUID-named direct child created by this invocation. fs.rm
    // unlinks its dependency junction; it never traverses that link's target.
    await fs.rm(stage, { recursive: true, force: true });
  }
}

/**
 * Seed independent workspace copies without modifying application templates or
 * existing workspace packages. A packaged install copies its distributed assets;
 * editable TS sources are available only when the application includes them.
 */
export function ensureShippedWorkspacePackages(
  workspaceRoot: string,
  appRoot = shippedMcpAppRoot(),
  packageDirectories: readonly string[] = SHIPPED_MCP_SERVERS.map(item => item.packageDirectory),
): Promise<void> {
  if (packageDirectories.length === 0) return Promise.resolve();
  const key = JSON.stringify([path.resolve(workspaceRoot), path.resolve(appRoot), [...packageDirectories].sort()]);
  const existing = copiesInFlight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    await realDirectory(workspaceRoot);
    const canonicalAppRoot = await fs.realpath(appRoot);
    await realDirectory(canonicalAppRoot);
    await realDirectory(path.join(canonicalAppRoot, 'mcp-servers'));
    const root = path.join(workspaceRoot, 'mcp-servers');
    await fs.mkdir(root, { recursive: true });
    await realDirectory(root);
    for (const name of [...new Set([...packageDirectories, 'shared'])]) {
      await clonePackage(root, canonicalAppRoot, name);
    }
    const helper = path.join(canonicalAppRoot, 'mcp-servers', 'embed-shared.mjs');
    const target = path.join(root, 'embed-shared.mjs');
    if ((await optionalStat(helper)) && !(await optionalStat(target))) {
      try { await copyAsset(helper, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  })().finally(() => copiesInFlight.delete(key));
  copiesInFlight.set(key, pending);
  return pending;
}

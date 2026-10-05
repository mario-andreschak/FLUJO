import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE = '8fe5985e4c42c3cdc37c910a4a6b5258a990d2d5';
const TREE = '4f318966afccb7fc7b44f04b51b6fbaeb7ee94ae';
const NODE = '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e';
const sourceOnlyRuntimeFiles = new Set(['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'next.config.mjs',
  'scripts/launch-next.mjs', 'scripts/local-instance.mjs', 'scripts/healthcheck.mjs',
  'scripts/exclude-workspaces-from-next-glob.cjs', 'scripts/exposure-mode.mjs', 'scripts/migration-landscape-demo.mjs',
  'scripts/local-test-dependencies.cjs', 'scripts/run-local-jest.cjs', 'mcp-servers/README.md',
  'mcp-servers/browser/scripts/install-browser.mjs']);

export function safeRelative(file) {
  assert.ok(typeof file === 'string' && file.length > 0 && !file.includes('\\') && !file.includes(':')
    && !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe payload path.');
  assert.ok(!file.split('/').some(part => /^\.env(?:\.|$)|^\.npmrc$|^\.git$|^\.codex$|^userdata$|^workspaces$|^browser-profile$/i.test(part)),
    'Private or live data cannot enter payload.');
  assert.ok(!file.startsWith('.next/cache/') && !file.startsWith('.next/dev/'), 'Transient Next output cannot enter payload.');
  return file;
}

export function packPath(file) {
  safeRelative(file);
  assert.ok(sourceOnlyRuntimeFiles.has(file) || file.startsWith('.next/') || file.startsWith('public/')
    || file.startsWith('bin/') || /^mcp-servers\/[^/]+\/(dist\/.+|package\.json)$/.test(file),
  'Unexpected npm package payload file.');
  return file;
}

function within(root, file) {
  const relative = path.relative(root, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Dependency escaped its owned CI graph.');
  return relative.split(path.sep).join('/');
}

async function hash(file) {
  const sum = createHash('sha256');
  for await (const chunk of createReadStream(file)) sum.update(chunk);
  return sum.digest('hex');
}

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).trim();

export function nativePeArchitecture(header) {
  assert.ok(header.length >= 64 && header.toString('ascii', 0, 2) === 'MZ', 'Native module is not a Windows PE file.');
  const offset = header.readUInt32LE(60);
  assert.ok(offset + 6 <= header.length && header.toString('ascii', offset, offset + 4) === 'PE\0\0', 'Invalid PE header.');
  assert.equal(header.readUInt16LE(offset + 4), 0x8664, 'Native module is not Windows x64.');
  return 'win32-x64';
}

async function exportPayload({ source, stage, output, packReport, workflowSha }) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v22.23.3');
  assert.ok(!process.env.NODE_OPTIONS && process.execArgv.length === 0, 'Default Node heap/options required.');
  assert.match(workflowSha, /^[a-f0-9]{40}$/);
  assert.equal(process.env.FLUJO_BUILD_REVISION, SOURCE);
  assert.equal(git(source, 'rev-parse', 'HEAD'), SOURCE); assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), TREE);
  assert.equal(git(source, 'status', '--porcelain=v1'), '', 'Compiled source checkout became dirty.');
  assert.equal(await hash(process.execPath), NODE);
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    await assert.rejects(fs.lstat(path.join(source, name)), error => error.code === 'ENOENT');
  }
  const sourceReal = await fs.realpath(source);
  const stageParent = await fs.realpath(path.dirname(stage));
  const outputReal = await fs.realpath(output);
  for (const selected of [stageParent, outputReal]) {
    assert.ok(selected.toLowerCase() !== sourceReal.toLowerCase()
      && !selected.toLowerCase().startsWith(sourceReal.toLowerCase() + path.sep), 'Export must use a separate runner namespace.');
  }
  await fs.mkdir(stage); // Must not replace a prior export or retained namespace.
  const files = []; const links = []; const nativeModules = [];
  const packageJson = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const workspaces = new Set(packageJson.workspaces.map(file => path.resolve(source, file).toLowerCase()));
  const copyFile = async (from, relative) => {
    safeRelative(relative);
    const destination = path.join(stage, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const handle = await fs.open(from, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      assert.ok(before.isFile() && before.size <= 512n * 1024n * 1024n, 'Payload file exceeds its budget.');
      const sum = createHash('sha256');
      await pipeline(handle.createReadStream({ autoClose: false }), new Transform({ transform(chunk, _encoding, done) {
        sum.update(chunk); done(null, chunk);
      } }), createWriteStream(destination, { flags: 'wx' }));
      const after = await handle.stat({ bigint: true });
      assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'Payload input changed during export.');
      const sha256 = sum.digest('hex');
      assert.equal(await hash(destination), sha256);
      files.push({ path: relative, bytes: before.size.toString(), sha256 });
      if (relative.endsWith('.node')) {
        const stream = await fs.open(destination, 'r');
        try {
          const header = Buffer.alloc(4096); const read = await stream.read(header, 0, header.length, 0);
          nativeModules.push({ path: relative, sha256, platform: nativePeArchitecture(header.subarray(0, read.bytesRead)) });
        } finally { await stream.close(); }
      }
    } finally { await handle.close(); }
  };
  const report = JSON.parse(await fs.readFile(packReport, 'utf8'));
  assert.equal(report.length, 1);
  assert.equal(report[0].version, packageJson.version);
  assert.ok(report[0].files.length > 0 && report[0].files.length <= 100_000);
  for (const entry of report[0].files) {
    packPath(entry.path);
    const from = path.join(source, ...entry.path.split('/'));
    assert.equal(path.resolve(from).toLowerCase(), (await fs.realpath(from)).toLowerCase(), 'Packed source path is a link.');
    await copyFile(from, entry.path);
  }
  await copyFile(path.join(source, 'package-lock.json'), 'package-lock.json');
  const walk = async (from, relative, ancestors = new Set(), workspaceOrigin = null) => {
    safeRelative(relative);
    const real = await fs.realpath(from); const stat = await fs.lstat(from);
    within(sourceReal, real);
    if (stat.isSymbolicLink()) links.push({ path: relative, materializedFrom: within(sourceReal, real) });
    const kind = await fs.stat(real);
    if (kind.isDirectory()) {
      assert.ok(!ancestors.has(real.toLowerCase()), 'Dependency link cycle.');
      const next = new Set(ancestors); next.add(real.toLowerCase());
      const workspace = workspaces.has(real.toLowerCase());
      const origin = workspace ? real : workspaceOrigin;
      if (!workspace) assert.ok(real.toLowerCase().startsWith(path.join(sourceReal, 'node_modules').toLowerCase() + path.sep)
        || real.toLowerCase() === path.join(sourceReal, 'node_modules').toLowerCase()
        || (origin && (real.toLowerCase() === path.join(origin, 'dist').toLowerCase()
          || real.toLowerCase().startsWith(path.join(origin, 'dist').toLowerCase() + path.sep))),
      'Dependency link targets nonruntime source.');
      for (const child of (await fs.readdir(real)).sort()) {
        if (workspace && !['dist', 'package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'scripts'].includes(child)) continue;
        if (workspace && child === 'scripts') {
          const script = path.join(real, 'scripts', 'install-browser.mjs');
          if (await fs.lstat(script).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
            await copyFile(script, `${relative}/scripts/install-browser.mjs`);
          }
          continue;
        }
        await walk(path.join(real, child), `${relative}/${child}`, next, origin);
      }
    } else {
      assert.ok(kind.isFile(), 'Dependency has a special file.');
      assert.ok(real.toLowerCase().startsWith(path.join(sourceReal, 'node_modules').toLowerCase() + path.sep)
        || (workspaceOrigin && (real.toLowerCase().startsWith(path.join(workspaceOrigin, 'dist').toLowerCase() + path.sep)
          || ['package.json', 'README.md', 'LICENSE', 'LICENSE.md'].some(name => real.toLowerCase() === path.join(workspaceOrigin, name).toLowerCase()))),
      'Dependency file escaped its runtime distribution.');
      await copyFile(real, relative);
    }
  };
  await walk(path.join(source, 'node_modules'), 'node_modules');
  for (const required of ['.next/BUILD_ID', '.next/server/app/api/worker/status/route.js',
    'mcp-servers/filesystem/dist/index.js', 'scripts/launch-next.mjs', 'node_modules/next/package.json']) {
    assert.ok(files.some(file => file.path === required), `Missing runtime payload: ${required}`);
  }
  assert.equal(git(source, 'status', '--porcelain=v1'), '');
  const lockSha256 = await hash(path.join(source, 'package-lock.json'));
  const runtime = JSON.parse(await fs.readFile(path.join(source, 'ci-node-runtime', 'v22.23.3.json'), 'utf8'));
  assert.equal(runtime.sourceSha, SOURCE); assert.equal(runtime.sourceTreeDirty, false);
  assert.equal(runtime.executableSha256, NODE); assert.equal(runtime.node, '22.23.3'); assert.equal(runtime.libuv, '1.51.0');
  const manifest = { schemaVersion: 1, preparedAtUtc: new Date().toISOString(), applicationSource: SOURCE, applicationTree: TREE,
    workflowSource: workflowSha, exporterSha256: await hash(fileURLToPath(import.meta.url)),
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: process.platform, architecture: process.arch, packageName: packageJson.name, packageVersion: packageJson.version,
    nodeExecutableSha256: NODE, runtime, sourceLockSha256: lockSha256,
    installedGraphLockSha256: await hash(path.join(source, 'node_modules', '.package-lock.json')),
    npmPackageReportSha256: await hash(packReport), buildId: (await fs.readFile(path.join(stage, '.next', 'BUILD_ID'), 'utf8')).trim(),
    graph: 'Fresh own Windows production graph from exact source lock; workspace runtime distributions materialized',
    files: files.sort((a, b) => a.path.localeCompare(b.path)), materializedLinks: links, nativeModules,
    appOrProviderExecuted: false, harnessSource: null, actualWorkerAcceptance: 'UNRUN',
    limits: ['PE headers record platform/architecture; actual native loading and compiled-worker acceptance require a separately approved local run.'] };
  await fs.writeFile(path.join(output, 'payload-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}

async function main(args) {
  assert.equal(args.length, 10);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; assert.ok(['--source', '--stage', '--output', '--pack-report', '--workflow-sha'].includes(flag));
    assert.ok(!options[flag]); options[flag] = args[index + 1];
  }
  for (const key of ['--source', '--stage', '--output', '--pack-report']) assert.ok(path.isAbsolute(options[key]));
  await exportPayload({ source: options['--source'], stage: options['--stage'], output: options['--output'],
    packReport: options['--pack-report'], workflowSha: options['--workflow-sha'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

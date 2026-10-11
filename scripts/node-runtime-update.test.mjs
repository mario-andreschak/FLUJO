import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { nodeRuntimeDiagnostic, nodeRuntimeManualSteps } from '../bin/node-runtime.mjs';
import {
  confirmNodeUpdate, ensureSupportedAppRuntime, extractNodeArchive, findManagedNode, installManagedNode,
  latestSupportedRelease, nodeDistribution, relaunchWithNode,
} from '../bin/node-runtime-update.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-node-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function scenario(overrides = {}) {
  const output = [];
  const calls = [];
  const runtime = { version: '22.23.3', executable: process.execPath, directory: path.dirname(process.execPath) };
  const options = {
    version: '22.13.1', argv: [process.execPath, 'launch-next.mjs', 'start', '--port', '4200'],
    interactive: true, print: text => output.push(text), find: async () => null,
    confirm: async () => { calls.push('confirm'); return false; },
    install: async ({ major }) => { calls.push(['install', major]); return runtime; },
    relaunch: async (installed, args) => { calls.push(['relaunch', installed.version, args]); return 7; },
    ...overrides,
  };
  return { options, output, calls };
}

test('runtime diagnostics identify the active Node and explain installation and PATH recovery', () => {
  assert.match(nodeRuntimeDiagnostic('22.13.1', 'C:\\Program Files\\nodejs\\node.exe'), /Node.js v22.13.1/);
  assert.match(nodeRuntimeDiagnostic('22.13.1', 'C:\\old\nnode.exe'), /C:\\old\?node.exe/);
  assert.doesNotMatch(nodeRuntimeDiagnostic('private-probe-input'), /private-probe-input/);
  assert.match(nodeRuntimeManualSteps('win32'), /winget install --id OpenJS.NodeJS.22/);
  assert.match(nodeRuntimeManualSteps('win32'), /Get-Command node -All/);
  assert.match(nodeRuntimeManualSteps('linux'), /nvm install 22/);
  assert.match(nodeRuntimeManualSteps('darwin'), /command -v node/);
  assert.match(nodeRuntimeManualSteps(), /Close and reopen/);
});

test('declining the update changes nothing and explains manual steps', async () => {
  const s = scenario();
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), { exitCode: 1 });
  assert.deepEqual(s.calls, ['confirm']);
  assert.match(s.output.join('\n'), /Manual update:/);
  assert.match(s.output.join('\n'), /--update-node/);
});

test('non-interactive startup never prompts or installs without explicit consent', async () => {
  const s = scenario({ interactive: false });
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), { exitCode: 1 });
  assert.deepEqual(s.calls, []);
  assert.match(s.output.join('\n'), /node --version/);
});

test('accepting installs on the same supported major and preserves restart arguments and exit status', async () => {
  const s = scenario({ confirm: async () => true });
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), { exitCode: 7 });
  assert.deepEqual(s.calls, [['install', 22], ['relaunch', '22.23.3', ['launch-next.mjs', 'start', '--port', '4200']]]);
});

test('explicit update works without a terminal and its flag is consumed before restart', async () => {
  const s = scenario({ interactive: false, version: '26.1.0', argv: [process.execPath, 'flujo.mjs', '--update-node', '--no-open'] });
  await ensureSupportedAppRuntime(s.options);
  assert.deepEqual(s.calls, [['install', 24], ['relaunch', '22.23.3', ['flujo.mjs', '--no-open']]]);
});

test('a previously verified installation is reused without a new prompt or download', async () => {
  const s = scenario({ find: async () => ({ version: '24.21.0', executable: process.execPath }) });
  await ensureSupportedAppRuntime(s.options);
  assert.deepEqual(s.calls, [['relaunch', '24.21.0', ['launch-next.mjs', 'start', '--port', '4200']]]);
});

test('supported Node starts normally and consumes the optional bootstrap flag', async () => {
  const s = scenario({ version: '24.2.0', argv: [process.execPath, 'flujo.mjs', '--update-node', '--no-open'] });
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), {});
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.options.argv, [process.execPath, 'flujo.mjs', '--no-open']);
});

test('failed automatic updates retain a failing exit status and manual recovery instructions', async () => {
  const s = scenario({ confirm: async () => true, install: async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); } });
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), { exitCode: 1 });
  assert.match(s.output.join('\n'), /automatic Node update/);
  assert.match(s.output.join('\n'), /Manual update:/);
  assert.doesNotMatch(s.output.join('\n'), /PRIVATE_PROVIDER_ERROR/);
});

test('confirmation handles yes, no, empty input, EOF and interruption', async () => {
  for (const [answer, expected] of [['yes\n', true], ['Y\n', true], ['n\n', false], ['\n', false], [null, false], ['\x03', false]]) {
    const input = new PassThrough();
    const output = new PassThrough();
    if (answer === '\x03') output.isTTY = true;
    const result = confirmNodeUpdate(22, { input, output });
    if (answer === null) input.end();
    else input.end(answer);
    assert.equal(await result, expected);
  }
});

test('release selection stays on supported stable LTS lines and sorts numerically', () => {
  const releases = [{ version: 'v22.9.0', lts: 'Jod' }, { version: 'v22.17.0', lts: 'Jod' },
    { version: 'v22.23.3', lts: 'Jod' }, { version: 'v22.100.0-rc.1', lts: 'Jod' },
    { version: 'v22.24.0', lts: false }, { version: 'v24.21.0', lts: 'Krypton' }, { version: 'v26.11.0', lts: true }];
  assert.equal(latestSupportedRelease(releases, 22), '22.23.3');
  assert.equal(latestSupportedRelease(releases, 24), '24.21.0');
  assert.throws(() => latestSupportedRelease(releases, 26));
  assert.throws(() => latestSupportedRelease([], 22));
  assert.equal(nodeDistribution('win32', 'ia32').cpu, 'x86');
  assert.equal(nodeDistribution('linux', 'arm64').binary, 'bin/node');
  assert.throws(() => nodeDistribution('freebsd', 'x64'));
});

async function installerFixture(t, { badChecksum = false, badVersion = false } = {}) {
  const baseDirectory = await fixture(t);
  const archive = Buffer.from('official archive fixture');
  let extractionCalled = false;
  const options = {
    baseDirectory, major: 22, platform: process.platform, arch: process.arch,
    fetchBytes: async url => {
      assert.equal(url.origin, 'https://nodejs.org');
      if (url.pathname.endsWith('index.json')) return Buffer.from(JSON.stringify([{ version: 'v22.23.3', lts: 'Jod' }]));
      if (url.pathname.endsWith('SHASUMS256.txt')) {
        const d = nodeDistribution();
        return Buffer.from(`${badChecksum ? '0'.repeat(64) : digest(archive)}  node-v22.23.3-${d.osName}-${d.cpu}.${d.extension}\n`);
      }
      return archive;
    },
    extract: async (_archive, extraction) => {
      extractionCalled = true;
      const d = nodeDistribution();
      const binary = path.join(extraction, `node-v22.23.3-${d.osName}-${d.cpu}`, d.binary);
      await fs.mkdir(path.dirname(binary), { recursive: true });
      await fs.copyFile(process.execPath, binary);
    },
    probe: async () => badVersion ? '26.1.0' : '22.23.3',
  };
  return { options, baseDirectory, extractionCalled: () => extractionCalled };
}

test('installation verifies checksums before extraction and never publishes a bad runtime', async t => {
  const f = await installerFixture(t, { badChecksum: true });
  await assert.rejects(installManagedNode(f.options), /SHA-256/);
  assert.equal(f.extractionCalled(), false);
  assert.deepEqual(await fs.readdir(f.baseDirectory), []);
});

test('Windows ZIP extraction receives its archive and destination in the native child environment', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('node/example.txt', 'actual extracted content');
  const archive = path.join(directory, 'node.zip');
  const destination = path.join(directory, 'extracted');
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  await fs.mkdir(destination);
  await extractNodeArchive(archive, destination, 'win32');
  assert.equal(await fs.readFile(path.join(destination, 'node/example.txt'), 'utf8'), 'actual extracted content');
});

test('failed runtime probing removes partial installation without changing the previous receipt', async t => {
  const f = await installerFixture(t, { badVersion: true });
  await fs.writeFile(path.join(f.baseDirectory, 'active.json'), 'previous receipt');
  await assert.rejects(installManagedNode(f.options), /runtime failed verification/);
  assert.deepEqual(await fs.readdir(f.baseDirectory), ['active.json']);
  assert.equal(await fs.readFile(path.join(f.baseDirectory, 'active.json'), 'utf8'), 'previous receipt');
});

test('installed receipts reject tampering and paths outside the managed directory', async t => {
  const f = await installerFixture(t);
  const installed = await installManagedNode(f.options);
  assert.deepEqual(await findManagedNode({ baseDirectory: f.baseDirectory }), installed);
  const receiptFile = path.join(f.baseDirectory, 'active.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, directory: '../escape' }));
  assert.equal(await findManagedNode({ baseDirectory: f.baseDirectory }), null);
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await fs.appendFile(installed.executable, 'changed');
  assert.equal(await findManagedNode({ baseDirectory: f.baseDirectory }), null);
});

test('updating an already current managed runtime reuses its verified files', async t => {
  const f = await installerFixture(t);
  const first = await installManagedNode(f.options);
  const second = await installManagedNode({ ...f.options, extract: async () => { throw new Error('Unnecessary extraction'); } });
  assert.deepEqual(second, first);
  assert.equal((await fs.readdir(f.baseDirectory)).length, 2);
});

test('a cached runtime that cannot execute fails with manual recovery guidance', async () => {
  const s = scenario({ find: async () => ({ version: '22.23.3' }), relaunch: async () => { throw new Error('PRIVATE_EXEC_ERROR'); } });
  assert.deepEqual(await ensureSupportedAppRuntime(s.options), { exitCode: 1 });
  assert.match(s.output.join('\n'), /Manual update:/);
  assert.doesNotMatch(s.output.join('\n'), /PRIVATE_EXEC_ERROR/);
});

test('relaunch executes the actual runtime, places its tools first on PATH and forwards exit status', async t => {
  const directory = await fixture(t);
  const marker = path.join(directory, 'restart.json');
  const script = path.join(directory, 'restart.mjs');
  await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({version: process.versions.node, path: process.env.PATH})); process.exitCode = 7;`);
  const result = await relaunchWithNode({ executable: process.execPath }, [script], { ...process.env, Path: 'old-path', PATH: 'old-path' });
  assert.equal(result, 7);
  const actual = JSON.parse(await fs.readFile(marker));
  assert.equal(actual.version, process.versions.node);
  assert.equal(actual.path.split(path.delimiter)[0], path.dirname(process.execPath));
});

test('MCP preflight emits only stderr guidance and refuses before dependency initialization', async t => {
  const directory = await fixture(t);
  const entry = path.join(directory, 'entry.mjs');
  await fs.writeFile(entry, `import ${JSON.stringify(new URL('../bin/node-runtime-preflight.mjs', import.meta.url).href)}; console.log('DEPENDENCY_INITIALIZED');`);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process.versions, 'node', {value: '22.13.1'}); await import(${JSON.stringify(pathToFileURL(entry).href)});`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Node.js v22.13.1/);
  assert.match(result.stderr, /Manual update:/);
  assert.doesNotMatch(result.stderr, /at assertSupportedNodeRuntime|\[y\/N\]/);
});

test('application preflight blocks sibling dependency effects while unsupported and non-interactive', async t => {
  const directory = await fixture(t);
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  for (const file of ['node-runtime.mjs', 'node-runtime-update.mjs', 'app-node-runtime-preflight.mjs']) {
    await fs.copyFile(path.join(root, 'bin', file), path.join(bin, file));
  }
  const marker = path.join(directory, 'dependency-ran');
  await fs.writeFile(path.join(bin, 'effect.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unwanted side effect');`);
  await fs.writeFile(path.join(bin, 'flujo.mjs'), "import './app-node-runtime-preflight.mjs'; import './effect.mjs';");
  const preload = path.join(directory, 'old-node.cjs');
  await fs.writeFile(preload, "Object.defineProperty(process.versions, 'node', {value: '22.13.1'});");
  const result = spawnSync(process.execPath, [path.join(bin, 'flujo.mjs')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, NODE_OPTIONS: '--require=' + JSON.stringify(preload) },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Manual update:/);
});

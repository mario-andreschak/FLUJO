import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flujo-bootstrap-launcher-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('flujo-bootstrap-launcher-'));
    rmSync(root, { recursive: true, force: true });
  });
  const app = path.join(root, 'package');
  for (const relative of ['bin/flujo.mjs', 'bin/launcher-port.mjs', 'bin/node-runtime.mjs',
    'bin/node-runtime-preflight.mjs', 'scripts/bootstrap-directory.mjs', 'scripts/launch-next.mjs',
    'scripts/local-instance.mjs', 'scripts/exposure-mode.mjs', 'scripts/canonical-data-root.mjs']) {
    const destination = path.join(app, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(repository, relative)));
  }
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'bootstrap-launcher-fixture', type: 'module' }));
  cpSync(path.join(repository, 'node_modules/@next/env'), path.join(app, 'node_modules/@next/env'), { recursive: true });
  const next = path.join(app, 'node_modules/next');
  mkdirSync(path.join(next, 'dist/bin'), { recursive: true });
  writeFileSync(path.join(next, 'package.json'), JSON.stringify({ name: 'next', type: 'commonjs' }));
  // Only the final server child is controlled. Both entry points, dotenv loader,
  // private discovery permissions/registration and child environment are real.
  writeFileSync(path.join(next, 'dist/bin/next.js'), `
    const path = require('node:path');
    console.log('BOOTSTRAP_CHILD ' + JSON.stringify({
      settings: process.env.FLUJO_RUNTIME_ENV_DIR,
      data: process.env.FLUJO_DATA_DIR || process.cwd(),
      discovery: process.env.FLUJO_LOCAL_INSTANCE_DIR || path.join(require('node:os').homedir(), '.flujo', 'instances'),
      privateValue: process.env.FLUJO_PRIVATE_CANARY || null,
      hostValue: process.env.FLUJO_HOST_CANARY || null,
      cwdValue: process.env.FLUJO_CWD_CANARY || null,
      controlTokenPresent: Boolean(process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN),
      args: process.argv.slice(2), cwd: process.cwd()
    }));
    setTimeout(() => {}, 1000);
  `);
  const home = path.join(root, 'home');
  const selected = path.join(root, 'private');
  mkdirSync(path.join(home, '.flujo'), { recursive: true });
  mkdirSync(selected);
  writeFileSync(path.join(home, '.flujo/.env.local'), 'FLUJO_HOST_CANARY=host\n');
  writeFileSync(path.join(app, '.env.local'), 'FLUJO_CWD_CANARY=cwd\n');
  writeFileSync(path.join(selected, '.env.local'), 'FLUJO_PRIVATE_CANARY=private\nFLUJO_RUNTIME_ENV_DIR=/wrong\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TEMP: root, TMP: root, NODE_ENV: 'production',
    FLUJO_BOOTSTRAP_DIR: selected, FLUJO_DATA_DIR: path.join(root, 'data'),
    FLUJO_LOCAL_INSTANCE_DIR: path.join(root, 'instances'), FLUJO_EXPOSURE_MODE: 'localhost' });
  function run(entry, cliArgs = ['--no-open', '--port', '43550']) {
    const args = entry === 'npm' ? ['bin/flujo.mjs', ...cliArgs]
      : ['scripts/launch-next.mjs', 'start', '-p', '43550'];
    return spawnSync(process.execPath, args, { cwd: app, env, encoding: 'utf8', windowsHide: true,
      timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  return { root, app, home, selected, env, run };
}
function witness(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('BOOTSTRAP_CHILD '));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('BOOTSTRAP_CHILD '.length));
}
function assertNativeDataRoot(actual, requested) {
  assert.equal(actual, realpathSync.native(requested));
  const requestedDirectory = statSync(requested, { bigint: true });
  const actualDirectory = statSync(actual, { bigint: true });
  assert.ok(requestedDirectory.isDirectory());
  assert.ok(actualDirectory.isDirectory());
  assert.equal(actualDirectory.dev, requestedDirectory.dev);
  assert.equal(actualDirectory.ino, requestedDirectory.ino);
}
for (const option of ['--version', '--help', '--porrt=4200', 'start']) {
  test(`npm rejects unknown option ${option} before creating folders or launching`, t => {
    const f = fixture(t);
    f.env.FLUJO_BOOTSTRAP_DIR = path.join(f.root, 'uncreated-bootstrap');
    const result = f.run('npm', [option, '--no-open']);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option/);
    assert.ok(!result.stdout.includes('BOOTSTRAP_CHILD'));
    for (const key of ['FLUJO_BOOTSTRAP_DIR', 'FLUJO_DATA_DIR', 'FLUJO_LOCAL_INSTANCE_DIR']) {
      assert.equal(existsSync(f.env[key]), false, key);
    }
  });
}

for (const cliArgs of [['--port'], ['--port=bad']]) {
  test(`npm rejects invalid explicit port ${cliArgs.join(' ')} before creating folders`, t => {
    const f = fixture(t);
    f.env.FLUJO_BOOTSTRAP_DIR = path.join(f.root, 'uncreated-bootstrap');
    const result = f.run('npm', cliArgs);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid port/);
    assert.equal(existsSync(f.env.FLUJO_BOOTSTRAP_DIR), false);
    assert.equal(existsSync(f.env.FLUJO_DATA_DIR), false);
  });
}

for (const cliArgs of [['-p', '43550'], ['--port=43550']]) {
  test(`npm retains documented port syntax ${cliArgs.join(' ')}`, t => {
    const f = fixture(t);
    const child = witness(f.run('npm', [...cliArgs, '--no-open']));
    assert.ok(child.args.includes('43550'));
  });
}

for (const entry of ['npm', 'next']) {
  test(`${entry} entry launches with isolated settings, data and discovery`, t => {
    const f = fixture(t); const child = witness(f.run(entry));
    assert.equal(child.settings, f.selected);
    if (entry === 'npm') assertNativeDataRoot(child.data, f.env.FLUJO_DATA_DIR);
    else assert.equal(child.data, f.env.FLUJO_DATA_DIR);
    assert.equal(child.discovery, f.env.FLUJO_LOCAL_INSTANCE_DIR);
    assert.equal(child.privateValue, 'private');
    assert.equal(child.hostValue, null); assert.equal(child.cwdValue, null);
    assert.equal(child.controlTokenPresent, true);
    assert.equal(child.cwd, f.app);
    assert.ok(child.args.includes('127.0.0.1'));
  });
  test(`${entry} entry preserves legacy data and settings defaults`, t => {
    const f = fixture(t);
    for (const name of ['FLUJO_BOOTSTRAP_DIR', 'FLUJO_DATA_DIR', 'FLUJO_LOCAL_INSTANCE_DIR']) delete f.env[name];
    const child = witness(f.run(entry));
    assert.equal(child.settings, entry === 'npm' ? path.join(f.home, '.flujo') : f.app);
    if (entry === 'npm') assertNativeDataRoot(child.data, path.join(f.home, '.flujo'));
    else assert.equal(child.data, f.app);
    assert.equal(child.discovery, path.join(f.home, '.flujo', 'instances'));
  });
  test(`${entry} invalid bootstrap fails before dotenv and child launch`, t => {
    const f = fixture(t); f.env.FLUJO_BOOTSTRAP_DIR = 'relative';
    const result = f.run(entry); assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('BOOTSTRAP_CHILD'));
    assert.ok(!result.stdout.includes('Loaded env'));
    assert.equal(existsSync(f.env.FLUJO_LOCAL_INSTANCE_DIR), false);
  });
  for (const store of ['public', '.next/static']) {
    test(`${entry} refuses discovery records in ${store}, including dot-prefixed children`, t => {
      const f = fixture(t); f.env.FLUJO_LOCAL_INSTANCE_DIR = path.join(f.app, store, '..private');
      const result = f.run(entry); assert.ifError(result.error); assert.notEqual(result.status, 0);
      assert.ok(!result.stdout.includes('BOOTSTRAP_CHILD'));
      assert.equal(existsSync(f.env.FLUJO_LOCAL_INSTANCE_DIR), false);
    });
    test(`${entry} refuses data aliased into ${store} before child launch`, t => {
      const f = fixture(t); const target = path.join(f.app, store, 'data');
      mkdirSync(target, { recursive: true });
      const alias = path.join(f.root, 'data-alias');
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      f.env.FLUJO_DATA_DIR = alias;
      const result = f.run(entry); assert.ifError(result.error); assert.notEqual(result.status, 0);
      assert.ok(!result.stdout.includes('BOOTSTRAP_CHILD'));
      assert.equal(existsSync(f.env.FLUJO_LOCAL_INSTANCE_DIR), false);
    });
  }
}

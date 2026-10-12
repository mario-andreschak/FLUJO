const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranspileCache } = require('../__tests__/enduringAgents/fixtures/personaTranspileCache.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-cache-boundary-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let count = 0;
  const compiler = { version: 'fixture-v1', transpileModule: () => { count++; return { outputText: 'trusted compiled source' }; } };
  return { root, compiler, count: () => count };
}

test('reuses a private cache entry across child compiler instances', t => {
  const f = fixture(t);
  assert.equal(createTranspileCache(f.compiler, f.root)('ts', 'source.ts', 'source', {}), 'trusted compiled source');
  assert.equal(createTranspileCache(f.compiler, f.root)('ts', 'source.ts', 'source', {}), 'trusted compiled source');
  assert.equal(f.count(), 1);
});

test('rejects hard-linked cached JavaScript and executes fresh compiler output', t => {
  const f = fixture(t);
  const compile = createTranspileCache(f.compiler, f.root);
  compile('ts', 'source.ts', 'source', {});
  const cached = path.join(f.root, fs.readdirSync(f.root)[0]);
  fs.linkSync(cached, path.join(f.root, 'external.js'));
  fs.writeFileSync(cached, 'untrusted cached JavaScript');
  assert.equal(compile('ts', 'source.ts', 'source', {}), 'trusted compiled source');
  assert.equal(f.count(), 2);
  assert.equal(fs.readFileSync(path.join(f.root, 'external.js'), 'utf8'), 'untrusted cached JavaScript');
});

test('refuses pre-created temporary entries without overwriting or deleting them', t => {
  const f = fixture(t);
  const open = fs.openSync;
  let planted;
  fs.openSync = function (...args) {
    if (String(args[0]).includes('.compile-')) {
      planted = String(args[0]);
      fs.writeFileSync(planted, 'unowned');
    }
    return open(...args);
  };
  try { assert.equal(createTranspileCache(f.compiler, f.root)('ts', 'source.ts', 'source', {}), 'trusted compiled source'); }
  finally { fs.openSync = open; }
  assert.equal(fs.readFileSync(planted, 'utf8'), 'unowned');
});

test('includes compiler version and options in the cache identity', t => {
  const f = fixture(t);
  const compile = createTranspileCache(f.compiler, f.root);
  compile('ts', 'source.ts', 'source', { target: 1 });
  compile('ts', 'source.ts', 'source', { target: 2 });
  f.compiler.version = 'fixture-v2';
  createTranspileCache(f.compiler, f.root)('ts', 'source.ts', 'source', { target: 2 });
  assert.equal(f.count(), 3);
});

test('rejects a shared writable cache directory on POSIX', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const compile = createTranspileCache(f.compiler, f.root);
  compile('ts', 'source.ts', 'source', {});
  compile('ts', 'source.ts', 'source', {});
  assert.equal(f.count(), 2);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

for (const field of ['ino', 'mtimeNs', 'ctimeNs']) test(`rejects cached-code ${field} identities that collide as Numbers`, t => {
  const f = fixture(t);
  const compile = createTranspileCache(f.compiler, f.root);
  compile('ts', 'source.ts', 'source', {});
  const cacheFile = path.join(f.root, fs.readdirSync(f.root)[0]);
  const colliding = BigInt('9007199254740992');
  assert.equal(Number(colliding), Number(colliding + BigInt(1)));
  const originals = { open: fs.openSync, close: fs.closeSync, fstat: fs.fstatSync, lstat: fs.lstatSync };
  let cacheDescriptor;
  fs.openSync = function (...args) {
    const descriptor = originals.open(...args);
    if (String(args[0]) === cacheFile) cacheDescriptor = descriptor;
    return descriptor;
  };
  fs.closeSync = function (descriptor) {
    if (descriptor === cacheDescriptor) cacheDescriptor = undefined;
    return originals.close(descriptor);
  };
  fs.fstatSync = function (...args) {
    const value = originals.fstat(...args);
    if (args[0] === cacheDescriptor) {
      assert.deepEqual(args[1], { bigint: true });
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { [field]: colliding });
    }
    return value;
  };
  fs.lstatSync = function (...args) {
    const value = originals.lstat(...args);
    if (String(args[0]) === cacheFile) {
      assert.deepEqual(args[1], { bigint: true });
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { [field]: colliding + BigInt(1) });
    }
    return value;
  };
  try {
    assert.equal(compile('ts', 'source.ts', 'source', {}), 'trusted compiled source');
    assert.equal(f.count(), 2);
  } finally {
    fs.openSync = originals.open; fs.closeSync = originals.close;
    fs.fstatSync = originals.fstat; fs.lstatSync = originals.lstat;
  }
});

test('refuses a private cache directory whose exact inode drifts below Number precision', t => {
  const f = fixture(t);
  const colliding = BigInt('9007199254740992');
  const lstat = fs.lstatSync;
  let admitted = false;
  fs.lstatSync = function (...args) {
    const value = lstat(...args);
    if (String(args[0]) !== f.root) return value;
    assert.deepEqual(args[1], { bigint: true });
    const ino = colliding + BigInt(admitted ? 1 : 0);
    admitted = true;
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino });
  };
  try {
    const compile = createTranspileCache(f.compiler, f.root);
    assert.equal(compile('ts', 'source.ts', 'source', {}), 'trusted compiled source');
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { fs.lstatSync = lstat; }
});

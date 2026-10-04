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

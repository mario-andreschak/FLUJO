import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBoundedFileSync } from './read-bounded-file.cjs';

function fixture(t, content = 'original') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-bounded-reader-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('flujo-bounded-reader-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'member.json');
  fs.writeFileSync(filename, content);
  return { root, filename };
}

test('reads exact byte limits and empty files; refuses invalid limits', t => {
  const { filename } = fixture(t, '😀');
  assert.equal(readBoundedFileSync(filename, 4).toString(), '😀');
  assert.throws(() => readBoundedFileSync(filename, 3), /oversized/);
  fs.writeFileSync(filename, '');
  assert.equal(readBoundedFileSync(filename, 0).length, 0);
  for (const limit of [-1, 0.5, NaN, 21 * 1024 * 1024]) {
    assert.throws(() => readBoundedFileSync(filename, limit), /Invalid bounded/);
  }
});

test('refuses nonregular and multiply linked files before reading; closes failures', t => {
  const { root, filename } = fixture(t);
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => readBoundedFileSync(root, 100));
  fs.linkSync(filename, path.join(root, 'hard-link.json'));
  assert.throws(() => readBoundedFileSync(filename, 100), /Unsafe/);
  assert.equal(read.mock.callCount(), 0);
  assert.ok(close.mock.callCount() >= 1);
});

test('pathname replacement after opening cannot substitute a different checked file', t => {
  const { root, filename } = fixture(t);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    fs.renameSync(filename, path.join(root, 'held-original.json'));
    fs.writeFileSync(filename, 'replacement');
    return fd;
  });
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => readBoundedFileSync(filename, 100), /Unsafe/);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
});

test('replacement during read stays on the original descriptor and invalidates the result', t => {
  const { root, filename } = fixture(t);
  const read = fs.readSync;
  let first = true;
  let seen = '';
  t.mock.method(fs, 'readSync', (...args) => {
    assert.equal(typeof args[0], 'number');
    if (first) {
      first = false;
      fs.renameSync(filename, path.join(root, 'held-original.json'));
      fs.writeFileSync(filename, 'replacement');
    }
    const count = read(...args);
    seen += args[1].subarray(args[2], args[2] + count).toString();
    return count;
  });
  assert.throws(() => readBoundedFileSync(filename, 100), /Unsafe/);
  assert.equal(seen, 'original');
});

test('growth after metadata validation is bounded and cannot return a passing payload', t => {
  const { filename } = fixture(t, 'x'.repeat(64));
  const read = fs.readSync;
  let consumed = 0;
  let first = true;
  t.mock.method(fs, 'readSync', (...args) => {
    if (first) { first = false; fs.appendFileSync(filename, 'x'.repeat(100000)); }
    const count = read(...args); consumed += count; return count;
  });
  assert.throws(() => readBoundedFileSync(filename, 64), /oversized/);
  assert.equal(consumed, 65);
});

test('same-length mutation after metadata validation is refused before returning bytes', t => {
  const { filename } = fixture(t, 'first');
  const read = fs.readSync;
  let first = true;
  t.mock.method(fs, 'readSync', (...args) => {
    if (first) {
      first = false;
      fs.writeFileSync(filename, 'other');
      fs.utimesSync(filename, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    }
    return read(...args);
  });
  assert.throws(() => readBoundedFileSync(filename, 100), /changed/);
});

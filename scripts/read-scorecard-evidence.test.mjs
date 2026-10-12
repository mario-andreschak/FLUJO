import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { readScorecardEvidence } from './read-scorecard-evidence.mjs';

const limit = 5 * 1024 * 1024;

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'flujo-scorecard-read-'));
  const root = join(directory, 'repo');
  fs.mkdirSync(root);
  const path = join(root, 'payload.json');
  fs.writeFileSync(path, 'original evidence');
  try {
    run({ directory, root, path });
  } finally {
    const cleanupPath = fs.realpathSync(directory);
    assert.equal(fs.realpathSync(dirname(cleanupPath)), fs.realpathSync(tmpdir()));
    assert.ok(basename(cleanupPath).startsWith('flujo-scorecard-read-'));
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
}

test('accepts exactly 5 MiB and rejects an oversized opened file without reading it', t => {
  fixture(({ root, path }) => {
    fs.truncateSync(path, limit);
    assert.equal(readScorecardEvidence(path, root).length, limit);
    fs.truncateSync(path, limit + 1);
    const read = t.mock.method(fs, 'readSync');
    assert.throws(() => readScorecardEvidence(path, root), /exceeds 5 MiB/);
    assert.equal(read.mock.callCount(), 0);
    read.mock.restore();
  });
});

test('a pathname replacement after metadata checks cannot replace the opened payload', t => {
  fixture(({ root, path }) => {
    const readSync = fs.readSync;
    let replaced = false;
    const read = t.mock.method(fs, 'readSync', (fd, ...args) => {
      assert.equal(typeof fd, 'number');
      if (!replaced) {
        replaced = true;
        fs.renameSync(path, path + '.original');
        fs.writeFileSync(path, 'replacement evidence');
      }
      return readSync(fd, ...args);
    });
    try {
      assert.equal(readScorecardEvidence(path, root).toString(), 'original evidence');
      assert.equal(fs.readFileSync(path, 'utf8'), 'replacement evidence');
      assert.ok(replaced);
    } finally {
      read.mock.restore();
    }
  });
});

test('growth after the descriptor size check stops after 5 MiB plus one byte', t => {
  fixture(({ root, path }) => {
    const readSync = fs.readSync;
    let total = 0;
    let grew = false;
    const read = t.mock.method(fs, 'readSync', (fd, ...args) => {
      if (!grew) {
        grew = true;
        fs.appendFileSync(path, Buffer.alloc(limit));
      }
      const count = readSync(fd, ...args);
      total += count;
      return count;
    });
    try {
      assert.throws(() => readScorecardEvidence(path, root), /exceeds 5 MiB/);
      assert.equal(total, limit + 1);
      assert.ok(read.mock.callCount() < 100);
    } finally {
      read.mock.restore();
    }
  });
});

test('redirecting a parent during open is rejected before foreign content is read', t => {
  fixture(({ directory, root, path }) => {
    const inside = join(root, 'inside');
    const outside = join(directory, 'outside');
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    fs.writeFileSync(join(inside, 'payload.json'), 'inside evidence');
    fs.writeFileSync(join(outside, 'payload.json'), 'foreign content');
    const openSync = fs.openSync;
    const open = t.mock.method(fs, 'openSync', (target, flags) => {
      fs.renameSync(inside, inside + '.original');
      fs.symlinkSync(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
      return openSync(target, flags);
    });
    const read = t.mock.method(fs, 'readSync');
    const close = t.mock.method(fs, 'closeSync');
    try {
      assert.throws(() => readScorecardEvidence(join(inside, 'payload.json'), root), /path changed|escapes repository/);
      assert.equal(read.mock.callCount(), 0);
      assert.equal(close.mock.callCount(), 1);
      assert.equal(fs.readFileSync(path, 'utf8'), 'original evidence');
    } finally {
      open.mock.restore();
      read.mock.restore();
      close.mock.restore();
    }
  });
});

test('rejects nonregular payloads and closes an opened descriptor when reading fails', t => {
  fixture(({ root, path }) => {
    // Windows may reject opening a directory before fstat can inspect it.
    assert.throws(() => readScorecardEvidence(root, root), /regular file|EISDIR|EPERM|EACCES/);
    const read = t.mock.method(fs, 'readSync', () => { throw new Error('synthetic read failure'); });
    const close = t.mock.method(fs, 'closeSync');
    try {
      assert.throws(() => readScorecardEvidence(path, root), /synthetic read failure/);
      assert.equal(close.mock.callCount(), 1);
    } finally {
      read.mock.restore();
      close.mock.restore();
    }
  });
});

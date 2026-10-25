'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { readBoundedFile } = require('./file-evidence.cjs');
const root = () => fs.mkdtempSync(path.join(process.env.FLUJO_QUALIFICATION_TEST_EVIDENCE ?? os.tmpdir(), 'flujo-fd-read-'));
function duringRead(action, read) {
  const original = fs.readSync; let changed = false;
  fs.readSync = (...args) => {
    const count = original(...args);
    if (!changed) { changed = true; action(); }
    return count;
  };
  try { return read(); } finally { fs.readSync = original; }
}
test('bounded descriptor reads accept exact EOF and refuse oversized or nonregular files', () => {
  const directory = root(), file = path.join(directory, 'record.json');
  fs.writeFileSync(file, '12345678');
  assert.equal(readBoundedFile(file, 8).toString(), '12345678');
  assert.throws(() => readBoundedFile(file, 7), /allowance/);
  assert.throws(() => readBoundedFile(directory, 8));
  const alias = path.join(root(), 'alias'); fs.symlinkSync(directory, alias, 'junction');
  assert.throws(() => readBoundedFile(path.join(alias, 'record.json'), 8), /redirects/);
});
test('descriptor reads reject actual growth, same-size mutation and name replacement while preserving evidence', () => {
  for (const kind of ['growth', 'mutation', 'replacement']) {
    const directory = root(), file = path.join(directory, 'record.json'); fs.writeFileSync(file, '123');
    const change = () => {
      if (kind === 'growth') fs.appendFileSync(file, 'x'.repeat(32));
      if (kind === 'mutation') { fs.writeFileSync(file, '456'); fs.utimesSync(file, new Date(), new Date(Date.now() + 2000)); }
      if (kind === 'replacement') { fs.renameSync(file, path.join(directory, 'original.json')); fs.writeFileSync(file, '123'); }
    };
    assert.throws(() => duringRead(change, () => readBoundedFile(file, 8)), /grew|changed/);
  }
});
test('Linux FIFO is rejected without waiting for a writer', { skip: process.platform !== 'linux' }, () => {
  const fifo = path.join(root(), 'unopened-fifo');
  execFileSync('mkfifo', [fifo], { timeout: 2000 });
  const script = "const assert=require('node:assert/strict');assert.throws(()=>require(process.argv[1]).readBoundedFile(process.argv[2],8),/not regular/);";
  execFileSync(process.execPath, ['-e', script, path.join(__dirname, 'file-evidence.cjs'), fifo], { timeout: 2000 });
});

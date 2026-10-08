import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const { OwnedCaptureLedger } = require('./fixtures/ownedCaptureLedger.cjs');

let root: string;
let parent: string;
let parentIdentity: string;
let rootIdentity: string;
const identity = (stat: import('node:fs').BigIntStats) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const handles: FileHandle[] = [];
beforeEach(async () => {
  parent = await fs.realpath(os.tmpdir());
  parentIdentity = identity(await fs.lstat(parent, { bigint: true }));
  root = await fs.mkdtemp(path.join(parent, 'flujo-owned-capture-'));
  rootIdentity = identity(await fs.lstat(root, { bigint: true }));
});
async function removeOwnedRoot() {
  const canonicalParent = await fs.realpath(path.dirname(root));
  const parentStat = await fs.lstat(parent, { bigint: true });
  const rootStat = await fs.lstat(root, { bigint: true });
  if (canonicalParent !== parent || parentStat.isSymbolicLink() || !parentStat.isDirectory()
      || identity(parentStat) !== parentIdentity || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || identity(rootStat) !== rootIdentity || await fs.realpath(root) !== root
      || path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith('flujo-owned-capture-')) {
    throw new Error('Unsafe owned capture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
}
afterEach(async () => {
  while (handles.length) {
    await handles[0].close();
    handles.shift(); // Failed close retains the actual handle and directory.
  }
  await removeOwnedRoot();
});
it('retains a genuine held descriptor after rejected disposal and removes it only after successful close', async () => {
  const handle = await fs.open(path.join(root, 'capture'), 'wx+'); handles.push(handle);
  await handle.writeFile('owned capture bytes');
  const ledger = new OwnedCaptureLedger();
  let rejectOnce = true;
  const capture = ledger.own({ dispose: async () => {
    // Controlled application disposal rejection with an actual open FD. This
    // proves retention/retry; it does not claim a natural OS close failure.
    if (rejectOnce) { rejectOnce = false; await handle.stat(); throw new Error('Controlled dispose rejection'); }
    await handle.close();
  } });
  await expect(ledger.dispose(capture)).rejects.toThrow('Controlled dispose rejection');
  expect(ledger.pending.has(capture)).toBe(true);
  expect((await handle.stat()).isFile()).toBe(true);
  await ledger.drain();
  expect(ledger.pending.size).toBe(0);
  await expect(handle.stat()).rejects.toThrow();
});
it('refuses a replacement directory and leaves its sentinel intact', async () => {
  const original = root + '-original';
  if (path.dirname(path.resolve(original)) !== parent || path.resolve(original) === parent) {
    throw new Error('Unsafe owned rename');
  }
  await fs.rename(root, original);
  await fs.mkdir(root);
  const sentinel = path.join(root, 'foreign-sentinel');
  await fs.writeFile(sentinel, 'must survive cleanup rejection');
  try {
    await expect(removeOwnedRoot()).rejects.toThrow('Unsafe owned capture cleanup');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('must survive cleanup rejection');
  } finally {
    // Remove only files/empty replacement created by this control, then restore
    // the original directory. Never recursively delete the replacement.
    await fs.unlink(sentinel);
    await fs.rmdir(root);
    await fs.rename(original, root);
  }
});

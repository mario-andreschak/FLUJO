import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readPinnedFile } from './pinned-file-read.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-pinned-read-'));
  const realRoot = await fs.realpath(root);
  const file = path.join(root, 'payload');
  await fs.writeFile(file, 'trusted');
  t.after(async () => {
    assert.equal(await fs.realpath(root), realRoot);
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    assert.ok(path.basename(realRoot).startsWith('flujo-pinned-read-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

test('bounded bytes and streaming hashes refer to the same regular file', async t => {
  const { file } = await fixture(t);
  const sha256 = createHash('sha256').update('trusted').digest('hex');
  assert.equal((await readPinnedFile(file, { maxBytes: 7, expectedBytes: 7, expectedSha256: sha256 })).toString(), 'trusted');
  assert.deepEqual(await readPinnedFile(file, { maxBytes: 7, collect: false }), { bytes: 7, sha256 });
  await assert.rejects(readPinnedFile(file, { maxBytes: 6 }), /shape\/size/);
  await assert.rejects(readPinnedFile(file, { maxBytes: 7, expectedSha256: '0'.repeat(64) }), /digest changed/);
});

test('replacement between checking and opening is rejected and the descriptor closes', async t => {
  const { root, file } = await fixture(t);
  const open = fs.open.bind(fs);
  let closed = false;
  t.mock.method(fs, 'open', async (...args) => {
    await fs.rename(file, path.join(root, 'original'));
    await fs.writeFile(file, 'trusted');
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed = true; await close(); };
    return handle;
  });
  await assert.rejects(readPinnedFile(file, { maxBytes: 7 }), /changed during open/);
  assert.equal(closed, true);
});

test('growth during reading is bounded and rejected', async t => {
  const { file } = await fixture(t);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    let reads = 0;
    handle.read = async (...readArgs) => {
      if (++reads === 1) await fs.appendFile(file, 'unexpected growth');
      return read(...readArgs);
    };
    return handle;
  });
  await assert.rejects(readPinnedFile(file, { maxBytes: 7 }), /grew beyond/);
});

test('directories, leaf links, and linked parents cannot provide pinned bytes', async t => {
  const { root, file } = await fixture(t);
  await assert.rejects(readPinnedFile(root, { maxBytes: 1024 }), /shape\/size/);
  const link = path.join(root, 'linked-parent');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'payload'), 'trusted');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readPinnedFile(path.join(link, 'payload'), { maxBytes: 7 }), /path changed/);
  if (process.platform !== 'win32') {
    const leaf = path.join(root, 'leaf-link');
    await fs.symlink(file, leaf);
    await assert.rejects(readPinnedFile(leaf, { maxBytes: 7 }), /shape\/size/);
  }
});

test('parent redirected around opening is refused before payload bytes are read', async t => {
  const { root } = await fixture(t);
  const parent = path.join(root, 'parent');
  await fs.mkdir(parent);
  const file = path.join(parent, 'payload');
  await fs.writeFile(file, 'trusted');
  const other = path.join(root, 'other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'payload'), 'trusted');
  const open = fs.open.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const redirect = async () => {
      await fs.rename(parent, path.join(root, 'original-parent'));
      await fs.symlink(other, parent, process.platform === 'win32' ? 'junction' : 'dir');
    };
    // Windows refuses moving a directory with an open descendant. Exercise
    // its parent swap immediately before open; POSIX also exercises it after.
    if (process.platform === 'win32') await redirect();
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { reads++; return read(...readArgs); };
    if (process.platform !== 'win32') await redirect();
    return handle;
  });
  await assert.rejects(readPinnedFile(file, { maxBytes: 7 }), /path changed|changed during open/);
  assert.equal(reads, 0);
});

test('an aborted read closes its descriptor', async t => {
  const { file } = await fixture(t);
  const controller = new AbortController();
  const open = fs.open.bind(fs);
  let closed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed = true; await close(); };
    controller.abort(new Error('test cancellation'));
    return handle;
  });
  await assert.rejects(readPinnedFile(file, { maxBytes: 7, signal: controller.signal }), /test cancellation/);
  assert.equal(closed, true);
});

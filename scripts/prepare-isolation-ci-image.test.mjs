import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import api from './prepare-isolation-ci-image.cjs';

test('linked runtime dependencies are exact paths and duplicate entries collapse', () => {
  assert.deepEqual(api.linkedLibraries('linux-vdso.so.1 (0xabc)\n libstdc++.so.6 => /lib/libstdc++.so.6 (0x123)\n /lib64/ld-linux.so.2 (0x123)\n libstdc++.so.6 => /lib/libstdc++.so.6 (0xabc)\n'),
    ['/lib/libstdc++.so.6', '/lib64/ld-linux.so.2']);
});
for (const output of ['', 'statically linked', 'libc.so.6 => not found', 'libc.so.6 => relative (0xabc)',
  '/lib/../secret (0xabc)', '/lib/file;echo (0xabc)', 'libc.so.6 => /lib/libc.so.6 (bad)', 'x'.repeat(65 * 1024)]) {
  test(`invalid dependency listing is denied: ${output.slice(0, 48) || 'empty'}`, () => {
    assert.throws(() => api.linkedLibraries(output), /Invalid runtime dependency list/);
  });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-isolation-ci-'));
  t.after(() => {
    const resolved = api.ownedContext(directory);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('copy/hash uses the exact bytes from one ordinary ELF descriptor', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'rootfs/runtime');
  const bytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(1024, 42)]);
  fs.writeFileSync(source, bytes);
  assert.deepEqual(api.copyRuntimeFile(source, destination), { size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.throws(() => api.copyRuntimeFile(source, destination), /exist/i);
});

test('non-ELF runtime bytes are denied', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  fs.writeFileSync(source, 'fixture-non-ELF');
  assert.throws(() => api.copyRuntimeFile(source, path.join(directory, 'copy')), /Invalid runtime file/);
});

test('short source reads preserve the ELF header and exact copied content', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'copy');
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
  fs.writeFileSync(source, bytes);
  const originalRead = fs.readSync;
  try {
    fs.readSync = (fd, buffer, offset, length, position) => originalRead(fd, buffer, offset, Math.min(length, 2), position);
    assert.equal(api.copyRuntimeFile(source, destination).size, bytes.length);
  } finally { fs.readSync = originalRead; }
  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('growth after admission is bounded and rejected', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  fs.writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const originalRead = fs.readSync;
  let first = true;
  try {
    fs.readSync = (...args) => {
      const result = originalRead(...args);
      if (first) { first = false; fs.appendFileSync(source, 'growth'); }
      return result;
    };
    assert.throws(() => api.copyRuntimeFile(source, path.join(directory, 'copy')), /Runtime file changed/);
  } finally { fs.readSync = originalRead; }
});

test('context cleanup refuses the temp root and an unrelated directory', () => {
  assert.throws(() => api.ownedContext(os.tmpdir()), /Unsafe isolation CI context/);
  assert.throws(() => api.ownedContext(path.join(os.tmpdir(), 'unrelated')), /Unsafe isolation CI context/);
});

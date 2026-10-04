import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
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

test('ownership and absence queries include untagged/intermediate images', () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const listing = args => args.includes('--all') ? `${image}\n` : '';
  assert.deepEqual(api.ownedImages(listing, 'fixture-generation'), [image]);
  assert.equal(listing(['image', 'ls', '--no-trunc']), '');
});

test('failure receipt retains stage and fixed codes while excluding command output and arbitrary error text', () => {
  const sentinel = 'synthetic-private-output';
  const commandError = Object.assign(new Error(sentinel), { code: 'ETIMEDOUT', status: null,
    stdout: sentinel, stderr: sentinel, env: { TOKEN: sentinel } });
  assert.deepEqual(api.preparationFailure('inspect-local-daemon', commandError), {
    stage: 'inspect-local-daemon', reason: 'system-error', code: 'ETIMEDOUT',
  });
  const failed = api.preparationFailure('build-runtime-image', Object.assign(new Error(sentinel), {
    code: sentinel, status: 1, stdout: sentinel, stderr: sentinel,
  }));
  assert.deepEqual(failed, { stage: 'build-runtime-image', reason: 'operation-failed', exitCode: 1 });
  assert.equal(JSON.stringify(failed).includes(sentinel), false);
  assert.deepEqual(api.preparationFailure('copy-runner-node', new Error('Invalid runtime file')), {
    stage: 'copy-runner-node', reason: 'invalid-runtime-file',
  });
});

test('actual CLI failure writes redacted diagnostics and observed owned-context cleanup', t => {
  const directory = fixture(t);
  const cliModule = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  const commands = [];
  const sentinel = 'synthetic-private-command-output';
  const requireCli = name => name === 'node:child_process' ? {
    execFileSync: (executable, args) => {
      assert.equal(executable, '/usr/bin/docker');
      commands.push(args);
      if (args.includes('info')) throw Object.assign(new Error(sentinel), { code: 'ETIMEDOUT', stderr: sentinel });
      assert.deepEqual(Array.from(args.slice(4, 7)), ['image', 'ls', '--all']);
      return '';
    },
  } : name === 'node:os' ? { ...os, tmpdir: () => directory } : nativeRequire(name);
  requireCli.main = cliModule;
  const cliProcess = { platform: 'linux', version: process.version, arch: process.arch, argv: [], env: {} };
  const output = [];
  vm.runInNewContext(fs.readFileSync(new URL('./prepare-isolation-ci-image.cjs', import.meta.url), 'utf8'), {
    require: requireCli, module: cliModule, __dirname: path.join(directory, 'scripts'), process: cliProcess,
    console: { error: value => output.push(value), log: value => output.push(value) }, Buffer,
  });
  assert.equal(cliProcess.exitCode, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, '.tmp/mcp-isolation-ci-image.json'), 'utf8'));
  assert.deepEqual(receipt.failure, { stage: 'inspect-local-daemon', reason: 'system-error', code: 'ETIMEDOUT' });
  assert.equal(receipt.cleanup, 'absent');
  assert.equal(receipt.contextRemoved, true);
  assert.equal(fs.existsSync(receipt.context), false);
  assert.equal(commands.length, 2);
  assert.equal(JSON.stringify([receipt, output]).includes(sentinel), false);
});

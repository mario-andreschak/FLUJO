'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readBoundedFileSync } = require('./read-bounded-file.cjs');

const dockerExecutable = '/usr/bin/docker';
const daemon = 'unix:///var/run/docker.sock';
const stateFile = path.resolve(__dirname, '../.tmp/mcp-isolation-ci-image.json');
const label = 'co.flujo.mcp-ci-generation';
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const generationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function linkedLibraries(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 64 * 1024) throw new Error('Invalid runtime dependency list');
  const libraries = new Set();
  for (const row of output.split('\n').map(value => value.trim()).filter(Boolean)) {
    if (/^linux-vdso\.so\.1 \(0x[a-f0-9]+\)$/.test(row)) continue;
    const match = /^(?:[A-Za-z0-9_.+-]+ => )?(\/[A-Za-z0-9_./+-]+) \(0x[a-f0-9]+\)$/.exec(row);
    if (!match || path.posix.normalize(match[1]) !== match[1]) throw new Error('Invalid runtime dependency list');
    libraries.add(match[1]);
  }
  if (libraries.size < 1 || libraries.size > 64) throw new Error('Invalid runtime dependency list');
  return [...libraries].sort();
}

function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every(key => a[key] === b[key]);
}

/** Copy/hash one bounded regular descriptor; never reopen a checked source for bytes. */
function copyRuntimeFile(source, destination) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const input = fs.openSync(source, flags);
  let output;
  try {
    const admitted = fs.fstatSync(input, { bigint: true });
    const named = fs.lstatSync(source, { bigint: true });
    if (!admitted.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(admitted, named)
        || admitted.size < 4n || admitted.size > 256n * 1024n * 1024n) throw new Error('Invalid runtime file');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    output = fs.openSync(destination, 'wx', 0o755);
    const buffer = Buffer.alloc(1024 * 1024);
    const magic = Buffer.alloc(4);
    let magicSize = 0;
    const hash = createHash('sha256');
    let size = 0;
    while (true) {
      const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, Number(admitted.size) + 1 - size), size);
      if (count === 0) break;
      if (magicSize < 4) {
        const bytes = Math.min(4 - magicSize, count);
        buffer.copy(magic, magicSize, 0, bytes);
        magicSize += bytes;
        if (magicSize === 4 && !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Invalid runtime file');
      }
      size += count;
      if (BigInt(size) > admitted.size) throw new Error('Runtime file changed');
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      let written = 0;
      while (written < count) {
        const countWritten = fs.writeSync(output, bytes, written, count - written);
        if (countWritten === 0) throw new Error('Runtime file copy did not progress');
        written += countWritten;
      }
    }
    if (BigInt(size) !== admitted.size || !sameFile(admitted, fs.fstatSync(input, { bigint: true }))
        || !sameFile(admitted, fs.lstatSync(source, { bigint: true }))) throw new Error('Runtime file changed');
    return { size, sha256: hash.digest('hex') };
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
}

function ownedContext(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^flujo-isolation-ci-[A-Za-z0-9]+$/.test(path.basename(resolved))) {
    throw new Error('Unsafe isolation CI context');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) {
    throw new Error('Unsafe isolation CI context');
  }
  return resolved;
}

function docker(state, args, timeout = 5000) {
  return execFileSync(dockerExecutable, ['--host', daemon, '--config', path.join(ownedContext(state.context), 'control'), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' }, encoding: 'utf8',
    timeout, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

// Keep diagnostics useful without retaining command output, environment or arbitrary error text.
function preparationFailure(stage, error) {
  const known = new Map([
    ['Linux Docker is unavailable', 'unsupported-daemon'],
    ['Invalid runtime dependency list', 'invalid-dependencies'],
    ['Invalid runtime file', 'invalid-runtime-file'],
    ['Runtime file changed', 'changed-runtime-file'],
    ['Runtime file copy did not progress', 'copy-did-not-progress'],
    ['Runtime image exceeds its size limit', 'runtime-size-limit'],
    ['Invalid isolation CI image identity', 'invalid-image-identity'],
    ['Invalid CI environment file', 'invalid-ci-environment-file'],
  ]);
  const code = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ELOOP', 'ETIMEDOUT', 'ENOSPC'].includes(error?.code)
    ? error.code : undefined;
  const exitCode = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : undefined;
  return { stage, reason: known.get(error?.message) || (code ? 'system-error' : 'operation-failed'),
    ...(code ? { code } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}

function ownedImages(runDocker, generation) {
  // The fixture is untagged. Default image ls may hide it as an intermediate image.
  return runDocker(['image', 'ls', '--all', '--no-trunc', '--filter', `label=${label}=${generation}`, '--format', '{{.ID}}'])
    .split('\n').filter(Boolean);
}

function cleanup(state) {
  if (state.schemaVersion !== 1 || !generationPattern.test(state.generation)
      || (state.image !== null && !imagePattern.test(state.image))) throw new Error('Invalid isolation CI receipt');
  ownedContext(state.context);
  const rows = ownedImages(args => docker(state, args), state.generation);
  if (rows.length > 1 || (rows.length === 1 && (!imagePattern.test(rows[0]) || (state.image && rows[0] !== state.image)))) {
    throw new Error('Isolation CI image ownership is unavailable');
  }
  if (rows.length === 1) {
    state.image = rows[0];
    const labels = JSON.parse(docker(state, ['image', 'inspect', state.image, '--format', '{{json .Config.Labels}}']));
    if (labels?.[label] !== state.generation) throw new Error('Isolation CI image ownership is unavailable');
    // Do not force removal over a container whose cleanup remains unknown.
    docker(state, ['image', 'rm', state.image]);
    if (ownedImages(args => docker(state, args), state.generation).length !== 0) {
      throw new Error('Isolation CI image cleanup is unavailable');
    }
  }
  state.cleanup = rows.length === 1 ? 'removed' : 'absent';
  fs.rmSync(ownedContext(state.context), { recursive: true });
  state.contextRemoved = true;
  writeState(state);
  return state;
}

function assembleRuntime(context, state) {
  ownedContext(context);
  state.stage = 'resolve-runner-node';
  const executable = fs.realpathSync.native(process.execPath);
  state.stage = 'list-runtime-dependencies';
  const dependencies = linkedLibraries(execFileSync('/usr/bin/ldd', [executable], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
  }));
  const files = [{ source: executable, destination: '/usr/local/bin/node' },
    ...dependencies.map(source => ({ source, destination: source }))];
  let totalBytes = 0;
  for (const file of files) {
    state.stage = file.source === executable ? 'copy-runner-node' : 'copy-runtime-library';
    const destination = path.join(context, 'rootfs', file.destination.slice(1));
    const copied = copyRuntimeFile(fs.realpathSync.native(file.source), destination);
    totalBytes += copied.size;
    if (totalBytes > 384 * 1024 * 1024) throw new Error('Runtime image exceeds its size limit');
    state.runtimeFiles.push({ source: file.source, destination: file.destination, ...copied });
  }
  state.stage = 'write-build-context';
  fs.mkdirSync(path.join(context, 'rootfs/tmp'), { mode: 0o1777 });
  fs.writeFileSync(path.join(context, '.dockerignore'), 'control\nimage.id\n');
  fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM scratch\nCOPY rootfs/ /\nENV PATH=/usr/local/bin\nLABEL ${label}="${state.generation}"\n`);
}

function prepare() {
  if (process.platform !== 'linux') throw new Error('Isolation CI image preparation requires Linux');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const receipt = fs.openSync(stateFile, 'wx', 0o600);
  fs.closeSync(receipt);
  const context = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-isolation-ci-'));
  const state = { schemaVersion: 1, generation: randomUUID(), context, image: null,
    node: process.version, architecture: process.arch, platform: process.platform, runtimeFiles: [], cleanup: 'pending',
    stage: 'create-control-directory' };
  writeState(state);
  try {
    fs.mkdirSync(path.join(context, 'control'));
    state.stage = 'inspect-local-daemon';
    if (docker(state, ['info', '--format', '{{.OSType}}']) !== 'linux') throw new Error('Linux Docker is unavailable');
    assembleRuntime(context, state);
    state.stage = 'build-runtime-image';
    docker(state, ['build', '--network=none', '--pull=false', '--quiet', '--iidfile', path.join(context, 'image.id'), context], 90_000);
    state.stage = 'read-image-identity';
    state.image = readBoundedFileSync(path.join(context, 'image.id'), 128).toString('utf8').trim();
    if (!imagePattern.test(state.image)) throw new Error('Invalid isolation CI image identity');
    const environment = { FLUJO_RUN_ISOLATION_SOURCE_PROBE: '1', FLUJO_TEST_ISOLATION_DOCKER: dockerExecutable,
      FLUJO_TEST_ISOLATION_DAEMON: daemon, FLUJO_TEST_ISOLATION_IMAGE: state.image };
    state.environment = environment;
    writeState(state);
    if (process.env.GITHUB_ENV) {
      state.stage = 'write-ci-environment';
      if (!path.isAbsolute(process.env.GITHUB_ENV)) throw new Error('Invalid CI environment file');
      const fd = fs.openSync(process.env.GITHUB_ENV, fs.constants.O_WRONLY | fs.constants.O_APPEND
        | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      try {
        if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid CI environment file');
        fs.writeFileSync(fd, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      } finally { fs.closeSync(fd); }
    }
    state.stage = 'ready';
    writeState(state);
    return state;
  } catch (error) {
    state.failure = preparationFailure(state.stage, error);
    try { cleanup(state); } catch { state.cleanup = 'unknown'; writeState(state); }
    throw new Error('Isolation CI image preparation failed; inspect its receipt');
  }
}

if (require.main === module) {
  try {
    const state = process.argv[2] === 'cleanup'
      ? cleanup(JSON.parse(readBoundedFileSync(stateFile, 64 * 1024).toString('utf8'))) : prepare();
    console.log(JSON.stringify({ image: state.image, node: state.node, runtimeFiles: state.runtimeFiles.length,
      cleanup: state.cleanup, contextRemoved: state.contextRemoved === true }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { linkedLibraries, copyRuntimeFile, ownedContext, assembleRuntime, ownedImages, preparationFailure };

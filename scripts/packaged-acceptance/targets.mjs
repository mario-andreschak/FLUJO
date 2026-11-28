// Start, stop and crash one shipped form of FLUJO: an installed npm package, an
// installed source checkout (what the Windows and shell installers leave
// behind) or a Docker image. Every form exposes the same small interface, so
// the checks in checks.mjs run unchanged against each of them.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import path from 'node:path';

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Check `condition` until it holds or the deadline passes; says which happened. */
export async function waitUntil(condition, { deadlineMs, intervalMs = 500, pause = delay }) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= until) return false;
    await pause(intervalMs);
  }
}

export async function waitFor(condition, { message, ...options }) {
  if (!(await waitUntil(condition, options))) throw new Error(message);
}

export async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/** True while something accepts connections on the loopback port. */
export function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(true));
  });
}

export async function waitForPortClosed(port, milliseconds = 15_000) {
  const until = Date.now() + milliseconds;
  while (await portOpen(port)) {
    if (Date.now() >= until) return false;
    await delay(200);
  }
  return true;
}

const tailBytes = 8 * 1024;
async function readTail(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; } finally { await handle?.close(); }
}

/**
 * Run a command to completion without a shell; keep bounded output for
 * diagnosis. `signal` ends it early with the signal's reason.
 */
export function runCommand(file, args, { cwd, env, timeoutMs = 10 * 60_000, spawnProcess = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; let stdoutBytes = 0; let stderr = '';
    let failure;
    const timer = setTimeout(() => { failure = new Error(`${path.basename(file)} ${args[0] ?? ''} did not finish within ${Math.round(timeoutMs / 1000)} s.`); child.kill('SIGKILL'); }, timeoutMs);
    const stop = () => { failure ??= signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)); child.kill('SIGKILL'); };
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', bytes => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > 64 * 1024 * 1024) { failure ??= new Error('Command output exceeded 64 MiB.'); child.kill('SIGKILL'); return; }
      stdout.push(bytes);
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16 * 1024); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure) return reject(failure);
      if (code !== 0) {
        const output = stderr.trim() || Buffer.concat(stdout).toString('utf8').slice(-4 * 1024);
        return reject(new Error(`${path.basename(file)} ${args.slice(0, 2).join(' ')} exited with ${exitSignal ?? code}.\n${output}`));
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

/** Official Node.js downloads keep npm next to node. */
export function npmCliCandidates({ execPath = process.execPath, platform = process.platform, env = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const runtime = paths.dirname(execPath);
  const candidates = [];
  if (env.npm_execpath && paths.basename(env.npm_execpath) === 'npm-cli.js') candidates.push(env.npm_execpath);
  candidates.push(platform === 'win32'
    ? paths.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : paths.join(runtime, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return candidates;
}

export async function resolveNpmCli(options) {
  for (const candidate of npmCliCandidates(options)) {
    try { if ((await stat(candidate)).isFile()) return path.resolve(candidate); } catch { /* try the next layout */ }
  }
  throw new Error('npm was not found next to this Node.js. Run the check with an official Node.js installation.');
}

/** Pack the built app and its public MCP packages exactly as a release does. */
export async function packCandidate({ root, directory, npmCli }) {
  const { prepareCandidate } = await import('../npm-release.mjs');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  await mkdir(directory, { recursive: true });
  const run = (_command, args) => execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return prepareCandidate({ run, directory, sha, version });
}

/** The tarballs of a release candidate folder, as listed in its manifest.json. */
export async function readCandidateTarballs(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.packages) || !manifest.packages.some(item => item?.name === 'flujo-ai')) {
    throw new Error('The candidate folder has no flujo-ai package in its manifest.json.');
  }
  const tarballs = [];
  for (const item of manifest.packages) {
    if (typeof item?.filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(item.filename)) {
      throw new Error('The candidate manifest names an unexpected file.');
    }
    const file = path.join(directory, item.filename);
    if (!(await stat(file)).isFile()) throw new Error(`Missing candidate tarball ${item.filename}.`);
    tarballs.push(file);
  }
  return { version: manifest.version, revision: manifest.revision, tarballs };
}

/** Install packages into a fresh consumer folder the way `npm install flujo-ai` does. */
export async function installNpmPackages({ consumer, specs, npmCli, env = process.env, attempts = 2, run = runCommand, pause = delay }) {
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  const installEnv = { ...env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  for (let attempt = 1; ; attempt++) {
    try {
      await run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...specs],
        { cwd: consumer, env: installEnv, timeoutMs: 20 * 60_000 });
      break;
    } catch (error) {
      // Registry downloads fail now and then; one more try settles most of them.
      if (attempt >= attempts) throw error;
      await pause(10_000);
    }
  }
  const appRoot = await realpath(path.join(consumer, 'node_modules', 'flujo-ai'));
  const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'flujo-ai') throw new Error('The installed package is not flujo-ai.');
  return { appRoot, version: manifest.version };
}

/** A private, repeatable environment for host processes; nothing from the runner's profile leaks in. */
export function hostEnvironment({ sandbox, dataDir, sandboxPort, node, snapshotToken, inherited = process.env }) {
  const keep = /^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles|programfiles\(x86\)|programw6432|programdata)$/i;
  const env = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => keep.test(key) && typeof value === 'string'));
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  if (node) env[pathKey] = [path.dirname(node), env[pathKey]].filter(Boolean).join(path.delimiter);
  const home = path.join(sandbox, 'home');
  const temp = path.join(sandbox, 'temp');
  return {
    ...env, CI: 'true', NO_COLOR: '1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    TEMP: temp, TMP: temp, TMPDIR: temp, npm_config_cache: path.join(sandbox, 'npm-cache'),
    FLUJO_DATA_DIR: dataDir, FLUJO_EXPOSURE_MODE: 'localhost',
    FLUJO_LOCAL_INSTANCE_DIR: path.join(sandbox, 'local-instances'),
    FLUJO_FS_ROOTS: path.join(sandbox, 'roots'), FLUJO_BASH_ROOTS: path.join(sandbox, 'roots'),
    FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort),
    ...(snapshotToken ? { FLUJO_SNAPSHOT_CONTROL_TOKEN: snapshotToken } : {}),
  };
}

export async function prepareHostSandbox(sandbox) {
  for (const name of ['home/roaming', 'home/local', 'temp', 'npm-cache', 'local-instances', 'roots', 'logs']) {
    await mkdir(path.join(sandbox, name), { recursive: true });
  }
}

/** How each host form is launched: the npm package's own CLI or the checkout's `npm start`. */
export function hostLaunch({ form, appRoot, port, node = process.execPath }) {
  if (form === 'npm') return { file: node, args: [path.join(appRoot, 'bin', 'flujo.mjs'), '--no-open', '--port', String(port)] };
  if (form === 'checkout') return { file: node, args: [path.join(appRoot, 'scripts', 'launch-next.mjs'), 'start', '-p', String(port)] };
  throw new Error(`Unknown host form ${form}.`);
}

/** The answering process must be this app root and keep its data under this data folder. */
export function assertHostIdentity(observed, { appRoot, dataDir, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  if (typeof observed?.cwd !== 'string' || typeof observed.mcpServersDir !== 'string'
      || fold(appRoot) !== fold(observed.cwd)) {
    throw new Error('Another program answered on the test port; nothing was changed.');
  }
  const relative = paths.relative(fold(dataDir), fold(observed.mcpServersDir));
  if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) {
    throw new Error('The app keeps its data outside the test data folder; nothing was changed.');
  }
}

export function assertContainerIdentity(observed) {
  if (observed?.cwd !== '/app' || typeof observed.mcpServersDir !== 'string' || !observed.mcpServersDir.startsWith('/app/data/')) {
    throw new Error('The container does not keep its data in /app/data; nothing was changed.');
  }
}

export function createRequester(baseUrl, { fetchImpl = fetch } = {}) {
  async function request(route, { timeoutMs = 60_000, ...options } = {}) {
    const response = await fetchImpl(new URL(route, baseUrl), { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const chunks = []; let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error(`${route} answered with more than 16 MiB.`);
      chunks.push(chunk);
    }
    return { status: response.status, bytes: Buffer.concat(chunks) };
  }
  /** Start a request without reading its answer; `abort` ends it from this side. */
  request.open = (route, { timeoutMs = 60_000, ...options } = {}) => {
    const controller = new AbortController();
    const response = fetchImpl(new URL(route, baseUrl), { ...options, redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
    response.catch(() => {});
    return { response, abort: () => controller.abort() };
  };
  return request;
}

function taskkill(pid) {
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => resolve(null));
    killer.once('close', code => resolve(code));
  });
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * A FLUJO started as a host process. POSIX processes get their own process
 * group so stop and crash reach every helper they start. Windows has no gentle
 * stop signal for console programs, so a normal stop there ends the process
 * tree, exactly like closing its window.
 */
export function createHostTarget({ label, launch, cwd, env, port, logDirectory, identity, stopGraceMs = 30_000,
  platform = process.platform, spawnProcess = spawn }) {
  const snapshotToken = env?.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  let current = null;
  let generation = 0;
  const request = createRequester(`http://127.0.0.1:${port}`);
  const waitForExit = (milliseconds) => withTimeout(current.exited, milliseconds, `${label} did not exit within ${Math.round(milliseconds / 1000)} s.`);
  async function end(kind) {
    if (!current) return { target: label, kind, mode: 'not running' };
    const started = Date.now();
    const record = { target: label, kind, generation: current.generation, pid: current.pid };
    if (current.exit) {
      record.mode = 'had already exited';
    } else if (platform === 'win32') {
      record.mode = kind === 'stop' ? 'process tree ended (Windows has no gentle stop for console programs)' : 'process tree killed';
      record.taskkill = await taskkill(current.pid);
    } else if (kind === 'stop') {
      record.mode = 'SIGTERM to the process group';
      signalGroup(current.pid, 'SIGTERM');
      try { await waitForExit(stopGraceMs); } catch {
        record.graceful = false;
        record.mode += `, then SIGKILL after ${Math.round(stopGraceMs / 1000)} s`;
        signalGroup(current.pid, 'SIGKILL');
      }
    } else {
      record.mode = 'SIGKILL to the process group';
      signalGroup(current.pid, 'SIGKILL');
    }
    await waitForExit(30_000);
    record.exit = current.exit;
    if (platform !== 'win32') {
      // Helpers that outlive a normal stop are reported, then removed.
      const until = Date.now() + 3_000;
      while (signalGroup(current.pid, 0) && Date.now() < until) await delay(100);
      const leftovers = signalGroup(current.pid, 'SIGKILL');
      if (kind === 'stop') record.leftoverHelpers = leftovers;
      if (kind === 'stop' && record.graceful !== false) {
        const { code, signal } = current.exit;
        record.graceful = code === 0 || code === 143 || signal === 'SIGTERM' || signal === 'SIGINT';
      }
    }
    record.portClosed = await waitForPortClosed(port);
    record.seconds = Math.round((Date.now() - started) / 100) / 10;
    return record;
  }
  return {
    label, port, request, snapshotToken,
    assertIdentity: identity,
    async start() {
      if (current && !current.exit) throw new Error(`${label} is already running.`);
      generation += 1;
      const log = path.join(logDirectory, `${label}-${generation}.log`);
      const fd = openSync(log, 'a');
      let child;
      try {
        child = spawnProcess(launch.file, launch.args, { cwd, env, windowsHide: true,
          detached: platform !== 'win32', stdio: ['ignore', fd, fd] });
      } finally { closeSync(fd); }
      const record = { generation, pid: child.pid, log, exit: null };
      record.exited = new Promise(resolve => {
        child.once('error', error => { record.exit ??= { code: null, signal: null, error: error.message }; resolve(record.exit); });
        child.once('exit', (code, signal) => { record.exit ??= { code, signal }; resolve(record.exit); });
      });
      current = record;
    },
    async running() { return Boolean(current && !current.exit); },
    async diagnostics() { return current ? readTail(current.log) : ''; },
    stop: () => end('stop'),
    kill: () => end('kill'),
    async dispose() {
      if (current && !current.exit) await end('kill');
    },
  };
}

const IMAGE_REFERENCE = /^(?:sha256:[a-f0-9]{64}|(?!sha256:)[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?)$/;
export const isImageReference = value => typeof value === 'string' && value.length <= 256 && IMAGE_REFERENCE.test(value);
export const OWNER_LABEL = 'io.flujo.packaged-acceptance';
/** The name containers use to reach the stand-ins on the Docker host. */
export const DOCKER_HOST_NAME = 'flujo-acceptance-host';

export function dockerCommand(args, { timeoutMs = 120_000 } = {}) {
  return runCommand('docker', args, { timeoutMs });
}

/**
 * Where the stand-ins listen so containers reach them: the bridge gateway on a
 * Linux Docker host, loopback on Docker Desktop (which forwards host-gateway
 * traffic to the host's loopback).
 */
export async function dockerStandInHost(docker = dockerCommand) {
  const system = (await docker(['info', '--format', '{{.OperatingSystem}}'])).trim();
  if (/docker desktop/i.test(system)) return '127.0.0.1';
  const gateway = (await docker(['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}']))
    .trim().split(/\s+/).find(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
  if (!gateway) throw new Error('The Docker bridge network has no IPv4 gateway for the stand-ins to listen on.');
  return gateway;
}

/** Pull an image reference (an image ID is used as it is) and return its ID. */
export async function prepareDockerImage(image, { docker = dockerCommand, pause = delay } = {}) {
  if (!image.startsWith('sha256:')) {
    for (let attempt = 1; ; attempt++) {
      try { await docker(['pull', image], { timeoutMs: 15 * 60_000 }); break; } catch (error) {
        // A registry hiccup should not fail the check; three tries settle it.
        if (attempt >= 3) throw error;
        await pause(attempt * 5_000);
      }
    }
  }
  return (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
}

/**
 * A FLUJO container. Restarts reuse the container, like a restart policy does.
 * `mount` is the `--mount` value of its data volume (see low-disk.mjs).
 */
export function createDockerTarget({ label, image, name, mount, port, docker = dockerCommand, pause = delay }) {
  let created = false;
  let imageId;
  const request = createRequester(`http://127.0.0.1:${port}`);
  async function exitCode() {
    return Number((await docker(['inspect', '--format', '{{.State.ExitCode}}', name])).trim());
  }
  async function end(kind) {
    if (!created) return { target: label, kind, mode: 'not running' };
    const started = Date.now();
    const record = { target: label, kind };
    if (kind === 'stop') {
      record.mode = 'docker stop (SIGTERM, 30 s grace)';
      await docker(['stop', '--time', '30', name], { timeoutMs: 90_000 });
      record.exit = { code: await exitCode() };
      record.graceful = record.exit.code !== 137;
    } else {
      record.mode = 'docker kill (SIGKILL)';
      await docker(['kill', name]);
      record.exit = { code: await exitCode() };
    }
    record.portClosed = await waitForPortClosed(port);
    record.seconds = Math.round((Date.now() - started) / 100) / 10;
    return record;
  }
  return {
    label, port, request,
    assertIdentity: assertContainerIdentity,
    get imageId() { return imageId; },
    async prepare() { imageId = await prepareDockerImage(image, { docker, pause }); },
    async start() {
      if (!created) {
        await docker(['run', '--detach', '--name', name, '--label', `${OWNER_LABEL}=${label}`,
          '--publish', `127.0.0.1:${port}:4200`, '--mount', mount, '--add-host', `${DOCKER_HOST_NAME}:host-gateway`, imageId ?? image]);
        created = true;
      } else {
        await docker(['start', name]);
      }
    },
    async running() {
      try { return (await docker(['inspect', '--format', '{{.State.Running}}', name])).trim() === 'true'; } catch { return false; }
    },
    async diagnostics() {
      try { return (await docker(['logs', '--tail', '200', name])).slice(-tailBytes); } catch { return ''; }
    },
    stop: () => end('stop'),
    kill: () => end('kill'),
    /** Remove the container but keep the volume, as an image upgrade does. */
    async remove() {
      if (created) await docker(['rm', '--force', name]);
      created = false;
    },
    async dispose() {
      if (created) await docker(['rm', '--force', name]);
      created = false;
    },
  };
}

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const BUILD_COMMAND = 'npm run build:mcp';
const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_POLL_MS = 500;
const BUILD_TIMEOUT_MS = 10 * 60_000;
// No wait plus build takes this long; an older lock outlived a crash or a reused process id.
const LOCK_STALE_MS = LOCK_WAIT_MS + 2 * BUILD_TIMEOUT_MS;

/** Bundled MCP packages under `mcp-servers/` whose `dist/index.js` has not been built yet. */
function unbuiltMcpPackages(rootDir) {
  const serversRoot = path.join(path.resolve(rootDir), 'mcp-servers');
  let entries;
  try {
    entries = fs.readdirSync(serversRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(serversRoot, entry.name, 'package.json')))
    .filter((entry) => !fs.existsSync(path.join(serversRoot, entry.name, 'dist', 'index.js')))
    .map((entry) => entry.name)
    .sort();
}

function formatUnbuiltMcpMessage(names, rootDir) {
  return `The bundled MCP packages are not built yet: ${names.join(', ')} `
    + `(mcp-servers/<name>/dist is missing). Run \`${BUILD_COMMAND}\` once in ${path.resolve(rootDir)}, then try again.`;
}

/** Building is safe only in a source checkout with its own TypeScript install. */
function buildableFromSource(rootDir, names) {
  const root = path.resolve(rootDir);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof manifest.scripts?.['build:mcp'] !== 'string') return false;
  } catch {
    return false;
  }
  if (!fs.existsSync(path.join(root, 'node_modules', 'typescript', 'package.json'))) return false;
  return names.every((name) => fs.existsSync(path.join(root, 'mcp-servers', name, 'src')));
}

/** Official Node.js downloads keep npm next to node; `npm run` names its own CLI. */
function npmInvocation({ execPath = process.execPath, platform = process.platform, env = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const runtime = paths.dirname(execPath);
  const candidates = [
    ...(env.npm_execpath && paths.basename(env.npm_execpath) === 'npm-cli.js' ? [env.npm_execpath] : []),
    platform === 'win32'
      ? paths.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : paths.join(runtime, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (cli) return { file: execPath, args: [cli], shell: false };
  return { file: platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: platform === 'win32' };
}

function runNpmBuild(rootDir, { timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  const npm = npmInvocation();
  return new Promise((resolve) => {
    const child = spawn(npm.file, [...npm.args, 'run', 'build:mcp'], {
      cwd: rootDir, stdio: ['ignore', 'inherit', 'inherit'], shell: npm.shell, windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, detail: error.message }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, detail: `exited with ${signal ?? code}` });
    });
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function parseLockOwner(text) {
  try {
    const owner = JSON.parse(text);
    return { pid: Number(owner.pid), startedAt: Number(owner.startedAt) };
  } catch {
    return { pid: 0, startedAt: 0 };
  }
}

/** Remove a lock only while it still holds the content that was judged. */
async function removeLockIfUnchanged(lockFile, judged) {
  if ((await fsp.readFile(lockFile, 'utf8').catch(() => undefined)) === judged) await fsp.rm(lockFile, { force: true });
}

/**
 * One build per checkout at a time. The lock appears with its full content (a
 * hard link of a finished file), so a reader never sees it half written. A lock
 * whose owner is gone, or far older than any build, is removed so a crashed
 * build never blocks the next one.
 */
async function acquireBuildLock(lockFile, { waitMs, pollMs, isBuilt }) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  const id = randomUUID();
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now(), id });
  const draft = `${lockFile}.${id}`;
  await fsp.writeFile(draft, content, { flag: 'wx' });
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await fsp.link(draft, lockFile);
        return { release: () => removeLockIfUnchanged(lockFile, content) };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const held = await fsp.readFile(lockFile, 'utf8').catch(() => undefined);
      if (held === undefined) continue;
      const holder = parseLockOwner(held);
      if (!processAlive(holder.pid) || Date.now() - holder.startedAt > LOCK_STALE_MS) {
        await removeLockIfUnchanged(lockFile, held);
        continue;
      }
      if (isBuilt() || Date.now() >= deadline) return undefined;
      await sleep(pollMs);
    }
  } finally {
    await fsp.rm(draft, { force: true });
  }
}

/**
 * Build the bundled MCP packages when a source checkout has not built them yet.
 * Never throws: when building is unsafe or fails, it says which packages are
 * missing and the exact command, and the caller carries on.
 */
async function ensureBundledMcpBuilt(rootDir, {
  log = (line) => process.stderr.write(`${line}\n`),
  build = runNpmBuild,
  lockWaitMs = LOCK_WAIT_MS,
  lockPollMs = LOCK_POLL_MS,
} = {}) {
  const root = path.resolve(rootDir);
  const missing = unbuiltMcpPackages(root);
  if (missing.length === 0) return { built: false, missing };
  if (!buildableFromSource(root, missing)) {
    log(formatUnbuiltMcpMessage(missing, root));
    return { built: false, missing };
  }
  const isBuilt = () => unbuiltMcpPackages(root).length === 0;
  let lock;
  let coordinated = true;
  try {
    lock = await acquireBuildLock(path.join(root, 'node_modules', '.cache', 'flujo-build-mcp.lock'), {
      waitMs: lockWaitMs, pollMs: lockPollMs, isBuilt,
    });
  } catch {
    coordinated = false;
  }
  try {
    if (isBuilt()) return { built: false, missing: [] };
    if (coordinated && !lock) {
      log(`Another MCP package build is still running. ${formatUnbuiltMcpMessage(unbuiltMcpPackages(root), root)}`);
      return { built: false, missing: unbuiltMcpPackages(root) };
    }
    log(`Building the bundled MCP packages (${missing.join(', ')}) with \`${BUILD_COMMAND}\`; this happens once per checkout.`);
    const result = await build(root);
    const left = unbuiltMcpPackages(root);
    if (result.ok && left.length === 0) return { built: true, missing: [] };
    log(`The automatic MCP package build ${result.ok ? 'left packages unbuilt' : `failed (${result.detail})`}. `
      + formatUnbuiltMcpMessage(left.length > 0 ? left : missing, root));
    return { built: false, missing: left };
  } finally {
    await lock?.release();
  }
}

module.exports = {
  BUILD_COMMAND,
  buildableFromSource,
  ensureBundledMcpBuilt,
  formatUnbuiltMcpMessage,
  npmInvocation,
  unbuiltMcpPackages,
};

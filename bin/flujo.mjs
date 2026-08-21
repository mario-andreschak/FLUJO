#!/usr/bin/env node
/**
 * `flujo` / `npx flujo-ai` entry point (issue #59).
 *
 * Runs a *prebuilt* FLUJO out of the installed npm package — no git clone, no
 * local `next build`. It:
 *   1. Puts user data in ~/.flujo by default (FLUJO_DATA_DIR override honored),
 *      so nothing is written into the read-only package install dir.
 *   2. Marks the install mode as 'npm' (FLUJO_NPM=1) so the update route/UI show
 *      "reinstall the package" instead of a broken git-pull button.
 *   3. Applies the exact same child-process env handling as `npm start` by reusing
 *      buildLaunchEnv() from scripts/launch-next.mjs (single source of truth).
 *   4. Starts Next's own `next start` from the package's bundled node_modules,
 *      with cwd = package root so the packaged `.next` build is found.
 *
 * Flags: --port <n> / FLUJO_PORT (default 4200); --no-open to suppress the
 * browser auto-open.
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import nextEnv from '@next/env';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Package root is the parent of bin/ — where package.json and the built .next live.
const packageRoot = path.resolve(__dirname, '..');

// The package installation is read-only. Load the standard Next.js dotenv
// stack from the stable writable bootstrap directory before reading port/data
// settings, so launcher-level variables work exactly like server-level ones.
const bootstrapRoot = path.join(os.homedir(), '.flujo');
fs.mkdirSync(bootstrapRoot, { recursive: true });
process.env.FLUJO_RUNTIME_ENV_DIR = bootstrapRoot;
nextEnv.loadEnvConfig(bootstrapRoot, false);

// --- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');

function readPort() {
  const idx = argv.findIndex((a) => a === '--port' || a === '-p');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  const eq = argv.find((a) => a.startsWith('--port='));
  if (eq) {
    return eq.slice('--port='.length);
  }
  return process.env.FLUJO_PORT || '4200';
}
const port = readPort();

// --- data dir --------------------------------------------------------------
// Default writable data location for a packaged install. A git checkout keeps
// data in the repo; the npm package keeps it in the user's home so upgrades
// (reinstalls) never touch it.
if (!process.env.FLUJO_DATA_DIR || process.env.FLUJO_DATA_DIR.trim().length === 0) {
  process.env.FLUJO_DATA_DIR = path.join(os.homedir(), '.flujo');
}
try {
  fs.mkdirSync(process.env.FLUJO_DATA_DIR, { recursive: true });
} catch (error) {
  console.error(`[FLUJO] Could not create data directory ${process.env.FLUJO_DATA_DIR}:`, error);
  process.exit(1);
}

// Tell the running server it was installed via npm so it reports the right update mode.
process.env.FLUJO_NPM = '1';
// Keep install-specific paths runtime-only. Built-in MCP configs persist a portable
// `npx --no-install` command and resolve it from this root when each child starts.
process.env.FLUJO_APP_ROOT = packageRoot;
if (!process.env.FLUJO_BASE_URL || process.env.FLUJO_BASE_URL.trim().length === 0) {
  process.env.FLUJO_BASE_URL = `http://127.0.0.1:${port}`;
}

// --- build child-process env, reusing the launcher's single source of truth -
const { buildLaunchEnv } = await import(pathToFileURL(path.join(packageRoot, 'scripts', 'launch-next.mjs')).href);
const { applyExposureRuntimeEnv, withExposureHostname } = await import(
  pathToFileURL(path.join(packageRoot, 'scripts', 'exposure-mode.mjs')).href
);
const env = applyExposureRuntimeEnv(buildLaunchEnv(process.env), packageRoot);

// --- resolve Next's own CLI from the package's bundled node_modules ---------
// Never rely on a `next` on the user's PATH — run the exact version this package
// was built against.
let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next');
} catch (error) {
  console.error('[FLUJO] Could not locate the bundled Next.js binary. The package install may be corrupt.', error);
  process.exit(1);
}

const url = `http://localhost:${port}`;
console.log(`[FLUJO] Starting on ${url} [exposure: ${env.FLUJO_EXPOSURE_MODE}]`);
console.log(`[FLUJO] Data directory: ${process.env.FLUJO_DATA_DIR}`);

const nextArgs = withExposureHostname(['start', '-p', String(port)], env);
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  stdio: 'inherit',
  cwd: packageRoot,
  env,
});

let requestedSignal;
let forceKillTimer;
let openerTimer;

function forwardShutdown(signal) {
  requestedSignal ??= signal;
  if (openerTimer) clearTimeout(openerTimer);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    child.kill();
  }
  // A packaged launcher must never leave `next start` orphaned. Give Next a
  // conservative grace period for its own MCP cleanup, then force termination.
  forceKillTimer ??= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10_000);
  forceKillTimer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => forwardShutdown(signal));
}

child.on('error', (error) => {
  console.error('[FLUJO] Failed to launch:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  const exitSignal = requestedSignal ?? signal;
  // Preserve signal semantics on POSIX after the child is gone. Windows does
  // not support re-raising every POSIX signal, so use the child's exit code.
  if (exitSignal && process.platform !== 'win32') {
    process.removeAllListeners(exitSignal);
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exit(code ?? (signal ? 1 : 0));
});

// --- browser auto-open (best-effort) ---------------------------------------
if (!noOpen) {
  const openCommand =
    process.platform === 'win32' ? { cmd: 'cmd', args: ['/c', 'start', '""', url] }
    : process.platform === 'darwin' ? { cmd: 'open', args: [url] }
    : { cmd: 'xdg-open', args: [url] };
  // Give `next start` a moment to bind the port before opening the browser.
  openerTimer = setTimeout(() => {
    try {
      const opener = spawn(openCommand.cmd, openCommand.args, { stdio: 'ignore', detached: true });
      opener.on('error', () => { /* no browser / headless — ignore */ });
      opener.unref();
    } catch {
      /* best-effort only */
    }
  }, 2000);
  openerTimer.unref();
}

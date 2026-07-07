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
 *   3. Applies the exact same TLS/CA env handling as `npm start` by reusing
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

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Package root is the parent of bin/ — where package.json and the built .next live.
const packageRoot = path.resolve(__dirname, '..');

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

// --- build env (TLS/CA), reusing the launcher's single source of truth ------
const { buildLaunchEnv } = await import(pathToFileURL(path.join(packageRoot, 'scripts', 'launch-next.mjs')).href);
const env = buildLaunchEnv(process.env);

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
console.log(`[FLUJO] Starting on ${url}`);
console.log(`[FLUJO] Data directory: ${process.env.FLUJO_DATA_DIR}`);

const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
  stdio: 'inherit',
  cwd: packageRoot,
  env,
});

child.on('error', (error) => {
  console.error('[FLUJO] Failed to launch:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

// --- browser auto-open (best-effort) ---------------------------------------
if (!noOpen) {
  const openCommand =
    process.platform === 'win32' ? { cmd: 'cmd', args: ['/c', 'start', '""', url] }
    : process.platform === 'darwin' ? { cmd: 'open', args: [url] }
    : { cmd: 'xdg-open', args: [url] };
  // Give `next start` a moment to bind the port before opening the browser.
  setTimeout(() => {
    try {
      const opener = spawn(openCommand.cmd, openCommand.args, { stdio: 'ignore', detached: true });
      opener.on('error', () => { /* no browser / headless — ignore */ });
      opener.unref();
    } catch {
      /* best-effort only */
    }
  }, 2000);
}

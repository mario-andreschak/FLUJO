// Starts a throwaway FLUJO from this checkout's production build (`npm run build`) for the first-use
// journey: an empty data folder, a free port (never 4200), and the Node heap capped at 4 GB so it fits
// on a shared machine. stop() ends the whole process tree and deletes only the data folder it made.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, isAlive, probe, tail } from '../flujo-drive.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HEAP_MB = 4096;
const DATA_DIR_PREFIX = 'flujo-journey-data-';

export function hasProductionBuild(root = ROOT) {
  try {
    return readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** Keeps every NODE_OPTIONS entry and adds the heap cap unless one is already set. */
export function cappedNodeOptions(current = '', heapMb = HEAP_MB) {
  const options = current.trim();
  if (/--max-old-space-size[= ]/.test(options)) return options;
  return [options, `--max-old-space-size=${heapMb}`].filter(Boolean).join(' ');
}

function stopTree(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 250); });
  return !isAlive(pid);
}

export async function startProductionFlujo({ root = ROOT, logFile, log = console.log, timeoutMs = 180_000 } = {}) {
  if (!hasProductionBuild(root)) {
    throw new Error(`No production build in ${root}. Run "npm run build" first, or pass --base-url to drive a FLUJO that is already running.`);
  }
  const [port, sandboxPort] = [await freePort(), await freePort()];
  const dataDir = mkdtempSync(path.join(os.tmpdir(), DATA_DIR_PREFIX));
  mkdirSync(path.dirname(logFile), { recursive: true });
  const out = openSync(logFile, 'w');
  const baseUrl = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, ['scripts/launch-next.mjs', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: cappedNodeOptions(process.env.NODE_OPTIONS),
      FLUJO_DATA_DIR: dataDir,
      FLUJO_RUNTIME_ENV_DIR: dataDir,
      FLUJO_PORT: String(port),
      FLUJO_BASE_URL: baseUrl.slice(0, -1),
      FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1',
      FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort),
      // A check run is not a person using FLUJO: send no daily check-in.
      FLUJO_TELEMETRY_URL: 'http://127.0.0.1:9/disabled-telemetry',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopTree(child.pid);
    if (!(await waitForExit(child.pid, 15_000)) && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await waitForExit(child.pid, 5_000);
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    if (existsSync(dataDir)) log(`! Could not remove the journey data folder ${dataDir}; delete it by hand.`);
  };
  log(`Starting FLUJO from the production build at ${baseUrl} (pid ${child.pid}, data ${dataDir}, heap ${HEAP_MB} MB).`);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (!isAlive(child.pid)) throw new Error(`FLUJO exited during startup. Last log lines:\n${tail(logFile)}`);
      const { api, page } = await probe(baseUrl);
      if (api && page) break;
      if (Date.now() > deadline) throw new Error(`FLUJO did not answer within ${timeoutMs / 1000}s. Last log lines:\n${tail(logFile)}`);
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
    }
  } catch (error) {
    await stop();
    throw error;
  }
  log(`Ready: ${baseUrl}\nLog: ${logFile}`);
  return { baseUrl, dataDir, logFile, stop };
}

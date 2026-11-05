/**
 * `flujo service run`: keeps one named instance alive. Started by Task Scheduler
 * or systemd, never by a person.
 *
 * The operating system restarts this supervisor. The supervisor restarts FLUJO.
 * Task Scheduler's own "restart on failure" reacts to a task that could not start,
 * not reliably to a program that started and later crashed, so that job is done here.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isProcessAlive, killProcessTree, processCommandLine, readJsonIfPresent, sleep, writeJsonAtomicSync } from './common.mjs';
import { rootPaths } from './managed-root.mjs';
import { logLimitsFromEnv, RotatingLog } from './rotating-log.mjs';

const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
/** A run this long counts as healthy again, so old crashes stop adding delay. */
const STABLE_RUN_MS = 10 * 60 * 1000;
const POLL_MS = 500;
/** Served by Next itself: no storage, no login, and it answers during migration. */
const LIVENESS_PATH = '/favicon.ico';
const DEFAULT_HANG_RESTART_MS = 10 * 60 * 1000;
const DEFAULT_LIVENESS_INTERVAL_MS = 60 * 1000;

export function nextBackoffMs(failuresInARow) {
  return BACKOFF_STEPS_MS[Math.min(Math.max(failuresInARow, 1) - 1, BACKOFF_STEPS_MS.length - 1)];
}

function millisecondsSetting(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Only one supervisor per instance. A lock left by a dead process is taken over. */
export function acquireSupervisorLock(lockFile, { pid = process.pid, alive = isProcessAlive } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(handle, String(pid));
      fs.closeSync(handle);
      return { acquired: true, release: () => fs.rmSync(lockFile, { force: true }) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = Number.NaN;
      try { holder = Number(fs.readFileSync(lockFile, 'utf8').trim()); }
      catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      if (holder === pid) return { acquired: true, release: () => fs.rmSync(lockFile, { force: true }) };
      if (alive(holder)) return { acquired: false, holder };
      fs.rmSync(lockFile, { force: true });
    }
  }
  return { acquired: false };
}

export function portIsFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = free => { socket.destroy(); resolve(free); };
    socket.once('connect', () => done(false));
    socket.once('error', () => done(true));
    socket.setTimeout(2_000, () => done(false));
  });
}

/** Local-instance records name the real server process of this data directory. */
export function instanceRecordsFor(dataDir, directory) {
  let names;
  try { names = fs.readdirSync(directory); }
  catch { return []; }
  const wanted = path.resolve(dataDir);
  const same = process.platform === 'win32'
    ? value => value.toLowerCase() === wanted.toLowerCase()
    : value => value === wanted;
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const record = readJsonIfPresent(file);
    if (typeof record?.dataRoot === 'string' && same(path.resolve(record.dataRoot)) && Number.isSafeInteger(record.pid)) {
      records.push({ file, pid: record.pid });
    }
  }
  return records;
}

/**
 * When a supervisor is killed outright its FLUJO keeps running and holds the port.
 * Clean that up, but check each process first: process numbers get reused, and a
 * process that is not ours must never be stopped.
 */
export function stopLeftovers({ root, dataDir, port, instanceDirectory, log, helpers = {} }) {
  const commandLine = helpers.processCommandLine ?? processCommandLine;
  const kill = helpers.killProcessTree ?? killProcessTree;
  const alive = helpers.isProcessAlive ?? isProcessAlive;
  const paths = rootPaths(root);
  const state = readJsonIfPresent(paths.state);
  const candidates = [];
  if (Number.isSafeInteger(state?.childPid)) candidates.push({ pid: state.childPid, marker: paths.launcher });
  for (const record of instanceRecordsFor(dataDir, instanceDirectory)) {
    candidates.push({ pid: record.pid, marker: String(port), recordFile: record.file });
  }
  let stopped = 0;
  for (const candidate of candidates) {
    if (alive(candidate.pid)) {
      const line = commandLine(candidate.pid);
      const normalized = line?.toLowerCase();
      if (normalized && normalized.includes(candidate.marker.toLowerCase())
        && (candidate.recordFile ? normalized.includes('next') : true)) {
        log?.line(`Stopping process ${candidate.pid}, left over from an earlier run.`);
        if (kill(candidate.pid)) stopped += 1;
      }
    } else if (candidate.recordFile) fs.rmSync(candidate.recordFile, { force: true });
  }
  return stopped;
}

async function responds(port, timeoutMs) {
  try {
    await fetch(`http://127.0.0.1:${port}${LIVENESS_PATH}`, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch { return false; }
}

/** Runs until a stop is requested. Returns the process exit code. */
export async function runSupervisor({ name, dataDir, port, root, env = process.env, instanceDirectory, program, hooks = {} }) {
  const paths = rootPaths(root);
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const lock = acquireSupervisorLock(paths.lock);
  if (!lock.acquired) {
    console.log(`[FLUJO] The instance "${name}" already has a running supervisor.`);
    return 0;
  }
  const log = new RotatingLog(paths.logFile, logLimitsFromEnv(env));
  let child = null;
  let stopping = false;
  let exitCode = 0;
  const writeState = patch => {
    const previous = readJsonIfPresent(paths.state) ?? {};
    try { writeJsonAtomicSync(paths.state, { ...previous, ...patch, updatedAt: new Date().toISOString() }); }
    catch { log.failures += 1; }
  };
  const stopRequested = () => stopping || fs.existsSync(paths.stopRequest);
  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    killProcessTree(child.pid);
    const deadline = Date.now() + 25_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid, { signal: 'SIGKILL' });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true; });

  const hangRestartMs = millisecondsSetting(env.FLUJO_SERVICE_HANG_RESTART_MS, DEFAULT_HANG_RESTART_MS);
  const livenessIntervalMs = millisecondsSetting(env.FLUJO_SERVICE_LIVENESS_INTERVAL_MS, DEFAULT_LIVENESS_INTERVAL_MS);
  let failuresInARow = 0;
  let restarts = 0;
  try {
    // The watchdog trigger lands here every few minutes while stopped on purpose,
    // so stay silent rather than fill the log with the same line.
    if (stopRequested()) return 0;
    await hooks.beforeStart?.({ log });
    writeState({ name, dataDir, port, supervisorPid: process.pid, startedAt: new Date().toISOString(), restarts, childPid: null, lastExit: null });
    while (!stopRequested()) {
      stopLeftovers({ root, dataDir, port, instanceDirectory, log });
      if (!await portIsFree(port)) {
        // Give a just-stopped server a moment. Something else on the port is
        // reported and retried, never killed.
        await sleep(1_000);
        if (!await portIsFree(port)) {
          failuresInARow += 1;
          const wait = nextBackoffMs(failuresInARow);
          log.line(`Port ${port} is used by another program. Trying again in ${Math.round(wait / 1000)} seconds.`);
          writeState({ childPid: null, lastProblem: 'port-in-use' });
          const until = Date.now() + wait;
          while (!stopRequested() && Date.now() < until) await sleep(POLL_MS);
          continue;
        }
      }
      const startedAt = Date.now();
      const launcher = fs.existsSync(paths.launcher) ? paths.launcher : program;
      child = spawn(process.execPath, [launcher, '--no-open', '--port', String(port)], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('error', error => log.line(`Could not start FLUJO: ${error.code ?? 'unknown error'}.`));
      child.stdout.on('data', chunk => log.write(chunk));
      child.stderr.on('data', chunk => log.write(chunk));
      log.line(`Started FLUJO (process ${child.pid}) on port ${port}.`);
      writeState({ childPid: child.pid, childStartedAt: new Date(startedAt).toISOString(), restarts, lastProblem: null });

      let lastAnswer = Date.now();
      let nextProbe = Date.now() + livenessIntervalMs;
      let probing = false;
      while (child.exitCode === null && child.signalCode === null && !stopRequested()) {
        await sleep(POLL_MS);
        if (hangRestartMs > 0 && !probing && Date.now() >= nextProbe) {
          nextProbe = Date.now() + livenessIntervalMs;
          probing = true;
          void responds(port, 15_000).then(ok => {
            probing = false;
            if (ok) lastAnswer = Date.now();
          });
        }
        if (hangRestartMs > 0 && Date.now() - lastAnswer > hangRestartMs
          && child.exitCode === null && child.signalCode === null) {
          log.line(`FLUJO has not answered for ${Math.round(hangRestartMs / 1000)} seconds. Restarting it.`);
          writeState({ lastProblem: 'not-answering' });
          await stopChild();
          break;
        }
      }
      if (stopRequested()) break;
      const description = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      failuresInARow = Date.now() - startedAt >= STABLE_RUN_MS ? 1 : failuresInARow + 1;
      restarts += 1;
      const wait = nextBackoffMs(failuresInARow);
      log.line(`FLUJO stopped with ${description}. Restart number ${restarts} in ${Math.round(wait / 1000)} seconds.`);
      writeState({ childPid: null, restarts, lastExit: { description, at: new Date().toISOString() } });
      const until = Date.now() + wait;
      while (!stopRequested() && Date.now() < until) await sleep(POLL_MS);
    }
    await stopChild();
    stopLeftovers({ root, dataDir, port, instanceDirectory, log });
    log.line('Stopped.');
    writeState({ childPid: null, supervisorPid: null, stoppedAt: new Date().toISOString() });
    return exitCode;
  } catch (error) {
    exitCode = 1;
    log.line(`The supervisor failed: ${error?.message ?? 'unknown error'}.`);
    await stopChild().catch(() => undefined);
    return exitCode;
  } finally {
    log.close();
    lock.release();
  }
}

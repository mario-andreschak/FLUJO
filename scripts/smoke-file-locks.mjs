/**
 * Real Windows file locks for the installed-app smoke check (issue #1050).
 *
 * Antivirus, the search indexer and backup tools open files the way these
 * helpers do, from another process, so the installed FLUJO meets genuine
 * sharing violations instead of a test hook compiled into the product:
 * - an exclusive lock (no sharing at all) makes every read fail with EBUSY;
 * - a reader lock (an ordinary open handle) lets reads through but makes
 *   Windows refuse a rename over the file with EPERM.
 * Other systems have no mandatory locks, so the lock run is Windows only.
 */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** libuv's UV_FS_O_EXLOCK: Windows opens the file with sharing mode 0. Node passes it through but does not export it. */
const WINDOWS_NO_SHARING = 0x10000000;
const TRACE = /\[transient-file-retry\] ([a-z0-9-]+) ([A-Z0-9]+|other) after try (\d+), waiting (\d+) ms/g;
const REFUSALS = [
  'FLUJO refused a private approval check',
  '[private-approval-set-reader] refused',
  '[private-approval-reader] refused',
  '[workload-guard] refused',
  '[workload-request-binding] refused',
];

/** What a lock of each kind makes Windows answer: a read of an exclusively held file, a rename over a file a reader holds. */
const LOCK_ERRORS = { exclusive: ['EBUSY'], reader: ['EPERM', 'EACCES'] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every retry line the installed app printed, as `{ label, code }`. */
export function retryTraces(text) {
  return [...text.matchAll(TRACE)].map((match) => ({ label: match[1], code: match[2] }));
}

/** Throws with the matching lines when the app logged any refusal on the resource path. */
export function assertNoRefusal(text, context) {
  const lines = text.split(/\r?\n/).filter((line) => REFUSALS.some((marker) => line.includes(marker)));
  if (lines.length) throw new Error(`The installed FLUJO refused during ${context}:\n${lines.slice(0, 20).join('\n')}`);
}

/** Opens a handle the way a scanner does. An exclusive lock is checked to really keep other readers out. */
export async function holdFile(file, kind, { platform = process.platform, waitMs = 5_000 } = {}) {
  if (platform !== 'win32') throw new Error('Mandatory file locks exist only on Windows.');
  const flags = constants.O_RDONLY | (kind === 'exclusive' ? WINDOWS_NO_SHARING : 0);
  const deadline = Date.now() + waitMs;
  let handle;
  // FLUJO may have the file open for a moment itself; an exclusive lock waits for that.
  while (!handle) {
    try { handle = await fs.open(file, flags); }
    catch (error) { if (error.code !== 'EBUSY' || Date.now() > deadline) throw error; await pause(10); }
  }
  if (kind === 'exclusive') {
    try {
      const probe = await fs.open(file, constants.O_RDONLY);
      await probe.close();
      await handle.close();
      throw new Error(`Windows did not apply the exclusive lock on ${path.basename(file)}.`);
    } catch (error) {
      if (error.code !== 'EBUSY') { await handle.close().catch(() => {}); throw error; }
    }
  }
  return { release: () => handle.close() };
}

/**
 * Holds `file` while `operation` runs and lets go as soon as the app traces a
 * retry with the error this lock causes: the app met the lock and is waiting it
 * out. The lock is released before any reader runs out of retries, so only a
 * place that refuses at once (no retry) can fail the operation.
 */
export async function runWhileHeld({ file, kind, labels, operation, logs, hold = holdFile, maxHoldMs = 60_000 }) {
  const mark = logs.mark();
  const held = await hold(file, kind);
  let settled = false;
  const running = Promise.resolve().then(operation).finally(() => { settled = true; });
  running.catch(() => {});
  const traced = () => retryTraces(logs.since(mark));
  const lockMet = () => traced().some((trace) => LOCK_ERRORS[kind].includes(trace.code));
  try {
    const deadline = Date.now() + maxHoldMs;
    while (!settled && !lockMet() && Date.now() < deadline) await pause(5);
  } finally { await held.release(); }
  const result = await running;
  const met = traced().filter((trace) => labels.includes(trace.label));
  return { result, met };
}

/** Runs each target until the app met its lock, up to `tries` times; fails when a target was never met. */
export async function qualifyUnderLocks(targets, { logs, tries = 3, hold, log = console.log }) {
  const report = [];
  for (const target of targets) {
    let met = [];
    for (let attempt = 1; attempt <= tries && met.length === 0; attempt += 1) {
      ({ met } = await runWhileHeld({ ...target, logs, hold }));
    }
    if (met.length === 0) {
      throw new Error(`No ${target.labels.join(' or ')} step met the ${target.kind} lock on ${path.basename(target.file)} during ${target.name}; the lock run would prove nothing.`);
    }
    const summary = `${target.name}: met the ${target.kind} lock on ${path.basename(target.file)} (${met.map((trace) => `${trace.label} ${trace.code}`).join(', ')}) and finished`;
    report.push(summary);
    log(summary);
  }
  return report;
}

/** The stored server config of the one workspace the smoke profile has. */
export async function findServerConfig(dataDir) {
  const workspaces = path.join(dataDir, 'workspaces');
  const found = [];
  for (const name of await fs.readdir(workspaces)) {
    const candidate = path.join(workspaces, name, 'db', 'mcp_servers.json');
    if (await fs.lstat(candidate).then((stat) => stat.isFile(), () => false)) found.push(candidate);
  }
  if (found.length !== 1) throw new Error(`Expected one stored MCP server config under ${workspaces}, found ${found.length}.`);
  return found[0];
}

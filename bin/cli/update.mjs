/**
 * `flujo update --to <version>`: replace the running version with nobody watching.
 *
 * Order of work: check everything that can be checked while FLUJO still runs, fetch
 * and verify the package, install it beside the old one, stop FLUJO, copy the data,
 * switch, start, run the self-test. If the self-test fails, go back to the old
 * version and the copied data, start again, and report it. A power cut at any point
 * is picked up from the journal the next time the instance starts.
 *
 * The full data copy is deliberate. /api/backup leaves out credentials and is not a
 * way back, and only a stopped instance gives a copy that is consistent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';
import { loadBootstrapEnvironment } from '../../scripts/bootstrap-directory.mjs';
import {
  absoluteDirectory, CliError, defaultServiceRoot, isProcessAlive, isSameOrInside, readJsonIfPresent,
  renameWithRetrySync, report, runProgram, sleep, validateServiceName, writeJsonAtomicSync,
} from './common.mjs';
import { readCurrent, readServiceRecord, rootPaths, writeCurrent } from './managed-root.mjs';
import { askInstance } from './selftest.mjs';
import { startInstance, stopInstance } from './service.mjs';

export const EXIT = { ok: 0, failed: 1, rolledBack: 3, outsideWindow: 4, runsActive: 5, rollbackFailed: 6 };

const USAGE = `Usage:
  flujo update --name <instance> --to <version> [--package <file.tgz>] [--integrity <sha512-...> | --sha256 <hex>]
               [--offline] [--window 01:00-05:00] [--now] [--allow-active-runs] [--strict] [--selftest-timeout <seconds>]
               [--root <folder>] [--json]

From npm, the download is checked against the hash npm publishes. A package file
needs --integrity or --sha256. Keeps the last two versions and data copies.
Exit codes: 0 updated, 1 refused or failed with nothing changed, 3 went back to the
old version, 4 outside the time window, 5 runs in progress, 6 going back also failed.`;

const OPTIONS = {
  name: { type: 'string' },
  to: { type: 'string' },
  package: { type: 'string' },
  integrity: { type: 'string' },
  sha256: { type: 'string' },
  offline: { type: 'boolean', default: false },
  window: { type: 'string' },
  now: { type: 'boolean', default: false },
  'allow-active-runs': { type: 'boolean', default: false },
  strict: { type: 'boolean', default: false },
  'selftest-timeout': { type: 'string' },
  root: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_SELFTEST_TIMEOUT_MS = 5 * 60 * 1000;
const KEEP = 2;
const PACKAGE_NAME = 'flujo-ai';
const SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

// --- time window ------------------------------------------------------------

/** Local time, may cross midnight. Throws on nonsense, so a typo cannot mean "never". */
export function isInsideWindow(window, now = new Date()) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/.exec(window ?? '');
  if (!match) throw new CliError('The time window must look like 01:00-05:00.');
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const minute = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// --- integrity --------------------------------------------------------------

function fileHash(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(handle, buffer)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(handle); }
  return hash.digest(encoding);
}

/** Every expected hash must match. Having none at all is refused, never skipped. */
export function verifyPackageFile(file, { integrity, sha256 }) {
  const checks = [];
  for (const entry of (integrity ?? '').split(/\s+/).filter(Boolean)) {
    const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(entry);
    if (!match) throw new CliError('The integrity value must look like sha512-<base64>.');
    checks.push({ algorithm: match[1], encoding: 'base64', expected: match[2] });
  }
  if (sha256) {
    if (!/^[0-9a-fA-F]{64}$/.test(sha256)) throw new CliError('--sha256 must be 64 hexadecimal characters.');
    checks.push({ algorithm: 'sha256', encoding: 'hex', expected: sha256.toLowerCase() });
  }
  if (!checks.length) throw new CliError('A package file needs --integrity or --sha256, so its content can be checked.');
  for (const { algorithm, encoding, expected } of checks) {
    if (fileHash(file, algorithm, encoding) !== expected) throw new CliError('The package does not match its expected hash. Nothing was changed.');
  }
  return `sha512-${fileHash(file, 'sha512', 'base64')}`;
}

// --- npm --------------------------------------------------------------------

/** Run npm through the Node running now, which needs no shell on any system. */
export function npmCommand(env = process.env, execPath = process.execPath) {
  const candidates = [
    env.FLUJO_NPM_CLI,
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new CliError('npm could not be found next to this Node. Set FLUJO_NPM_CLI to the path of npm-cli.js.');
  return found;
}

function runNpm(args, { cwd, env = process.env, run = runProgram, timeout = 20 * 60 * 1000 } = {}) {
  return run(process.execPath, [npmCommand(env), ...args], { cwd, env, timeout });
}

async function downloadVerified({ version, directory, options, npm = runNpm }) {
  const spec = `${PACKAGE_NAME}@${version}`;
  const published = npm(['view', spec, 'dist.integrity', '--json'], { cwd: directory });
  if (!published.ok) throw new CliError(`npm could not provide ${spec}. Nothing was changed.`);
  let integrity;
  try { integrity = JSON.parse(published.stdout); }
  catch { throw new CliError(`npm gave no hash for ${spec}. Nothing was changed.`); }
  if (typeof integrity !== 'string' || !integrity) throw new CliError(`npm gave no hash for ${spec}. Nothing was changed.`);
  const packed = npm(['pack', spec, '--pack-destination', directory, '--silent'], { cwd: directory });
  const name = fs.readdirSync(directory).find(entry => entry.endsWith('.tgz'));
  if (!packed.ok || !name) throw new CliError(`The download of ${spec} failed. Nothing was changed.`);
  const file = path.join(directory, name);
  return { file, integrity: verifyPackageFile(file, { integrity, sha256: options.sha256 }) };
}

/** Install beside the running version, so nothing in use is touched yet. */
function installVersion({ root, version, packageFile, integrity, offline, npm = runNpm }) {
  const paths = rootPaths(root);
  const target = path.join(paths.versions, version);
  const installedPackage = dir => path.join(dir, 'node_modules', PACKAGE_NAME);
  const marker = path.join(target, '.flujo-integrity');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === integrity && fs.existsSync(path.join(installedPackage(target), 'bin', 'flujo.mjs'))) {
    return installedPackage(target);
  }
  const staging = path.join(paths.versions, `.staging-${version}-${randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const args = ['install', packageFile, '--prefix', staging, '--omit=dev', '--no-audit', '--no-fund', '--no-save', '--loglevel=error', ...(offline ? ['--offline'] : [])];
    const installed = npm(args, { cwd: staging });
    if (!installed.ok) throw new CliError(`The install of version ${version} failed${offline ? ' (offline mode needs everything in the npm cache)' : ''}. Nothing was changed.`);
    const manifest = readJsonIfPresent(path.join(installedPackage(staging), 'package.json'));
    if (manifest?.name !== PACKAGE_NAME || manifest.version !== version) {
      throw new CliError(`The package is not ${PACKAGE_NAME} ${version}. Nothing was changed.`);
    }
    fs.writeFileSync(path.join(staging, '.flujo-integrity'), integrity);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    renameWithRetrySync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
  return installedPackage(target);
}

// --- checks while FLUJO is still running ------------------------------------

/**
 * Work that restarts safely (waiting for an approval, stored schedules) is no reason
 * to wait. A run that is executing right now is. If that cannot be read, we say so
 * rather than assume there is none.
 */
export async function findActiveRuns({ port, token, request = fetch }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const get = async suffix => request(`http://127.0.0.1:${port}${suffix}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  let workspaces = [undefined];
  try {
    const listed = await get('/api/workspaces');
    if (listed.ok) {
      const body = await listed.json();
      const names = (Array.isArray(body) ? body : body?.workspaces ?? []).map(item => item?.name ?? item).filter(item => typeof item === 'string');
      if (names.length) workspaces = names;
    }
  } catch { return { known: true, answering: false, running: 0 }; }
  let running = 0;
  for (const workspace of workspaces) {
    let response;
    try { response = await get(`/api/operations/status${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`); }
    catch { return { known: false, answering: true, running: 0 }; }
    if (response.status === 423) return { known: true, answering: true, locked: true, running: 0 };
    if (!response.ok) return { known: false, answering: true, running: 0 };
    try {
      const status = await response.json();
      const executing = (status.activeRuns ?? []).filter(run => run.status === 'running').length;
      running += Math.max(executing, status.scheduler?.runningRuns ?? 0);
    } catch { return { known: false, answering: true, running: 0 }; }
  }
  return { known: true, answering: true, running };
}

function directorySize(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* a file vanished: the copy's own count decides */ }
      }
    }
  }
  return total;
}

function countFiles(directory) {
  let files = 0;
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      } else files += 1;
    }
  }
  return { files, bytes };
}

// --- data copy --------------------------------------------------------------

async function backupData({ dataDir, root, fromVersion }) {
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${fromVersion}`;
  const target = path.join(rootPaths(root).backups, name);
  const staging = `${target}.partial`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.cp(dataDir, path.join(staging, 'data'), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const source = countFiles(dataDir);
  const copy = countFiles(path.join(staging, 'data'));
  if (source.files !== copy.files || source.bytes !== copy.bytes) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new CliError('The data copy does not match the data. Nothing was changed.');
  }
  writeJsonAtomicSync(path.join(staging, 'manifest.json'), { fromVersion, dataDir, ...source, createdAt: new Date().toISOString() });
  renameWithRetrySync(staging, target);
  return target;
}

/** Copy first, then swap, so a failure at any step still leaves one complete data folder. */
async function restoreData({ dataDir, backup }) {
  const manifest = readJsonIfPresent(path.join(backup, 'manifest.json'));
  if (!manifest) throw new Error('The data copy has no manifest.');
  const restoring = `${dataDir}.restoring`;
  const discarded = `${dataDir}.discarded`;
  fs.rmSync(restoring, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.promises.cp(path.join(backup, 'data'), restoring, { recursive: true, verbatimSymlinks: true });
  const restored = countFiles(restoring);
  if (restored.files !== manifest.files || restored.bytes !== manifest.bytes) throw new Error('The restored data does not match its copy.');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(discarded, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    renameWithRetrySync(dataDir, discarded, { attempts: 120 });
  }
  renameWithRetrySync(restoring, dataDir, { attempts: 120 });
  fs.rmSync(discarded, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** Keep the two newest. Never removes what current.json points at. */
export function pruneRoot(root, { keep = KEEP } = {}) {
  const paths = rootPaths(root);
  const current = readCurrent(root);
  const wanted = new Set([current?.packageDir, current?.previous?.packageDir].filter(Boolean)
    .map(dir => path.resolve(dir).toLowerCase()));
  const removed = [];
  let versions = [];
  try { versions = fs.readdirSync(paths.versions); } catch { /* none yet */ }
  for (const name of versions) {
    const full = path.join(paths.versions, name);
    const inUse = [...wanted].some(dir => dir.startsWith(`${full.toLowerCase()}${path.sep}`));
    if (!inUse) {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    }
  }
  let backups = [];
  try {
    backups = fs.readdirSync(paths.backups).sort();
  } catch { /* none yet */ }
  const partial = backups.filter(name => name.endsWith('.partial'));
  const complete = backups.filter(name => !name.endsWith('.partial'));
  for (const name of [...partial, ...complete.slice(0, Math.max(complete.length - keep, 0))]) {
    fs.rmSync(path.join(paths.backups, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    removed.push(name);
  }
  return removed;
}

// --- waiting for the verdict ------------------------------------------------

/**
 * `allowBasic`: going back to an older version that has no self-test must not count
 * as failing. The older version only has to answer that it is ready.
 */
export async function waitUntilUsable({ port, token, strict, deadlineMs, acceptLocked, allowBasic, request = fetch, pauseMs = 2_000 }) {
  const deadline = Date.now() + deadlineMs;
  let last = { usable: false, reason: 'no-answer', checks: [] };
  while (Date.now() < deadline) {
    last = await askInstance({ port, token, strict, network: true, request, timeoutMs: Math.min(90_000, Math.max(deadline - Date.now(), 1_000)) });
    if (last.usable) return last;
    if (last.reason === 'locked' && acceptLocked) return { ...last, usable: true, lockedAccepted: true };
    if (last.reason === 'not-supported-by-this-version' && allowBasic) {
      try {
        const response = await request(`http://127.0.0.1:${port}/api/cwd`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (response.ok) return { format: 'flujo-selftest-result', usable: true, answered: true, basic: true, checks: [] };
      } catch { /* keep waiting */ }
    }
    // These will not get better by waiting, except a server still starting up.
    if (last.answered && last.checks.length > 0) return last;
    await sleep(pauseMs);
  }
  return last;
}

// --- the journal ------------------------------------------------------------

function writeJournal(root, journal) { writeJsonAtomicSync(rootPaths(root).updateJournal, journal); }
function clearJournal(root) { fs.rmSync(rootPaths(root).updateJournal, { force: true }); }

function acquireUpdateLock(root) {
  const { updateLock } = rootPaths(root);
  fs.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = fs.openSync(updateLock, 'wx', 0o600);
      fs.writeFileSync(handle, String(process.pid));
      fs.closeSync(handle);
      return () => fs.rmSync(updateLock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(updateLock, 'utf8').trim());
      if (isProcessAlive(holder)) throw new CliError('Another update of this instance is running.');
      fs.rmSync(updateLock, { force: true });
    }
  }
  throw new CliError('Another update of this instance is running.');
}

/**
 * Put things back from a journal. Used after a failed self-test and after a power
 * cut or crash, so every step must be safe to repeat.
 */
async function goBack({ root, record, journal, log }) {
  writeJournal(root, { ...journal, phase: 'going-back' });
  if (journal.backup && fs.existsSync(path.join(journal.backup, 'manifest.json'))) {
    log?.('Putting the data back from the copy.');
    await restoreData({ dataDir: record.dataDir, backup: journal.backup });
  }
  writeCurrent(root, journal.previousCurrent);
  clearJournal(root);
}

/**
 * Called when an instance starts. An unfinished update whose process is gone is
 * finished off here: before the switch nothing has changed, after it we go back.
 */
export async function recoverInterruptedUpdate({ root, record, log }) {
  const paths = rootPaths(root);
  const journal = readJsonIfPresent(paths.updateJournal);
  if (!journal) return { recovered: false };
  const holder = Number(fs.existsSync(paths.updateLock) ? fs.readFileSync(paths.updateLock, 'utf8').trim() : Number.NaN);
  if (isProcessAlive(holder)) return { recovered: false, updateRunning: true };
  log?.(`An update to ${journal.to} did not finish (reached: ${journal.phase}). Recovering.`);
  if (['switched', 'going-back'].includes(journal.phase)) await goBack({ root, record, journal, log });
  else clearJournal(root);
  fs.rmSync(paths.updateLock, { force: true });
  fs.rmSync(paths.stopRequest, { force: true });
  writeJsonAtomicSync(path.join(root, 'last-update.json'), {
    from: journal.from, to: journal.to, outcome: 'interrupted-and-recovered', phase: journal.phase, at: new Date().toISOString(),
  });
  return { recovered: true };
}

// --- the update -------------------------------------------------------------

export async function performUpdate({ root, record, to, options, token, say = () => undefined, stop = stopInstance, start = startInstance }) {
  const paths = rootPaths(root);
  const { dataDir, port, name } = record;
  const current = readCurrent(root);
  if (!current) throw new CliError('This instance has no current version on record.');
  if (fs.existsSync(paths.stopRequest)) throw new CliError('This instance was stopped on purpose. Start it first, so the update can check it.');
  if (current.version === to) return { outcome: 'already-current', from: to, to, exitCode: EXIT.ok };

  // Nothing below this line stops FLUJO until every check has passed.
  const before = await findActiveRuns({ port, token });
  if (!options.allowActiveRuns) {
    if (!before.known) throw new CliError('Could not see whether runs are in progress. Provide a token with FLUJO_OPERATIONS_TOKEN, or use --allow-active-runs.', EXIT.runsActive);
    if (before.running > 0) throw new CliError(`${before.running} run(s) in progress. Try again later, or use --allow-active-runs.`, EXIT.runsActive);
  }
  const download = path.join(paths.versions, `.download-${randomUUID()}`);
  fs.mkdirSync(download, { recursive: true });
  let packageDir;
  let integrity;
  try {
    let packageFile;
    if (options.package) {
      packageFile = absoluteDirectory(options.package, '--package');
      if (!fs.statSync(packageFile, { throwIfNoEntry: false })?.isFile()) throw new CliError('The package file was not found.');
      integrity = verifyPackageFile(packageFile, options);
    } else {
      say(`Fetching version ${to} from npm.`);
      ({ file: packageFile, integrity } = await downloadVerified({ version: to, directory: download, options }));
    }
    say(`Installing version ${to} beside the running one.`);
    packageDir = installVersion({ root, version: to, packageFile, integrity, offline: options.offline });
  } finally {
    fs.rmSync(download, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const needed = directorySize(dataDir) + SPACE_MARGIN_BYTES;
  const free = fs.statfsSync(root);
  if (Number(free.bavail) * Number(free.bsize) < needed) {
    throw new CliError(`Not enough free disk space for the data copy (about ${Math.ceil(needed / 1024 ** 3)} GB needed). Nothing was changed.`);
  }

  const previousCurrent = current;
  let journal = { from: current.version, to, phase: 'stopping', previousCurrent, startedAt: new Date().toISOString() };
  writeJournal(root, journal);
  say('Stopping FLUJO.');
  await stop({ name, root, record });
  journal = { ...journal, phase: 'copying-data' };
  writeJournal(root, journal);
  say('Copying the data.');
  let backup;
  try {
    backup = await backupData({ dataDir, root, fromVersion: current.version });
  } catch (error) {
    // Data untouched and old version still selected: only bring FLUJO back.
    clearJournal(root);
    start({ name, root, record });
    if (error instanceof CliError) throw error;
    throw new CliError(`The data could not be copied (${error?.code ?? 'unknown error'}). Nothing was changed; FLUJO was started again.`);
  }

  journal = { ...journal, phase: 'switched', backup };
  writeJournal(root, journal);
  writeCurrent(root, { version: to, packageDir, previous: { version: current.version, packageDir: current.packageDir } });
  say(`Starting version ${to}.`);
  start({ name, root, record });
  const verdict = await waitUntilUsable({
    port, token, strict: options.strict, deadlineMs: options.selftestTimeoutMs,
    acceptLocked: before.locked === true, allowBasic: true,
  });
  if (verdict.usable) {
    clearJournal(root);
    const removed = pruneRoot(root);
    const result = { outcome: 'updated', from: current.version, to, integrity, backup, selftest: verdict, removed, exitCode: EXIT.ok };
    writeJsonAtomicSync(path.join(root, 'last-update.json'), { ...result, at: new Date().toISOString() });
    return result;
  }

  say(`Version ${to} failed its self-test (${verdict.reason ?? 'unknown'}). Going back to ${current.version}.`);
  await stop({ name, root, record });
  await goBack({ root, record, journal, log: say });
  fs.rmSync(path.dirname(path.dirname(packageDir)), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  start({ name, root, record });
  const after = await waitUntilUsable({
    port, token, strict: false, deadlineMs: options.selftestTimeoutMs, acceptLocked: before.locked === true, allowBasic: true,
  });
  const result = {
    outcome: after.usable ? 'went-back' : 'went-back-but-not-usable',
    from: current.version, to, failedReason: verdict.reason ?? 'unknown', selftest: verdict, selftestAfter: after, backup,
    exitCode: after.usable ? EXIT.rolledBack : EXIT.rollbackFailed,
  };
  writeJsonAtomicSync(path.join(root, 'last-update.json'), { ...result, at: new Date().toISOString() });
  return result;
}

export async function main(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false })); }
  catch { throw new CliError(USAGE); }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const name = validateServiceName(values.name);
  if (!VERSION_PATTERN.test(values.to ?? '')) throw new CliError('--to must be an exact version, for example 3.48.6.');
  const root = values.root ? absoluteDirectory(values.root, '--root') : defaultServiceRoot(name);
  const record = readServiceRecord(root);
  if (!record) throw new CliError(`FLUJO instance "${name}" is not set up. Use: flujo service install`);
  if (isSameOrInside(record.dataDir, root)) throw new CliError('The instance folder must be outside the data directory.');
  // Window and token live in the instance's own settings, like everything else.
  process.env.FLUJO_BOOTSTRAP_DIR ??= record.dataDir;
  loadBootstrapEnvironment(record.dataDir, false, nextEnv.loadEnvConfig);
  const window = values.window ?? process.env.FLUJO_UPDATE_WINDOW;
  if (window && !values.now && !isInsideWindow(window)) {
    report({ outcome: 'outside-window', window, exitCode: EXIT.outsideWindow }, values.json, [`Not updating: outside the time window ${window}.`]);
    return EXIT.outsideWindow;
  }
  const timeoutSeconds = values['selftest-timeout'] === undefined ? undefined : Number(values['selftest-timeout']);
  if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)) throw new CliError('--selftest-timeout must be a whole number of seconds.');
  const release = acquireUpdateLock(root);
  try {
    await recoverInterruptedUpdate({ root, record, log: message => { if (!values.json) console.log(message); } }).catch(() => undefined);
    const result = await performUpdate({
      root, record, to: values.to,
      token: process.env.FLUJO_OPERATIONS_TOKEN?.trim() || undefined,
      say: message => { if (!values.json) console.log(message); },
      options: {
        package: values.package, integrity: values.integrity, sha256: values.sha256, offline: values.offline,
        strict: values.strict, allowActiveRuns: values['allow-active-runs'],
        selftestTimeoutMs: timeoutSeconds === undefined ? DEFAULT_SELFTEST_TIMEOUT_MS : timeoutSeconds * 1000,
      },
    });
    report(result, values.json, [({
      'already-current': `Version ${values.to} is already running.`,
      updated: `Updated from ${result.from} to ${result.to}. The self-test passed.`,
      'went-back': `Version ${result.to} failed its self-test (${result.failedReason}). Back on ${result.from}, with its data, and working.`,
      'went-back-but-not-usable': `Version ${result.to} failed its self-test, and after going back to ${result.from} the instance is not usable. This needs a person.`,
    })[result.outcome]]);
    return result.exitCode;
  } finally { release(); }
}

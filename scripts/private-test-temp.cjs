// One private temporary folder per Jest run.
//
// FLUJO refuses approval and consent files in a folder that another account
// can change, and it checks every folder above the file. On some Windows PCs
// %TEMP% and %LOCALAPPDATA% grant other accounts (sandbox users, app
// containers) that access, so a test that writes such a file to the shared
// temp folder fails for a reason that has nothing to do with the code.
//
// Each run therefore gets its own root, made private with the code FLUJO uses
// for its own private folders (ACLs on Windows, 0700 on Linux and macOS),
// below the first base folder that FLUJO's own check accepts. TEMP, TMP,
// TMPDIR and (on Windows) LOCALAPPDATA point into it until the run ends.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const RUNS_FOLDER = '.flujo-test-runs';
const RUN_NAME = /^run-(\d+)-[0-9a-f]{12}$/;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSIENT_ATTEMPTS = 3;
const SAVED_NAMES = ['TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH'];

const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Removes roots left by runs that crashed or were interrupted before teardown. */
async function sweepStaleRuns(container, { now = Date.now(), alive = processAlive } = {}) {
  let entries;
  try { entries = await fsp.readdir(container, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  await Promise.all(entries.map(async (entry) => {
    const match = RUN_NAME.exec(entry.name);
    if (!match || !entry.isDirectory()) return;
    const root = path.join(container, entry.name);
    const pid = Number(match[1]);
    let stale = pid !== process.pid && !alive(pid);
    if (!stale) {
      try { stale = now - (await fsp.stat(root)).mtimeMs > STALE_AFTER_MS; } catch { return; }
    }
    if (!stale) return;
    try { await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }); removed.push(root); } catch { /* A later run sweeps it again. */ }
  }));
  return removed;
}

/** The real, link-free spelling of the temp and home folders, in order of preference. */
function candidateBases({ tmpdir = os.tmpdir(), homedir = os.homedir() } = {}) {
  const bases = [];
  for (const base of [tmpdir, homedir]) {
    if (!base) continue;
    let resolved;
    try { resolved = fs.realpathSync.native(base); } catch { continue; }
    if (!bases.some((item) => sameName(item, resolved))) bases.push(resolved);
  }
  return bases;
}

/** FLUJO's rule for every folder above a private file on Linux and macOS. */
async function posixFoldersPrivate(directory) {
  const uid = process.getuid();
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fsp.lstat(current);
    const writableByOthers = (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) || writableByOthers) return false;
    if (path.dirname(current) === current) return true;
  }
}

/** Asks FLUJO's own Windows check whether a file in this root counts as private. */
async function windowsFolderPrivate(root, inspect) {
  const probe = path.join(root, 'privacy-probe.json');
  await fsp.writeFile(probe, '{}', { mode: 0o600 });
  try {
    for (let attempt = 1; ; attempt += 1) {
      try { await inspect(probe); return true; } catch (error) {
        if (error?.nativeFailure === 'refused') return false;
        if (error?.transient !== true || attempt >= TRANSIENT_ATTEMPTS) throw error;
        await pause(250 * attempt);
      }
    }
  } finally { await fsp.rm(probe, { force: true }); }
}

function folderPrivate(root, inspectWindows) {
  return process.platform === 'win32' ? windowsFolderPrivate(root, inspectWindows) : posixFoldersPrivate(root);
}

async function removeEmptyFolder(folder) {
  try { await fsp.rmdir(folder); } catch { /* Another run still uses it, or it is already gone. */ }
}

async function loadEnsurePrivateDirectory(rootDir) {
  const { ensurePrivateDirectory } = await import(pathToFileURL(path.join(rootDir, 'scripts', 'local-instance.mjs')).href);
  return ensurePrivateDirectory;
}

async function newRoot(base, ensure) {
  const container = path.join(base, RUNS_FOLDER);
  await sweepStaleRuns(container);
  await fsp.mkdir(container, { recursive: true });
  const root = path.join(container, `run-${process.pid}-${randomBytes(6).toString('hex')}`);
  try { await ensure(root); } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    await removeEmptyFolder(container);
    throw error;
  }
  return root;
}

/**
 * Creates this run's private root and points the temp variables of `env` at it.
 * When no base passes FLUJO's check, the run still gets its own root below the
 * first base that could hold one, and `problems` says why each base was refused.
 * @param {{ rootDir?: string, env?: Record<string, string | undefined>, bases?: string[],
 *   inspectWindows?: (file: string) => Promise<unknown>, ensurePrivateDirectory?: (directory: string) => Promise<unknown>,
 *   isPrivate?: (root: string) => Promise<boolean> }} [options]
 */
async function createPrivateTestTemp({ rootDir, env = process.env, inspectWindows, ensurePrivateDirectory, bases,
  isPrivate = (root) => folderPrivate(root, inspectWindows) } = {}) {
  const ensure = ensurePrivateDirectory ?? await loadEnsurePrivateDirectory(rootDir);
  const original = Object.fromEntries(SAVED_NAMES.map((name) => [name, env[name]]));
  const candidates = bases ?? candidateBases();
  const problems = [];
  let privateRoot;
  let fallback;
  for (const base of candidates) {
    let root;
    try {
      root = await newRoot(base, ensure);
      if (await isPrivate(root)) { privateRoot = root; break; }
      problems.push(`${base}: FLUJO's privacy check refuses files below it`);
    } catch (error) {
      problems.push(`${base}: ${error?.message ?? error}`);
    }
    if (root && !fallback) fallback = root;
    else if (root) await removePrivateRoot(root);
  }
  if (privateRoot && fallback) await removePrivateRoot(fallback);
  const chosen = privateRoot ?? fallback;
  if (!chosen) throw new Error(`No folder for this test run's temp files could be created. ${problems.join('; ')}`);
  const temp = path.join(chosen, 'temp');
  await fsp.mkdir(temp, { mode: 0o700 });
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  if (process.platform === 'win32') {
    const localAppData = path.join(chosen, 'local-app-data');
    await fsp.mkdir(localAppData, { mode: 0o700 });
    env.LOCALAPPDATA = localAppData;
    // Browsers installed for this account stay findable (Playwright looks in LOCALAPPDATA).
    if (!env.PLAYWRIGHT_BROWSERS_PATH && original.LOCALAPPDATA) {
      env.PLAYWRIGHT_BROWSERS_PATH = path.join(original.LOCALAPPDATA, 'ms-playwright');
    }
  }
  return { root: chosen, temp, original, private: Boolean(privateRoot), problems };
}

async function removePrivateRoot(root) {
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await removeEmptyFolder(path.dirname(root));
}

/**
 * Restores the variables, then removes the run's root and, if empty, its container.
 * @param {{ root: string, original: Record<string, string | undefined> } | undefined} state
 * @param {Record<string, string | undefined>} [env]
 */
async function removePrivateTestTemp(state, env = process.env) {
  if (!state) return;
  for (const [name, value] of Object.entries(state.original)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  await removePrivateRoot(state.root);
}

/** Last chance when Jest exits without teardown; the next run sweeps whatever stays. */
function removePrivateTestTempNow(state) {
  if (!state) return;
  try { fs.rmSync(state.root, { recursive: true, force: true }); } catch { /* The next run sweeps it. */ }
}

module.exports = {
  RUNS_FOLDER,
  candidateBases,
  createPrivateTestTemp,
  posixFoldersPrivate,
  removePrivateTestTemp,
  removePrivateTestTempNow,
  sweepStaleRuns,
};

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { bundledCodexExecutable } from './codexRestrictedProfile';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration } from './codexAppServerProcess';
import { admitCodexDirectory, readCodexRuntimeFile, writeCodexRuntimeFile } from './codexRuntimeFiles';

const log = createLogger('backend/services/model/adapters/codexRuntimeUpdate');
const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
type Receipt = { version: string; directory: string; sha256: string; previousDirectory?: string };
type State = { checked: number; executable: string; updating?: Promise<void> };
const states = new Map<string, State>();

export function newerCodexVersion(candidate: string, current: string): boolean {
  if (!VERSION.test(candidate) || !VERSION.test(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

/** Package installation/probes inherit system paths only, never provider or npm credentials. */
export function codexUpdateEnvironment(home: string): NodeJS.ProcessEnv {
  const names = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: home, TMP: home, TEMP: home, NODE_ENV: 'production' };
}

async function versionOf(executable: string, home: string): Promise<string> {
  const { stdout } = await run(executable, ['--version'], {
    env: codexUpdateEnvironment(home), timeout: 10000, maxBuffer: 4096, windowsHide: true,
  });
  const match = /^codex-cli (\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/.exec(String(stdout));
  if (!match) throw new Error('Invalid Codex version response');
  return match[1];
}

export async function readOrdinaryCodexVersion(executable = bundledCodexExecutable()): Promise<string> {
  return versionOf(executable, getWorkspaceDataDir());
}

async function digest(executable: string): Promise<string> {
  const stat = await fs.lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('Invalid Codex executable');
  return createHash('sha256').update(await fs.readFile(executable)).digest('hex');
}

/** No threads or inference: qualify stdio framing, initialization and paged model listing. */
export async function qualifyCodexUpdate(executable: string, home: string): Promise<void> {
  const owner = Object.freeze({});
  const child = await startOwnedCodexAppServer({
    executable, args: ['app-server'], cwd: home, env: codexUpdateEnvironment(home), owner,
    signal: AbortSignal.timeout(20000), onNotification: () => {},
    register: async registration => { assertCodexOwnedProcessRegistration(registration, owner); },
  });
  try {
    await child.request('initialize', { clientInfo: { name: 'flujo_codex_update', version: '1' } }, 10000);
    child.notify('initialized');
    const value = await child.request('model/list', { limit: 100, includeHidden: false }, 10000) as { data?: unknown };
    if (!value || !Array.isArray(value.data) || !value.data.length
      || !value.data.every(row => row && typeof row.model === 'string')) throw new Error('Codex model protocol changed');
    const { stdout } = await run(executable, ['exec', '--help'], {
      env: codexUpdateEnvironment(home), timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    if (!['--json', '--model', '--skip-git-repo-check', '--config'].every(flag => stdout.includes(flag))) {
      throw new Error('Codex SDK execution flags changed');
    }
  } finally { await child.stop(); }
}

async function npmCli(): Promise<string> {
  const bin = path.dirname(process.execPath);
  const candidates = [path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js',
    ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
      .map(directory => path.join(directory, 'node_modules/npm/bin/npm-cli.js'))];
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(stat => stat.isFile(), () => false)) return candidate;
  }
  throw new Error('npm CLI is unavailable for Codex updates');
}

async function update(root: string, state: State): Promise<void> {
  const guard = await admitCodexDirectory(root, true);
  await guard();
  const response = await fetch('https://registry.npmjs.org/@openai%2fcodex/latest', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Codex release lookup failed');
  const release = await response.json() as { version?: unknown };
  if (typeof release.version !== 'string' || !VERSION.test(release.version)) throw new Error('Invalid Codex release');
  const current = await versionOf(state.executable, root);
  if (!newerCodexVersion(release.version, current)) return;
  // Unique immutable candidate directories: another server cannot overwrite an active binary.
  const directory = await fs.mkdtemp(path.join(root, `release-${release.version}-`));
  let activated = false;
  try {
    const candidateGuard = await admitCodexDirectory(directory, true);
    await writeCodexRuntimeFile(directory, path.join(directory, 'package.json'), '{"private":true}', candidateGuard);
    await writeCodexRuntimeFile(directory, path.join(directory, 'npmrc'), '', candidateGuard);
    await writeCodexRuntimeFile(directory, path.join(directory, 'global-npmrc'), '', candidateGuard);
    await run(process.execPath, [await npmCli(), 'install', `@openai/codex@${release.version}`,
      '--save-exact', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org', `--userconfig=${path.join(directory, 'npmrc')}`,
      `--globalconfig=${path.join(directory, 'global-npmrc')}`, `--cache=${path.join(directory, 'npm-cache')}`], {
      cwd: directory, env: codexUpdateEnvironment(directory), timeout: 600000,
      maxBuffer: 128 * 1024, windowsHide: true,
    });
    await candidateGuard();
    const executable = bundledCodexExecutable(directory);
    if (await versionOf(executable, directory) !== release.version) throw new Error('Codex installed version mismatch');
    await qualifyCodexUpdate(executable, directory);
    const relativePrevious = path.relative(root, state.executable).split(path.sep)[0];
    const receipt: Receipt = { version: release.version, directory: path.basename(directory), sha256: await digest(executable),
      ...(/^release-\d+\.\d+\.\d+-[A-Za-z0-9]+$/.test(relativePrevious) ? { previousDirectory: relativePrevious } : {}) };
    await writeCodexRuntimeFile(root, path.join(root, 'current.json'), JSON.stringify(receipt), guard);
    state.executable = executable;
    activated = true;
    log.info('Codex runtime update qualified; future ordinary calls use the new CLI', { version: release.version });
  } finally {
    await candidateCleanup(root, activated ? path.join(directory, 'npm-cache') : directory).catch(() => {});
  }
  await retireUnusedReleases(root, directory).catch(() => {});
}

async function candidateCleanup(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^release-\d+\.\d+\.\d+-[A-Za-z0-9]+(?:[/\\]npm-cache)?$/.test(relative)) throw new Error('Invalid Codex cleanup path');
  await admitCodexDirectory(root);
  await admitCodexDirectory(target);
  await fs.rm(target, { recursive: true, force: true });
}

/** A live call owns a persistent lease before selecting a release, including
 * between SDK turns. Other server processes and old calls protect their binary.
 */
export async function acquireOrdinaryCodexExecutable(): Promise<{ executable: string; release: () => Promise<void> }> {
  const root = path.resolve(getWorkspaceDataDir(), 'db', 'codex-cli');
  const guard = await admitCodexDirectory(root, true);
  const file = path.join(root, `lease-${process.pid}-${randomUUID()}.json`);
  await writeCodexRuntimeFile(root, file, JSON.stringify({ pid: process.pid, directory: '*' }), guard);
  const release = async () => { await guard(); await fs.rm(file, { force: true }); };
  try {
    const executable = await resolveOrdinaryCodexExecutable();
    const relative = path.relative(root, executable);
    const directory = relative.startsWith('release-') && !path.isAbsolute(relative) ? relative.split(path.sep)[0] : 'bundled';
    await writeCodexRuntimeFile(root, file, JSON.stringify({ pid: process.pid, directory }), guard);
    return { executable, release };
  } catch (error) { await release(); throw error; }
}

async function retireUnusedReleases(root: string, current: string): Promise<void> {
  const guard = await admitCodexDirectory(root);
  const entries = await fs.readdir(root);
  const used = new Set<string>([path.basename(current)]);
  // Re-read the published pointer: another process may have activated a release.
  const published = JSON.parse((await readCodexRuntimeFile(root, path.join(root, 'current.json'), 4096, guard)).toString()) as Receipt;
  if (!/^release-\d+\.\d+\.\d+-[A-Za-z0-9]+$/.test(published.directory)) return;
  used.add(published.directory);
  if (published.previousDirectory && /^release-\d+\.\d+\.\d+-[A-Za-z0-9]+$/.test(published.previousDirectory)) used.add(published.previousDirectory);
  for (const name of entries.filter(name => /^lease-\d+-[a-f0-9-]+\.json$/.test(name))) {
    const lease = JSON.parse((await readCodexRuntimeFile(root, path.join(root, name), 4096, guard)).toString()) as { pid: number; directory: string };
    if (!Number.isInteger(lease.pid) || lease.pid < 1 || typeof lease.directory !== 'string') return;
    let dead = false;
    try { process.kill(lease.pid, 0); }
    catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (dead) { await guard(); await fs.rm(path.join(root, name), { force: true }); continue; }
    if (lease.directory === '*') return;
    used.add(lease.directory);
  }
  // Keep one previous working release for recovery, plus every actively leased release.
  const releases = await Promise.all(entries.filter(name => /^release-\d+\.\d+\.\d+-[A-Za-z0-9]+$/.test(name)).map(async name => ({ name, stat: await fs.lstat(path.join(root, name)) })));
  for (const row of releases) {
    if (!used.has(row.name) && row.stat.isDirectory() && !row.stat.isSymbolicLink()) await candidateCleanup(root, path.join(root, row.name));
  }
}

/** Daily, independent of app releases. Existing calls hold their original executable.
 * Explicitly verified private/Original integrations never call this resolver.
 * No retry/replay of inference on an update failure; retain last good or bundled CLI.
 */
export async function resolveOrdinaryCodexExecutable(options: { waitForUpdate?: boolean } = {}): Promise<string> {
  if (process.env.FLUJO_CODEX_AUTO_UPDATE === '0') return bundledCodexExecutable();
  const root = path.resolve(getWorkspaceDataDir(), 'db', 'codex-cli');
  let state = states.get(root);
  if (!state) {
    state = { checked: 0, executable: bundledCodexExecutable() };
    states.set(root, state);
  }
  try {
    const guard = await admitCodexDirectory(root, true);
    const receipt = JSON.parse((await readCodexRuntimeFile(root, path.join(root, 'current.json'), 4096, guard)).toString()) as Receipt;
    if (!VERSION.test(receipt.version) || !new RegExp(`^release-${receipt.version.replaceAll('.', '\\.')}-[A-Za-z0-9]+$`).test(receipt.directory)
      || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error('Invalid Codex receipt');
    const directory = path.join(root, receipt.directory);
    await admitCodexDirectory(directory);
    const executable = bundledCodexExecutable(directory);
    if (executable !== state.executable && (await digest(executable) !== receipt.sha256 || await versionOf(executable, root) !== receipt.version)) throw new Error('Codex receipt mismatch');
    state.executable = executable;
  } catch { /* A missing/unusable managed release falls back to the installed bundle. */ }
  if (!await fs.stat(state.executable).then(stat => stat.isFile(), () => false)) state.executable = bundledCodexExecutable();
  if (!state.updating && Date.now() - state.checked >= DAY) {
    state.checked = Date.now();
    state.updating = update(root, state).catch(() => {
      // Do not log npm output, paths, child diagnostics or credentials.
      log.warn('Automatic Codex update unavailable; retaining the last working CLI');
      state!.checked = Date.now() - DAY + 60 * 60 * 1000;
    }).finally(() => { state!.updating = undefined; });
  }
  // Updates run separately so a model turn never waits for a package download.
  if (options.waitForUpdate) await state.updating;
  return state.executable;
}

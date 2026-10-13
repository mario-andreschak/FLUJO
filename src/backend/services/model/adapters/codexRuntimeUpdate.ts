import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { readPlainFile } from '@/utils/readPlainFile';
import { bundledCodexExecutable } from './codexRestrictedProfile';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration, CodexAppServerRpcError } from './codexAppServerProcess';
import { admitCodexDirectory, readCodexRuntimeFile, writeCodexRuntimeFile } from './codexRuntimeFiles';
import { CODEX_APP_SERVER_CONTRACT } from './codexProtocol';

const log = createLogger('backend/services/model/adapters/codexRuntimeUpdate');
const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Bump when the admitted catalogue/error schema or SDK argument contract changes.
const QUALIFICATION_CONTRACT = 'flujo-codex-runtime-qualification-v2';
export interface CodexRuntimeCompatibility {
  cliVersion: string;
  sdkVersion: string;
  protocolContract: string;
}
type Receipt = {
  version: string; directory: string; sha256: string; previousDirectory?: string;
  compatibility?: CodexRuntimeCompatibility & { qualificationContract: string };
};
type State = {
  checked: number; executable: string; admitted?: string; updating?: Promise<void>;
  admissionFailure?: { key: string; retryAt: number; cliVersion: string };
};
const states = new Map<string, State>();

function admissionKey(receipt: Receipt, sdkVersion: string): string {
  return JSON.stringify([receipt.directory, receipt.version, receipt.sha256, sdkVersion,
    CODEX_APP_SERVER_CONTRACT, QUALIFICATION_CONTRACT]);
}

function qualifiedReceipt(receipt: Receipt, sdkVersion: string): boolean {
  const compatibility = receipt.compatibility;
  return compatibility?.cliVersion === receipt.version && compatibility.sdkVersion === sdkVersion
    && compatibility.protocolContract === CODEX_APP_SERVER_CONTRACT
    && compatibility.qualificationContract === QUALIFICATION_CONTRACT;
}

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

async function installedSdkVersion(): Promise<string> {
  // The SDK exposes only its public ESM entry, not package.json. Resolve the
  // installed package with Node's ESM-aware resolver, also in bundled servers.
  const findPackageJSON: typeof nodeModule.findPackageJSON = Reflect.get(nodeModule, 'findPackageJSON');
  const manifest = findPackageJSON('@openai/codex-sdk', path.join(process.cwd(), 'package.json'));
  if (!manifest) throw new Error('Codex SDK version is unavailable');
  const value = JSON.parse((await readPlainFile(manifest, { maxBytes: 64 * 1024 })).toString()) as { name?: unknown; version?: unknown };
  if (value.name !== '@openai/codex-sdk' || typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw new Error('Invalid Codex SDK version');
  }
  return value.version;
}

export async function readCodexRuntimeCompatibility(executable = bundledCodexExecutable()): Promise<CodexRuntimeCompatibility> {
  return { cliVersion: await readOrdinaryCodexVersion(executable), sdkVersion: await installedSdkVersion(),
    protocolContract: CODEX_APP_SERVER_CONTRACT };
}

async function digest(executable: string): Promise<string> {
  const hash = createHash('sha256');
  await readPlainFile(executable, { maxBytes: 512 * 1024 * 1024,
    consume: async chunk => { hash.update(chunk); } });
  return hash.digest('hex');
}

/** Parse the options used by the installed public SDK without starting a turn.
 * --experimental-json is the SDK 0.162.1 spelling; it can be a hidden CLI alias.
 * Help must accept the actual argument vector, not just mention four flags.
 */
async function qualifySdkExecution(executable: string, home: string, signal: AbortSignal): Promise<void> {
  const thread = {
    model: 'flujo_codex_qualification', threadSource: 'sdk', sandboxMode: 'read-only',
    workingDirectory: home, additionalDirectories: [home], skipGitRepoCheck: true,
    modelReasoningEffort: 'high', networkAccessEnabled: false, webSearchMode: 'disabled', approvalPolicy: 'never',
  } satisfies ThreadOptions;
  const turn = { cyberAccessProgram: 'standard', outputSchema: { type: 'object' }, signal } satisfies TurnOptions;
  const args = ['exec', '--experimental-json', '--model', thread.model, '--sandbox', thread.sandboxMode,
    '--cd', thread.workingDirectory, '--add-dir', thread.additionalDirectories[0], '--skip-git-repo-check',
    '--output-schema', path.join(home, 'qualification-schema.json'), '--cyber-access-program', turn.cyberAccessProgram,
    '--config', `model_reasoning_effort="${thread.modelReasoningEffort}"`,
    '--config', `sandbox_workspace_write.network_access=${thread.networkAccessEnabled}`,
    '--config', `web_search="${thread.webSearchMode}"`, '--config', `approval_policy="${thread.approvalPolicy}"`,
    '--config', 'service_tier="default"'];
  for (const resumed of [false, true]) {
    const { stdout } = await run(executable, [...args,
      ...(resumed ? ['resume', '00000000-0000-0000-0000-000000000000'] : ['--thread-source', thread.threadSource]),
      '--image', path.join(home, 'qualification-image.png'), '--help'], {
      cwd: home, env: codexUpdateEnvironment(home), timeout: 10000, signal: turn.signal,
      maxBuffer: 128 * 1024, windowsHide: true,
    });
    if (!/\bUsage:\s+codex exec\b/.test(String(stdout))) throw new Error('Codex SDK execution flags changed');
  }
}

/** No threads or inference: qualify stdio framing, errors, all catalogue pages and SDK parsing. */
export async function qualifyCodexUpdate(executable: string, home: string): Promise<CodexRuntimeCompatibility> {
  const compatibility = { cliVersion: await versionOf(executable, home), sdkVersion: await installedSdkVersion(),
    protocolContract: CODEX_APP_SERVER_CONTRACT };
  const signal = AbortSignal.timeout(20000);
  const owner = Object.freeze({});
  const child = await startOwnedCodexAppServer({
    executable, args: ['app-server', '--listen', 'stdio://'], cwd: home, env: codexUpdateEnvironment(home), owner,
    signal, onNotification: () => {},
    register: async registration => { assertCodexOwnedProcessRegistration(registration, owner); },
  });
  try {
    await child.request('initialize', { clientInfo: { name: 'flujo_codex_update', version: '1' } }, 10000);
    child.notify('initialized');
    let cursor: string | undefined, count = 0, pages = 0;
    const cursors = new Set<string>();
    do {
      if (++pages > 32) throw new Error('Codex model catalogue exceeds qualification bounds');
      const value = await child.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 10000) as { data?: unknown; nextCursor?: unknown };
      if (!value || !Array.isArray(value.data) || value.data.length > 100 || count + value.data.length > 1024
        || !value.data.every(row => row && typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 256)) {
        throw new Error('Codex model protocol changed');
      }
      count += value.data.length;
      const next = value.nextCursor;
      if (next != null && (typeof next !== 'string' || !next || next.length > 4096 || cursors.has(next))) {
        throw new Error('Codex model cursor changed');
      }
      cursor = typeof next === 'string' ? next : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!count) throw new Error('Codex model catalogue is unavailable');
    let rejected = false;
    try { await child.request('model/list', { limit: 'invalid-qualification-limit' }, 10000); }
    catch (error) { rejected = error instanceof CodexAppServerRpcError && [-32600, -32602].includes(error.code); }
    if (!rejected) throw new Error('Codex JSON-RPC error protocol changed');
    await qualifySdkExecution(executable, home, signal);
    signal.throwIfAborted();
    return compatibility;
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
  // A stale receipt can fail against a new SDK. Skip reinstallation of that
  // exact rejected release, while still discovering a newer compatible CLI.
  const rejected = state.admissionFailure?.cliVersion;
  const baseline = rejected && newerCodexVersion(rejected, current) ? rejected : current;
  if (!newerCodexVersion(release.version, baseline)) return;
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
    const compatibility = await qualifyCodexUpdate(executable, directory);
    if (compatibility.cliVersion !== release.version) throw new Error('Codex qualified version mismatch');
    const relativePrevious = path.relative(root, state.executable).split(path.sep)[0];
    const receipt: Receipt = { version: release.version, directory: path.basename(directory), sha256: await digest(executable),
      compatibility: { ...compatibility, qualificationContract: QUALIFICATION_CONTRACT },
      ...(/^release-\d+\.\d+\.\d+-[A-Za-z0-9]+$/.test(relativePrevious) ? { previousDirectory: relativePrevious } : {}) };
    await writeCodexRuntimeFile(root, path.join(root, 'current.json'), JSON.stringify(receipt), guard);
    state.executable = executable;
    state.admitted = admissionKey(receipt, compatibility.sdkVersion);
    state.admissionFailure = undefined;
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
    const sdkVersion = await installedSdkVersion();
    const key = admissionKey(receipt, sdkVersion);
    if (state.admitted !== key || !qualifiedReceipt(receipt, sdkVersion)) {
      if (state.admissionFailure?.key === key && Date.now() < state.admissionFailure.retryAt) {
        throw new Error('Codex qualification retry is pending');
      }
      if (await digest(executable) !== receipt.sha256 || await versionOf(executable, directory) !== receipt.version) {
        throw new Error('Codex receipt mismatch');
      }
      if (!qualifiedReceipt(receipt, sdkVersion)) {
        try {
          const compatibility = await qualifyCodexUpdate(executable, directory);
          if (compatibility.cliVersion !== receipt.version || compatibility.sdkVersion !== sdkVersion
            || await digest(executable) !== receipt.sha256) throw new Error('Codex qualification identity changed');
          // Do not overwrite a newer release published while qualification ran.
          const published = JSON.parse((await readCodexRuntimeFile(root, path.join(root, 'current.json'), 4096, guard)).toString()) as Receipt;
          if (published.directory !== receipt.directory || published.version !== receipt.version || published.sha256 !== receipt.sha256) {
            throw new Error('Codex release changed during qualification');
          }
          receipt.compatibility = { ...compatibility, qualificationContract: QUALIFICATION_CONTRACT };
          await writeCodexRuntimeFile(root, path.join(root, 'current.json'), JSON.stringify(receipt), guard);
        } catch (error) {
          state.admissionFailure = { key, retryAt: Date.now() + 60 * 60 * 1000, cliVersion: receipt.version };
          log.warn('Managed Codex runtime requalification unavailable; using the bundled CLI');
          throw error;
        }
      }
      state.admitted = key;
      state.admissionFailure = undefined;
    }
    state.executable = executable;
  } catch {
    // A previously admitted binary must not survive a changed or unusable receipt.
    state.executable = bundledCodexExecutable();
    state.admitted = undefined;
  }
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

#!/usr/bin/env node
// An automated operator: follows docs/operations/operator-runbook.md step by
// step on a fresh machine account (empty home, npm cache and data folder) and
// fails when a documented step is missing, out of order or wrong. It runs the
// page's commands exactly as written; it only adds what the world around an
// operator provides (test data, a job that failed, a stand-in model, a local
// registry that offers the release under test) and checks what each step
// promises. See "How CI follows this page" in the runbook.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_STEPS, OPERATOR_VARIABLES, parseRunbook } from './operator-runbook/parse.mjs';
import { previousVersion, startRegistry } from './operator-runbook/registry.mjs';
import { changeValues, createFlujoProbe, sendChanges } from './packaged-acceptance/flujo-probe.mjs';
import { startStandIns } from './packaged-acceptance/stand-ins.mjs';
import { createHostTarget, createRequester, packCandidate, readCandidateTarballs, resolveNpmCli, runCommand, unusedPort, waitForPortClosed } from './packaged-acceptance/targets.mjs';
import { syntheticIdentifiers } from './maintainer-synthetic-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RUNBOOK = path.join(root, 'docs', 'operations', 'operator-runbook.md');
export const FAILED_JOB = 'Nightly report';
const STEP_TIMEOUT_MS = Object.freeze({ check: 20 * 60_000, default: 3 * 60_000 });

export const USAGE = `Usage:
  node scripts/operator-runbook.mjs (--pack | --tarballs DIR) [--from VERSION] [--runbook FILE] [--report FILE] [--keep]

--pack packs this checkout's finished build (run "npm run build" first).
--tarballs takes a release candidate folder with manifest.json.
--from is the published version to install first (default: the newest one older than the release under test).
Paths must be absolute.`;

export function parseOptions(argv) {
  const fail = message => { throw new Error(`${message}\n\n${USAGE}`); };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      pack: { type: 'boolean' }, tarballs: { type: 'string' }, from: { type: 'string' }, runbook: { type: 'string' },
      report: { type: 'string' }, keep: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
  } catch (error) { fail(error.message); }
  if (values.help) return { help: true };
  if (Boolean(values.pack) === (values.tarballs !== undefined)) fail('Give either --pack or --tarballs DIR.');
  for (const name of ['tarballs', 'runbook', 'report']) {
    if (values[name] !== undefined && !path.isAbsolute(values[name])) fail(`--${name} needs an absolute path.`);
  }
  if (values.from !== undefined && !/^\d+\.\d+\.\d+$/.test(values.from)) fail('--from needs an exact version such as 3.48.10.');
  return { pack: Boolean(values.pack), tarballs: values.tarballs, from: values.from, runbook: values.runbook ?? DEFAULT_RUNBOOK,
    report: values.report, keep: Boolean(values.keep) };
}

/** How the page's commands run: bash with errors stopping the step, or PowerShell 7 likewise. */
export function shellCommand(shell, script) {
  if (shell === 'bash') return { file: 'bash', args: ['-e', '-o', 'pipefail', '-c', script] };
  return { file: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`] };
}

/**
 * A fresh operator account: system variables needed to start programs, Node on
 * PATH, a private home and npm cache, the local registry and the chosen
 * settings. Nothing else from the runner's own profile comes along.
 */
export function operatorEnvironment({ sandbox, registryUrl, variables, sandboxPort, node = process.execPath, inherited = process.env }) {
  const keep = /^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles|programfiles\(x86\)|programw6432|programdata|os|processor_architecture|number_of_processors)$/i;
  const env = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => keep.test(key) && typeof value === 'string'));
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [path.dirname(node), env[pathKey]].filter(Boolean).join(path.delimiter);
  const home = path.join(sandbox, 'home');
  const temp = path.join(sandbox, 'temp');
  return {
    ...env, NO_COLOR: '1', HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    npm_config_cache: path.join(sandbox, 'npm-cache'), npm_config_registry: registryUrl,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    // Keeps the run off the MCP Apps port that another FLUJO on this machine may hold.
    FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort),
    ...variables,
  };
}

/** The started app must keep its data in the chosen data folder. */
export function assertDataFolder(observed, dataDir, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const relative = typeof observed?.mcpServersDir === 'string' ? paths.relative(fold(dataDir), fold(observed.mcpServersDir)) : '';
  if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) {
    throw new Error('FLUJO keeps its data outside the folder chosen in the "choose" step.');
  }
}

const versionPattern = version => new RegExp(`(^|[^0-9.])${version.replaceAll('.', '\\.')}([^0-9.]|$)`, 'm');
export function assertShowsVersion(output, version) {
  if (!versionPattern(version).test(output)) throw new Error(`The "check" step should show version ${version}, but it printed:\n${output.slice(-800)}`);
}

export function assertNamesFailedJob(output, name) {
  const line = output.split(/\r?\n/).find(item => item.startsWith(`${name}: `));
  if (!line || line.length <= name.length + 2) throw new Error(`The "diagnose" step should list "${name}" with its error, but it printed:\n${output.slice(-800) || '(nothing)'}`);
  return line;
}

/** What a user sees of the test data, read without assuming anything else about the installation. */
export async function readView(request) {
  const json = async route => {
    const response = await request(route);
    if (response.status !== 200) throw new Error(`GET ${route.split('?')[0]} answered ${response.status}.`);
    return JSON.parse(response.bytes);
  };
  const { conversationId, flowId, variable } = syntheticIdentifiers;
  const conversation = await json(`/v1/chat/conversations/${conversationId}`);
  const flow = await json(`/api/flow/${flowId}`);
  return {
    theme: (await json('/api/storage?key=theme')).value,
    setting: { value: (await json(`/api/env?key=${variable}`)).value },
    conversation: { title: conversation.title, messages: (conversation.messages ?? []).map(({ role, content }) => ({ role, content })) },
    flow: { name: flow.name },
  };
}

const viewOf = observation => ({
  theme: observation.state.theme, setting: { value: observation.state.environment?.value },
  conversation: { title: observation.state.conversation.title,
    messages: observation.state.conversation.messages.map(({ role, content }) => ({ role, content })) },
  flow: { name: observation.flows.find(flow => flow.id === syntheticIdentifiers.flowId).name },
});

export function assertSameView(found, wanted, when) {
  if (JSON.stringify(found) !== JSON.stringify(wanted)) {
    throw new Error(`${when} the data differs.\nExpected: ${JSON.stringify(wanted)}\nFound:    ${JSON.stringify(found)}`);
  }
}

/** The backup file holds the test flow, conversation and theme, and no setting value. */
export async function verifyBackupFile(bytes, view, JSZip) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async name => {
    const file = zip.file(name);
    if (!file) throw new Error(`The backup has no ${name}.`);
    return JSON.parse(await file.async('string'));
  };
  const { conversationId, flowId } = syntheticIdentifiers;
  const flows = await read('storage/flows.json');
  if (!flows.some(flow => flow.id === flowId && flow.name === view.flow.name)) throw new Error('The backup does not hold the test flow.');
  const conversation = await read(`storage/conversations/${conversationId}.json`);
  if (JSON.stringify((conversation.messages ?? []).map(({ role, content }) => ({ role, content }))) !== JSON.stringify(view.conversation.messages)) {
    throw new Error('The backup does not hold the test conversation with its messages.');
  }
  if (await read('storage/theme.json') !== view.theme) throw new Error('The backup does not hold the theme.');
  const variables = await read('storage/global_env_vars.json');
  if (Object.values(variables).some(entry => entry?.value !== '')) throw new Error('The backup holds a setting value; values must never leave in a backup.');
}

/**
 * Walk the operator's journey. `operator` runs the page's steps; `world` acts
 * around the operator (data, a failed job, a later change); `checks` reads
 * what each step promises. A failing step stops the journey; the started app
 * is always stopped.
 */
export async function runJourney({ operator, world, checks, log = () => {} }) {
  const report = { steps: [], result: 'failed' };
  const step = async (label, operation) => {
    const entry = { step: label, result: 'failed' };
    report.steps.push(entry);
    const started = Date.now();
    try {
      const details = await operation();
      if (details) entry.details = details;
      entry.result = 'passed';
    } catch (error) {
      entry.error = error.message;
      throw error;
    } finally {
      entry.seconds = Math.round((Date.now() - started) / 100) / 10;
      log(entry);
    }
  };
  try {
    await step('choose', () => operator.chosen());
    await step('start', () => operator.start('start'));
    await step('check (installed version)', async () => checks.installed(await operator.run('check')));
    await step('a job fails and data exists', () => world.prepare());
    await step('diagnose', async () => checks.diagnosed(await operator.run('diagnose')));
    await step('back-up', async () => { await operator.run('back-up'); return checks.backedUp(); });
    await step('stop', () => operator.stop());
    await step('upgrade', () => operator.start('upgrade'));
    await step('check (new version)', async () => checks.upgraded(await operator.run('check')));
    await step('data changes after the backup', () => world.change());
    await step('restore', async () => { await operator.run('restore'); return checks.restored(); });
    await step('stop', () => operator.stop());
    report.result = 'passed';
  } catch (error) {
    report.failure = error.message;
  } finally {
    try { await operator.dispose(); } catch (error) {
      report.cleanup = error.message;
      report.result = 'failed';
    }
  }
  return report;
}

function printStep(entry) {
  console.log(`${entry.result === 'passed' ? 'PASS' : 'FAIL'}  ${entry.step} (${entry.seconds} s)${entry.error ? `\n      ${entry.error.split('\n').slice(0, 6).join('\n      ')}` : ''}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log(USAGE); return 0; }
  const runbook = parseRunbook(await readFile(options.runbook, 'utf8'));
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'flujo-operator-run-')));
  const report = { schemaVersion: 1, kind: 'flujo-operator-runbook', runbook: path.relative(root, options.runbook), platform: process.platform,
    shell, node: process.version, startedAt: new Date().toISOString(), result: 'failed' };
  const cleanups = [];
  try {
    for (const name of ['home/roaming', 'home/local', 'temp', 'npm-cache', 'data', 'backups', 'logs']) await mkdir(path.join(sandbox, name), { recursive: true });
    const directory = options.pack ? path.join(sandbox, 'tarballs') : options.tarballs;
    if (options.pack) await packCandidate({ root, directory, npmCli: await resolveNpmCli() });
    const { tarballs } = await readCandidateTarballs(directory);
    const registry = await startRegistry({ tarballs });
    cleanups.push(() => registry.close());
    const standIns = await startStandIns();
    cleanups.push(() => standIns.close());
    const newVersion = registry.candidates.get('flujo-ai')?.[0]?.version;
    const oldVersion = previousVersion(await registry.published('flujo-ai'), newVersion, options.from);
    const port = await unusedPort();
    let sandboxPort = await unusedPort();
    while (sandboxPort === port) sandboxPort = await unusedPort();
    const dataDir = path.join(sandbox, 'data');
    const variables = { FLUJO_VERSION: oldVersion, FLUJO_NEW_VERSION: newVersion, FLUJO_DATA_DIR: dataDir, FLUJO_PORT: String(port),
      FLUJO_BACKUP: path.join(sandbox, 'backups', 'flujo-backup.zip') };
    Object.assign(report, { oldVersion, newVersion });
    const env = operatorEnvironment({ sandbox, registryUrl: registry.url, variables, sandboxPort });
    const home = path.join(sandbox, 'home');
    const request = createRequester(`http://127.0.0.1:${port}`);
    const JSZip = createRequire(path.join(root, 'package.json'))('jszip');
    const probe = createFlujoProbe({ JSZip });
    let app; let seededView; let changedView;

    const script = id => runbook[id].blocks[shell];
    const operator = {
      chosen() {
        if ([...Object.keys(variables)].sort().join() !== [...OPERATOR_VARIABLES].sort().join()) throw new Error('The run and the "choose" step disagree on the settings.');
        return { variables: Object.keys(variables), oldVersion, newVersion };
      },
      async start(id) {
        if (!BACKGROUND_STEPS.includes(id)) throw new Error(`"${id}" is not a step that keeps running.`);
        const { file, args } = shellCommand(shell, script(id));
        app = createHostTarget({ label: `${id} step`, launch: { file, args }, cwd: home, env, port, logDirectory: path.join(sandbox, 'logs'),
          identity: observed => assertDataFolder(observed, dataDir) });
        await app.start();
        return { command: script(id) };
      },
      async run(id) {
        const { file, args } = shellCommand(shell, script(id));
        const watcher = new AbortController();
        const watch = setInterval(async () => {
          if (app && !(await app.running())) watcher.abort(new Error(`FLUJO stopped while the "${id}" step ran.\n${await app.diagnostics()}`));
        }, 1_000);
        try {
          return await runCommand(file, args, { cwd: home, env, timeoutMs: STEP_TIMEOUT_MS[id] ?? STEP_TIMEOUT_MS.default, signal: watcher.signal });
        } catch (error) {
          throw new Error(`The "${id}" step failed: ${error.message}`);
        } finally { clearInterval(watch); }
      },
      async stop() {
        const record = await app.stop();
        if (!record.portClosed || !(await waitForPortClosed(port, 1_000))) throw new Error('FLUJO still answers on its port after the "stop" step.');
        if (record.graceful === false) throw new Error(`FLUJO did not end on its own after the "stop" step (${record.mode}).`);
        app = undefined;
        return { mode: record.mode, exit: record.exit };
      },
      async dispose() { await app?.dispose(); },
    };
    const world = {
      async prepare() {
        seededView = viewOf(await probe.seed(request));
        const job = await probe.seedFailedJob(request, standIns, FAILED_JOB);
        return { failedJob: FAILED_JOB, error: job.error };
      },
      async change() {
        const values = changeValues(seededView, 'Changed after the backup');
        const results = await sendChanges(request, values);
        const refused = results.filter(item => item.status !== 200);
        if (refused.length) throw new Error(`Changing the data answered ${refused.map(item => `${item.item} ${item.status}`).join(', ')}.`);
        changedView = await readView(request);
        return { changed: results.map(item => item.item) };
      },
    };
    const identity = async () => {
      const response = await request('/api/cwd');
      if (response.status !== 200) throw new Error(`FLUJO did not identify itself (answer ${response.status}).`);
      assertDataFolder(JSON.parse(response.bytes), dataDir);
    };
    const checks = {
      async installed(output) { assertShowsVersion(output, oldVersion); await identity(); return { version: oldVersion }; },
      diagnosed: output => ({ line: assertNamesFailedJob(output, FAILED_JOB) }),
      async backedUp() { await verifyBackupFile(await readFile(variables.FLUJO_BACKUP), seededView, JSZip); return { backup: 'holds flow, conversation and theme; no setting value' }; },
      async upgraded(output) {
        assertShowsVersion(output, newVersion);
        await identity();
        assertSameView(await readView(request), seededView, 'After the upgrade');
        return { version: newVersion };
      },
      async restored() {
        // A restore brings back what the backup holds; a setting keeps its current value.
        assertSameView(await readView(request), { ...seededView, setting: changedView.setting }, 'After the restore');
        return { restored: ['flow', 'conversation', 'theme'], settingKept: true };
      },
    };
    console.log(`Operator runbook: ${shell}, install ${oldVersion}, upgrade to ${newVersion}`);
    Object.assign(report, await runJourney({ operator, world, checks, log: printStep }));
  } catch (error) {
    report.failure ??= error.message;
  } finally {
    for (const undo of cleanups.reverse()) await undo().catch(error => { report.cleanup = `${report.cleanup ?? ''}${error.message}\n`; });
    report.completedAt = new Date().toISOString();
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (options.keep) console.log(`Kept the test folder: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(error => console.warn(`Could not remove ${sandbox}: ${error.message}`));
  }
  if (report.result !== 'passed') {
    console.error(`\nThe operator runbook failed: ${report.failure ?? report.cleanup}`);
    return 1;
  }
  console.log(`\nEvery step of ${report.runbook} worked as written (${shell}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}

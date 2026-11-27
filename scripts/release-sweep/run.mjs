#!/usr/bin/env node
// The release sweep: start a FLUJO build on a throwaway data folder, walk every feature map entry's
// driving steps like a user, and write one report with a screenshot and accessibility snapshot for
// each failure. Report only: it never changes code. How it fits together: docs/release-sweep.md.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_DIR, freePort, isAlive, loadChromium, main as drive, parseArgs, parseViewport, probe, readState, runStep, settle, tail,
} from '../flujo-drive.mjs';
import { drillEnvironment } from '../maintainer-drill.mjs';
import { problemsFromReport } from './problems.mjs';
import { loadPlan, slug } from './steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX_PREFIX = 'flujo-sweep-';
const RESERVED_PORT = '4200';
const INSTALL_ATTEMPTS = 3;
export const EXIT = Object.freeze({ passed: 0, problems: 1, broken: 2 });

export const USAGE = `Usage: node scripts/release-sweep/run.mjs [target] [options]

Walks every feature map entry's driving steps on a throwaway FLUJO and writes report.json and
report.md, with a screenshot and accessibility snapshot for each failure. It never uses the
everyday FLUJO on port 4200 or any instance whose data lives outside a temporary folder.

Target (pick one; default: the instance "npm run drive -- launch" started for this checkout):
  --release VERSION        Install flujo-ai@VERSION from npm into a temporary folder and start it there.
  --launch                 Start this checkout (or --app-dir DIR) on a temporary data folder:
    --mode dev|start       dev (default) compiles pages as they are opened; start needs "npm run build" first.
  --base-url URL           An instance that is already running on a temporary data folder.

Options:
  --map DIR                Feature map folder (default: docs/feature-map in this checkout).
  --only a,b               Only these entries (file names without .md), for example --only settings,help.
  --out DIR                Report folder (default: ${path.join(EVIDENCE_DIR, 'release-sweep', '<label>')}).
  --label NAME             Version shown in the report (default: the release, else package version +local).
  --viewport WxH           Browser size (default 1280x720, like flujo-drive).
  --check-timeout SECONDS  Longest one check may take (default 180).
  --page-timeout SECONDS   Longest all checks of one entry may take together (default 600).
  --startup-timeout SECONDS  Longest the instance may take to answer (default 600).
  --no-warm                Skip loading every swept page once before the sweep (dev mode only).

Exit code 0: every runnable step passed. 1: the sweep found problems. 2: the sweep could not run.`;

class UsageError extends Error {}

function realOrResolved(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function isInside(child, parent, platform = process.platform) {
  const fold = (value) => (platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(fold(parent), fold(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Folders a sweep may treat as throwaway: the temp folder (and CI's), in every spelling the OS uses. */
export function throwawayRoots(env = process.env, tempDir = os.tmpdir()) {
  return [...new Set([tempDir, env.RUNNER_TEMP].filter(Boolean).flatMap((dir) => [path.resolve(dir), realOrResolved(dir)]))];
}

export function chooseTarget(options, driveState = readState()) {
  const picked = ['base-url', 'release', 'launch'].filter((key) => options[key] !== undefined);
  if (picked.length > 1) throw new UsageError(`Pick one target, not ${picked.map((key) => `--${key}`).join(' and ')}.`);
  if (options.release !== undefined) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(options.release))) throw new UsageError('--release needs a version such as 3.48.10.');
    return { kind: 'release', version: String(options.release) };
  }
  if (options.launch !== undefined) {
    const mode = options.mode ?? 'dev';
    if (!['dev', 'start'].includes(mode)) throw new UsageError('--mode must be dev or start.');
    return { kind: 'launch', mode, appDir: path.resolve(typeof options['app-dir'] === 'string' ? options['app-dir'] : ROOT) };
  }
  const baseUrl = typeof options['base-url'] === 'string' ? options['base-url'] : driveState?.baseUrl;
  if (!baseUrl) {
    throw new UsageError('Nothing to sweep. Start a throwaway FLUJO with "npm run drive -- launch", or pass --launch, --release VERSION or --base-url URL.');
  }
  if (new URL(baseUrl).port === RESERVED_PORT) throw new UsageError('Refusing port 4200: it is the everyday FLUJO with real data.');
  return { kind: 'url', baseUrl, fromDrive: typeof options['base-url'] !== 'string' };
}

/** Refuses an instance unless its data folder sits inside one of `roots`. */
export async function assertThrowawayData(baseUrl, roots, fetchImpl = fetch) {
  let body;
  let status = 'no answer';
  try {
    const response = await fetchImpl(new URL('/api/cwd', baseUrl), { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    status = response.status;
    body = response.ok ? await response.json() : undefined;
  } catch { /* handled below */ }
  if (typeof body?.mcpServersDir !== 'string') {
    throw new Error(`Could not confirm that ${baseUrl} keeps its data in a throwaway folder (/api/cwd: ${status}). The sweep never drives an instance with real data.`);
  }
  const dataDir = realOrResolved(body.mcpServersDir);
  if (![body.mcpServersDir, dataDir].some((dir) => roots.some((root) => isInside(dir, root)))) {
    throw new Error(`${baseUrl} keeps its data in ${body.mcpServersDir}, outside a throwaway folder. `
      + 'The sweep never drives an instance with real data; start one with "npm run drive -- launch" or pass --launch.');
  }
  return body.mcpServersDir;
}

function npmCli(env = process.env) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
  if (!found) throw new Error('Could not find npm beside Node to install the release.');
  return found;
}

function runToEnd(args, { cwd, env, timeoutMs, logFile }) {
  return new Promise((resolve, reject) => {
    const out = openSync(logFile, 'a');
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', out, out], windowsHide: true });
    closeSync(out);
    const timer = setTimeout(() => { killTree(child.pid); reject(new Error(`${path.basename(args[0])} took longer than ${timeoutMs / 1000}s.`)); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

/** Installs the published package into the sandbox with empty npm settings, so no private registry or token is used. */
async function installRelease(version, sandbox, env, log) {
  const consumer = path.join(sandbox, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  const emptyConfig = path.join(sandbox, 'empty.npmrc');
  writeFileSync(emptyConfig, '');
  const installLog = path.join(sandbox, 'install.log');
  // A version published a minute ago may not be on every registry mirror yet, and networks drop; try a few times.
  let code;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    log(`Installing flujo-ai@${version} from npm into ${consumer}${attempt > 1 ? ` (try ${attempt} of ${INSTALL_ATTEMPTS})` : ''}`);
    code = await runToEnd([npmCli(), 'install', `flujo-ai@${version}`, '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org', `--userconfig=${emptyConfig}`, `--globalconfig=${emptyConfig}`], {
      cwd: consumer, env: { ...env, npm_config_cache: path.join(sandbox, 'npm-cache') }, timeoutMs: 900_000, logFile: installLog,
    });
    if (code === 0) break;
    if (attempt < INSTALL_ATTEMPTS) await new Promise((resolve) => { setTimeout(resolve, 30_000 * attempt); });
  }
  if (code !== 0) throw new Error(`npm install flujo-ai@${version} failed ${INSTALL_ATTEMPTS} times (exit ${code}):\n${tail(installLog)}`);
  const appRoot = path.join(consumer, 'node_modules', 'flujo-ai');
  const manifest = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`npm installed flujo-ai ${manifest.version}, not ${version}.`);
  return appRoot;
}

export function killTree(pid) {
  if (!Number.isInteger(pid) || !isAlive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function waitUntil(condition, timeoutMs, stepMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => { setTimeout(resolve, stepMs); });
  }
  return condition();
}

/** Starts FLUJO with all its data inside a new temporary folder. The handle says what `stopInstance` removes. */
async function startInstance(target, options, log) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const handle = { sandbox, logFile: path.join(sandbox, 'flujo.log'), pid: undefined, baseUrl: undefined };
  try {
    const dataDir = path.join(sandbox, 'data');
    mkdirSync(dataDir);
    const port = options.port ? Number(options.port) : await freePort();
    if (!Number.isInteger(port) || String(port) === RESERVED_PORT) throw new UsageError(`Port ${options.port} is reserved or invalid.`);
    let args;
    let cwd;
    let env;
    if (target.kind === 'release') {
      env = { ...drillEnvironment(process.env, sandbox), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
      for (const dir of [env.HOME, env.TEMP]) mkdirSync(dir, { recursive: true });
      cwd = await installRelease(target.version, sandbox, env, log);
      args = [path.join(cwd, 'bin', 'flujo.mjs'), '--no-open', '--port', String(port)];
    } else {
      if (target.mode === 'start' && !existsSync(path.join(target.appDir, '.next', 'BUILD_ID'))) {
        throw new UsageError(`${target.appDir} has no production build. Run "npm run build" there first, or use --mode dev.`);
      }
      cwd = target.appDir;
      env = { ...process.env, FLUJO_DATA_DIR: dataDir, FLUJO_PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' };
      args = ['scripts/launch-next.mjs', target.mode, ...(target.mode === 'dev' ? ['--webpack'] : []), '-p', String(port), '-H', '127.0.0.1'];
    }
    const out = openSync(handle.logFile, 'a');
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    closeSync(out);
    handle.pid = child.pid;
    handle.baseUrl = `http://127.0.0.1:${port}/`;
    log(`Starting FLUJO at ${handle.baseUrl} (pid ${child.pid}, everything in ${sandbox}).`);
    const ready = await waitUntil(async () => {
      if (!isAlive(child.pid)) throw new Error(`FLUJO exited during startup. Last log lines:\n${tail(handle.logFile)}`);
      const { api, page } = await probe(handle.baseUrl);
      return api && page;
    }, Number(options['startup-timeout'] ?? 600) * 1000, 2_000);
    if (!ready) throw new Error(`FLUJO did not answer within ${options['startup-timeout'] ?? 600}s. Last log lines:\n${tail(handle.logFile)}`);
    return handle;
  } catch (error) {
    error.handle = handle;
    throw error;
  }
}

async function stopInstance(handle, out, log) {
  if (!handle) return;
  killTree(handle.pid);
  if (handle.pid) await waitUntil(() => !isAlive(handle.pid), 15_000, 500);
  if (out && existsSync(handle.logFile)) {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'flujo-log-tail.txt'), `${tail(handle.logFile, 400)}\n`);
  }
  if (path.basename(handle.sandbox).startsWith(SANDBOX_PREFIX) && path.dirname(handle.sandbox) === path.resolve(os.tmpdir())) {
    rmSync(handle.sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  log(`Stopped FLUJO${handle.pid ? ` (pid ${handle.pid})` : ''} and removed ${handle.sandbox}.`);
}

async function stillAnswering(baseUrl) {
  return waitUntil(async () => (await probe(baseUrl, 10_000)).api, 30_000, 5_000);
}

/** A switch or checkbox step: turn it on unless it already is, then check that it stayed on. */
async function ensureOn(page, step, log) {
  const target = page.getByRole(step.role, { name: step.name, exact: step.exact ?? false }).filter({ visible: true }).first();
  await target.waitFor({ timeout: 30_000 });
  if ((await target.isChecked().catch(() => false)) !== true) await target.click();
  const on = await waitUntil(() => target.isChecked().catch(() => false), 10_000, 250);
  if (!on) throw new Error(`The ${step.role} "${step.name}" did not turn on.`);
  await settle(page, log);
}

async function save(page, kind, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (kind === 'shot') await page.screenshot({ path: file, fullPage: true, timeout: 15_000 });
  else writeFileSync(file, await page.locator('body').ariaSnapshot({ timeout: 15_000 }));
}

/** Runs one check in a fresh browser session, within `budgetMs`. */
async function runCheck(browser, check, { baseUrl, viewport, out, budgetMs }) {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message.split('\n')[0].slice(0, 300)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  const started = Date.now();
  let index = 0;
  let timer;
  const quiet = () => {};
  const finish = (fields) => ({ ...fields, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), pageErrors, consoleErrors: consoleErrors.slice(0, 20) });
  try {
    const run = (async () => {
      for (; index < check.steps.length; index += 1) {
        const step = check.steps[index];
        if (step.do === 'check') await ensureOn(page, step, quiet);
        else await runStep(page, step, baseUrl, quiet);
      }
    })();
    run.catch(() => undefined);
    const budget = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The check took longer than ${Math.round(budgetMs / 1000)}s, the time a sweep gives one check.`)), budgetMs);
    });
    await Promise.race([run, budget]);
    return finish({ status: 'passed' });
  } catch (error) {
    const base = path.join(check.entry, `${slug(check.label)}-failed`);
    const evidence = {};
    for (const [kind, file] of [['shot', `${base}.png`], ['aria', `${base}.aria.yml`]]) {
      try {
        await save(page, kind, path.join(out, file));
        evidence[kind === 'shot' ? 'screenshot' : 'aria'] = file.split(path.sep).join('/');
      } catch { /* the page may already be gone */ }
    }
    const ariaExcerpt = evidence.aria
      ? readFileSync(path.join(out, base + '.aria.yml'), 'utf8').split('\n').slice(0, 60).join('\n').slice(0, 4000) : undefined;
    let url;
    try { url = `${new URL(page.url()).pathname}${new URL(page.url()).search}`; } catch { /* no page */ }
    return finish({
      status: 'failed',
      error: String(error.message ?? error).split('\n')[0].slice(0, 500),
      failedStep: { index: Math.min(index, check.steps.length - 1), total: check.steps.length, step: check.steps[Math.min(index, check.steps.length - 1)], steps: check.steps },
      url, evidence, ariaExcerpt,
    });
  } finally {
    clearTimeout(timer);
    // The guided tour is saved on the server; closing it keeps one check's tour from covering the next check.
    const closeTour = page.getByRole('button', { name: 'Close tour' }).filter({ visible: true });
    if (await closeTour.count().catch(() => 0)) await closeTour.first().click({ timeout: 5_000 }).catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

export async function sweep(plan, { baseUrl, viewport, out, log, checkTimeoutMs, pageTimeoutMs, browser }) {
  const entries = [];
  let instanceProblem;
  for (const entry of plan) {
    const pageDeadline = Date.now() + pageTimeoutMs;
    const checks = [];
    log(`\n${entry.title} (${entry.file})`);
    for (const check of entry.checks) {
      const base = { id: check.id, entry: entry.entry, file: entry.file, entryTitle: entry.title, label: check.label };
      let result;
      if (instanceProblem) result = { status: 'not-run', reason: 'FLUJO had stopped answering' };
      else if (check.status !== 'auto') result = { status: check.status, reason: check.reason };
      else if (pageDeadline <= Date.now()) result = { status: 'not-run', reason: `the entry used its ${pageTimeoutMs / 1000}s` };
      else {
        const pageViewport = check.viewport ? parseViewport(check.viewport) : viewport;
        result = await runCheck(browser, check, { baseUrl, viewport: pageViewport, out, budgetMs: Math.min(checkTimeoutMs, pageDeadline - Date.now()) });
        if (result.status === 'failed' && !(await stillAnswering(baseUrl))) instanceProblem = `FLUJO stopped answering during ${check.id}: ${result.error}`;
      }
      const mark = { passed: '✓', failed: '✗' }[result.status] ?? '·';
      log(`  ${mark} ${check.label}${result.status === 'failed' ? `: ${result.error}` : ''}${result.reason ? ` (${result.status}: ${result.reason})` : ''}`
        + `${result.pageErrors?.length ? ` [page error: ${result.pageErrors[0]}]` : ''}`);
      checks.push({ ...base, ...result });
    }
    entries.push({ entry: entry.entry, file: entry.file, title: entry.title, checks });
  }
  return { entries, instanceProblem };
}

export function countResults(entries) {
  const counts = { passed: 0, failed: 0, pageErrors: 0, needs: 0, manual: 0, unsafe: 0, notRun: 0 };
  for (const check of entries.flatMap((entry) => entry.checks)) {
    const key = check.status === 'not-run' ? 'notRun' : check.status;
    counts[key] = (counts[key] ?? 0) + 1;
    if (check.pageErrors?.length) counts.pageErrors += 1;
  }
  return counts;
}

export function renderReport(report) {
  const { counts } = report;
  const lines = [
    `# Release sweep: ${report.target.version ?? 'unknown version'}`,
    '',
    `Result: **${report.result}** (exit ${report.exitCode}). ${counts.passed} passed, ${counts.failed} failed, ${counts.pageErrors} with page errors, `
      + `${counts.notRun} not run. Not covered by the sweep: ${counts.needs} need setup, ${counts.manual} manual, ${counts.unsafe} unsafe.`,
    '',
    `Target: ${report.target.kind}${report.target.baseUrl ? ` at ${report.target.baseUrl}` : ''}. Started ${report.startedAt}, finished ${report.finishedAt}.`,
  ];
  if (report.brokenReason) lines.push('', `The sweep could not run: ${report.brokenReason}`);
  if (report.instanceProblem) lines.push('', `FLUJO stopped answering: ${report.instanceProblem}`);
  if (report.problems.length) {
    lines.push('', '## Problems', '');
    for (const problem of report.problems) {
      const evidence = problem.checks[0]?.evidence ?? {};
      lines.push(`- \`${problem.fingerprint}\` ${problem.title}${evidence.screenshot ? ` (${evidence.screenshot})` : ''}`);
    }
  }
  lines.push('', '## Every step', '');
  for (const entry of report.entries) {
    lines.push(`### ${entry.title}`, '');
    for (const check of entry.checks) {
      const detail = check.status === 'failed' ? `: ${check.error}` : check.reason ? `: ${check.reason}` : '';
      lines.push(`- ${check.status} · ${check.label}${detail}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function packageVersion(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { options } = parseArgs(['sweep', ...argv]);
  if (options.help) {
    log(USAGE);
    return EXIT.passed;
  }
  const startedAt = new Date();
  let target;
  let plan;
  try {
    target = chooseTarget(options);
    plan = loadPlan(path.resolve(typeof options.map === 'string' ? options.map : path.join(ROOT, 'docs/feature-map')), {
      only: typeof options.only === 'string' ? options.only.split(',').map((name) => name.trim()).filter(Boolean) : undefined,
    });
  } catch (error) {
    log(error.message);
    if (error instanceof UsageError) log(`\n${USAGE}`);
    return EXIT.broken;
  }
  const version = typeof options.label === 'string' ? options.label
    : target.kind === 'release' ? target.version : `${packageVersion(target.appDir ?? ROOT)}+local`;
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(typeof options.out === 'string' ? options.out : path.join(EVIDENCE_DIR, 'release-sweep', `${version}-${stamp}`));
  const report = {
    schema: 1, tool: 'release-sweep', target: { kind: target.kind, version, mode: target.mode, baseUrl: target.baseUrl },
    startedAt: startedAt.toISOString(), viewport: options.viewport ?? '1280x720', entries: [], problems: [],
  };
  let handle;
  let browser;
  const stopOnSignal = () => {
    killTree(handle?.pid);
    process.exit(EXIT.broken);
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  try {
    const viewport = parseViewport(options.viewport);
    const autoChecks = plan.flatMap((entry) => entry.checks).filter((check) => check.status === 'auto');
    if (!autoChecks.length) throw new Error('The feature map has no step the sweep can run (see "Steps the release sweep can run" in docs/feature-map/README.md).');
    let roots = throwawayRoots();
    let baseUrl = target.baseUrl;
    if (target.kind !== 'url') {
      try {
        handle = await startInstance(target, options, log);
      } catch (error) {
        handle = error.handle;
        throw error;
      }
      baseUrl = handle.baseUrl;
      roots = [handle.sandbox, realOrResolved(handle.sandbox)];
    }
    report.target.baseUrl = baseUrl;
    report.dataDir = await assertThrowawayData(baseUrl, roots);
    const devMode = target.mode === 'dev' || target.fromDrive;
    if (devMode && options['no-warm'] === undefined) {
      const routes = [...new Set(autoChecks.flatMap((check) => check.steps).filter((step) => step.do === 'goto').map((step) => step.route))];
      log(`Loading ${routes.length} pages once so dev mode compiles them before the sweep times anything.`);
      await drive(['warm', ...routes, '--base-url', baseUrl], log);
    }
    browser = await loadChromium();
    const result = await sweep(plan, {
      baseUrl, viewport, out, log, browser,
      checkTimeoutMs: Number(options['check-timeout'] ?? 180) * 1000,
      pageTimeoutMs: Number(options['page-timeout'] ?? 600) * 1000,
    });
    report.entries = result.entries;
    if (result.instanceProblem) report.instanceProblem = result.instanceProblem;
  } catch (error) {
    report.result = 'broken';
    report.brokenReason = String(error.message ?? error);
    log(`The sweep could not run: ${report.brokenReason}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopInstance(handle, out, log).catch((error) => log(`! Could not stop FLUJO cleanly: ${error.message}`));
    process.off('SIGINT', stopOnSignal);
    process.off('SIGTERM', stopOnSignal);
  }
  report.counts = countResults(report.entries);
  report.problems = problemsFromReport(report);
  report.result ??= report.problems.length ? 'problems' : 'passed';
  report.exitCode = EXIT[report.result];
  report.finishedAt = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'report.md'), renderReport(report));
  log(`\n${report.result}: ${report.counts.passed} passed, ${report.counts.failed} failed, ${report.problems.length} problem(s).`);
  log(`Report: ${path.join(out, 'report.md')}`);
  return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = EXIT.broken;
  });
}

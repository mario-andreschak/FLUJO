#!/usr/bin/env node
// Launches a throwaway FLUJO and drives it like a user, for agents verifying their own changes.
// The how-to is .claude/skills/verify-flujo/SKILL.md; what to drive is docs/feature-map/.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPages, pageRoutes } from './check-feature-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR_PREFIX = 'flujo-drive-data-';

// The shared temp folder is writable by every user on Linux and macOS, so the state file that
// names what "stop" kills and deletes lives in the user's own cache folder instead.
export function defaultDriveHome(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.FLUJO_DRIVE_HOME) return path.resolve(env.FLUJO_DRIVE_HOME);
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'flujo-drive');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'flujo-drive');
}

export const HOME = defaultDriveHome();
const STATE_FILE = path.join(HOME, 'instance.json');
export const EVIDENCE_DIR = path.join(HOME, 'evidence');
const RESERVED_PORTS = new Set([4200]);
const STEP_KINDS = new Set(['goto', 'click', 'fill', 'press', 'wait-for', 'expect-text', 'shot', 'aria']);

export const USAGE = `Usage: node scripts/flujo-drive.mjs <command> [options]

Instance (one at a time, never the instance on port 4200):
  launch [--port N] [--data-dir DIR] [--timeout SECONDS]
                      Start a throwaway FLUJO with an empty data folder; returns once a page renders.
  doctor              Read-only: is the instance this tool started alive, on its port, and serving pages?
  warm [ROUTE...]     Load every page once (default: all pages without [params]) so dev mode compiles them
                      before you drive; the first compile of a large page takes up to a few minutes.
  stop                Stop only the instance this tool started and delete the data folder it created.
                      Evidence is kept.

Drive (headless Chromium; each command is one fresh browser session):
  open <route>                                  Load the page; print its title, headings and errors.
  text <route>                                  Print the visible text.
  aria <route> [--out FILE]                     Print or save the accessibility snapshot.
  shot <route> --out FILE.png [--full]          Screenshot.
  click <route> --role ROLE --name NAME         Click by ARIA role and accessible name.
  fill <route> --label LABEL --value TEXT       Fill a field by its label.
  steps <route> --file STEPS.json               Run several steps in one session (see the skill).

Drive options: --viewport WxH (default 1280x720), --then-shot FILE.png, --then-aria FILE,
  --base-url URL (default: the launched instance).
Relative evidence paths are saved under ${EVIDENCE_DIR}.`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) options[key] = inline;
    else if (rest[index + 1] !== undefined && !rest[index + 1].startsWith('--')) options[key] = rest[++index];
    else options[key] = true;
  }
  return { command, positional, options };
}

export function parseViewport(value = '1280x720') {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(value));
  if (!match) throw new Error(`--viewport must look like 1280x720, got "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function routeUrl(baseUrl, route = '/') {
  if (/^https?:\/\//.test(route)) throw new Error('Pass a route such as /flows, not a full URL; use --base-url for the host.');
  if (/^[A-Za-z]:[\\/]/.test(route)) {
    throw new Error(`"${route}" is a Windows path: Git Bash rewrites arguments that start with "/". `
      + 'Leave out the leading slash (flows, roles/new), omit the route for the home page, or set MSYS_NO_PATHCONV=1.');
  }
  return new URL(route.startsWith('/') ? route : `/${route}`, baseUrl).toString();
}

export function evidencePath(file, evidenceDir = EVIDENCE_DIR) {
  return path.isAbsolute(file) ? file : path.join(evidenceDir, file);
}

export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('The steps file must hold a non-empty JSON array.');
  steps.forEach((step, index) => {
    const where = `step ${index + 1}`;
    if (!STEP_KINDS.has(step?.do)) throw new Error(`${where}: "do" must be one of ${[...STEP_KINDS].join(', ')}`);
    const need = { goto: ['route'], click: ['role', 'name'], fill: ['label', 'value'], press: ['key'], 'wait-for': ['role', 'name'], 'expect-text': ['text'], shot: ['out'], aria: ['out'] }[step.do];
    for (const field of need) {
      if (typeof step[field] !== 'string' || !step[field]) throw new Error(`${where} (${step.do}) needs "${field}"`);
    }
  });
  return steps;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isOwnedDataDir(dir, tempDir = os.tmpdir()) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir);
  return samePath(path.dirname(resolved), path.resolve(tempDir))
    && new RegExp(`^${DATA_DIR_PREFIX}[A-Za-z0-9]{6}$`).test(path.basename(resolved));
}

export function stopPlan(state, tempDir = os.tmpdir()) {
  const pid = Number.isInteger(state?.pid) && state.pid > 0 ? state.pid : undefined;
  if (pid === undefined) return { pid: undefined, dataDir: undefined };
  const dataDir = state.ownsDataDir && isOwnedDataDir(state.dataDir, tempDir) ? path.resolve(state.dataDir) : undefined;
  return { pid, dataDir };
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port: chosen } = server.address();
        server.close(() => resolve(chosen));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

// Dev mode drops pages it has not served for a while and compiles them again on the next visit.
async function probe(baseUrl, apiTimeoutMs = 5_000) {
  const result = { api: false, page: false };
  try {
    const response = await fetch(new URL('/api/cwd', baseUrl), { redirect: 'error', signal: AbortSignal.timeout(apiTimeoutMs) });
    result.api = response.ok && (await response.json())?.success === true;
  } catch { /* not up yet */ }
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(60_000) });
    result.page = response.ok && /<html/i.test(await response.text());
  } catch { /* not up yet */ }
  return result;
}

function tail(file, lines = 25) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

async function launch(options, log) {
  const existing = readState();
  if (existing && isAlive(existing.pid)) {
    throw new Error(`An instance from this tool is already running at ${existing.baseUrl} (pid ${existing.pid}). Run "stop" first.`);
  }
  const port = options.port ? Number(options.port) : await freePort();
  if (!Number.isInteger(port) || RESERVED_PORTS.has(port)) throw new Error(`Port ${options.port} is reserved or invalid; 4200 belongs to the everyday FLUJO.`);
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const ownsDataDir = !options['data-dir'];
  const dataDir = path.resolve(options['data-dir'] || mkdtempSync(path.join(os.tmpdir(), DATA_DIR_PREFIX)));
  mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(HOME, `instance-${port}.log`);
  const out = openSync(logFile, 'w');
  const child = spawn(process.execPath, ['scripts/launch-next.mjs', 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, FLUJO_DATA_DIR: dataDir, FLUJO_PORT: String(port) },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  child.unref();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const state = { pid: child.pid, port, baseUrl, dataDir, ownsDataDir, logFile, root: ROOT, startedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  log(`Starting FLUJO at ${baseUrl} (pid ${child.pid}, data ${dataDir}). The first page compile can take a few minutes.`);
  const deadline = Date.now() + Number(options.timeout || 600) * 1000;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) throw new Error(`FLUJO exited during startup. Last log lines:\n${tail(logFile)}`);
    const { api, page } = await probe(baseUrl);
    if (api && page) {
      log(`Ready: ${baseUrl}\nLog: ${logFile}`);
      return 0;
    }
    await new Promise((resolve) => { setTimeout(resolve, 2_000); });
  }
  throw new Error(`FLUJO did not become ready in time. It is still running; use "doctor" or "stop". Last log lines:\n${tail(logFile)}`);
}

async function doctor(log) {
  const state = readState();
  if (!state) {
    log('✗ No instance started by this tool. Run "launch".');
    return 1;
  }
  const alive = isAlive(state.pid);
  const { api, page } = alive ? await probe(state.baseUrl, 120_000) : { api: false, page: false };
  const checks = [
    [alive, `process ${state.pid} is running`],
    [api, `${state.baseUrl}api/cwd answers`],
    [page, `${state.baseUrl} renders a page`],
    [existsSync(state.dataDir), `data folder ${state.dataDir} exists`],
    [path.resolve(state.root) === ROOT, `started from this checkout (${state.root})`],
  ];
  for (const [ok, label] of checks) log(`${ok ? '✓' : '✗'} ${label}`);
  log(`Log: ${state.logFile}`);
  return checks.every(([ok]) => ok) ? 0 : 1;
}

async function warm(routes, options, log) {
  const baseUrl = options['base-url'] || readState()?.baseUrl;
  if (!baseUrl) throw new Error('No instance to warm. Run "launch" first, or pass --base-url.');
  const targets = routes.length ? routes : pageRoutes(findPages(path.join(ROOT, 'src/app'))).filter((route) => !route.includes('['));
  let failed = 0;
  for (const route of targets) {
    const started = Date.now();
    try {
      const response = await fetch(routeUrl(baseUrl, route), { signal: AbortSignal.timeout(300_000) });
      await response.arrayBuffer();
      log(`${response.ok ? '✓' : '✗'} ${route} ${response.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!response.ok) failed += 1;
    } catch (error) {
      failed += 1;
      log(`✗ ${route} ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

function stop(log) {
  const state = readState();
  if (!state) {
    log('Nothing to stop: no instance started by this tool.');
    return 0;
  }
  const { pid, dataDir } = stopPlan(state);
  if (pid !== undefined && isAlive(pid)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  else if (state.ownsDataDir && typeof state.dataDir === 'string') {
    log(`! ${state.dataDir} is not a data folder this tool created in ${os.tmpdir()}, so it was left in place.`);
  }
  rmSync(STATE_FILE, { force: true });
  const stopped = pid === undefined ? 'Nothing stopped: the state file named no valid process' : `Stopped pid ${pid}`;
  log(`${stopped}${dataDir ? ' and removed its data folder' : ''}. Evidence stays in ${EVIDENCE_DIR}.`);
  return 0;
}

export async function loadChromium() {
  const { chromium } = await import('playwright');
  const executablePath = process.env.FLUJO_DRIVE_CHROMIUM || process.env.FEATURE_BROWSER_CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

// FLUJO shows `.app-loading` while it opens the workspace; role="alert" marks a dead end (error, owner sign-in).
// A dead end that offers "Retry" is retried a few times and reported, because dev mode answers slowly while it compiles.
export async function settle(page, log) {
  await page.waitForLoadState('load');
  for (let attempt = 1; ; attempt += 1) {
    await page.waitForFunction(
      () => !document.querySelector('.app-loading') || document.querySelector('.app-loading[role="alert"]'),
      null,
      { timeout: 180_000 },
    ).catch(() => {
      throw new Error('FLUJO stayed on its loading screen for 3 minutes. Run "doctor" and read the instance log.');
    });
    const dead = page.locator('.app-loading[role="alert"]');
    if (!(await dead.count())) break;
    const message = (await dead.first().innerText()).replace(/\s+/g, ' ').trim();
    const retry = dead.getByRole('button', { name: 'Retry' });
    if (attempt > 3 || !(await retry.count())) throw new Error(`FLUJO shows instead of the page: "${message}"`);
    log(`! FLUJO showed "${message}"; pressing Retry (${attempt}/3)`);
    await page.waitForTimeout(5_000 * attempt);
    await retry.click();
    await page.waitForLoadState('load');
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  // Spinners without a value (indeterminate progress) mean a list or panel is still loading.
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[role="progressbar"]:not([aria-valuenow])')].some((element) => element.getClientRects().length),
    null,
    { timeout: 60_000 },
  ).catch(() => log('! A loading spinner was still showing after 60s.'));
}

async function gotoWithRetry(page, url, log) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await page.goto(url, { timeout: 300_000 });
      return;
    } catch (error) {
      if (!/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(error.message) || Date.now() > deadline) throw error;
      log('! FLUJO did not answer (dev server restarting?); trying again in 5s');
      await page.waitForTimeout(5_000);
    }
  }
}

export async function save(page, kind, file, log) {
  const target = evidencePath(file);
  mkdirSync(path.dirname(target), { recursive: true });
  if (kind === 'shot') await page.screenshot({ path: target, fullPage: true });
  else writeFileSync(target, await page.locator('body').ariaSnapshot());
  log(`Saved ${kind === 'shot' ? 'screenshot' : 'ARIA snapshot'}: ${target}`);
}

export async function runStep(page, step, baseUrl, log) {
  switch (step.do) {
    case 'goto':
      await gotoWithRetry(page, routeUrl(baseUrl, step.route), log);
      await settle(page, log);
      break;
    case 'click':
      await page.getByRole(step.role, { name: step.name, exact: step.exact ?? false }).filter({ visible: true }).first().click();
      await settle(page, log);
      break;
    case 'fill':
      await page.getByLabel(step.label, { exact: step.exact ?? false }).filter({ visible: true }).first().fill(step.value);
      break;
    case 'press':
      await page.keyboard.press(step.key);
      await settle(page, log);
      break;
    case 'wait-for':
      await page.getByRole(step.role, { name: step.name }).filter({ visible: true }).first().waitFor({ timeout: Number(step.timeout ?? 60_000) });
      break;
    case 'expect-text':
      await page.waitForFunction(
        (text) => document.body.innerText.replace(/\s+/g, ' ').toLowerCase().includes(text.replace(/\s+/g, ' ').toLowerCase()),
        step.text,
        { timeout: Number(step.timeout ?? 60_000) },
      ).catch(() => {
        throw new Error(`"${step.text}" did not appear on the page within ${Number(step.timeout ?? 60_000) / 1000}s.`);
      });
      break;
    default:
      await save(page, step.do, step.out, log);
  }
  log(`✓ ${step.do} ${step.route ?? step.name ?? step.label ?? step.key ?? step.text ?? step.out}`);
}

async function drive(command, positional, options, log) {
  const state = readState();
  const baseUrl = options['base-url'] || state?.baseUrl;
  if (!baseUrl) throw new Error('No instance to drive. Run "launch" first, or pass --base-url.');
  if (new URL(baseUrl).port === '4200' && !options['base-url']) throw new Error('Refusing to drive port 4200 by default.');
  const route = positional[0] || '/';
  const steps = [{ do: 'goto', route }];
  if (command === 'click') steps.push({ do: 'click', role: options.role, name: options.name });
  if (command === 'fill') steps.push({ do: 'fill', label: options.label, value: options.value });
  if (command === 'shot') steps.push({ do: 'shot', out: options.out });
  if (command === 'steps') steps.push(...JSON.parse(readFileSync(String(options.file), 'utf8')));
  if (options['then-shot']) steps.push({ do: 'shot', out: options['then-shot'] });
  if (options['then-aria']) steps.push({ do: 'aria', out: options['then-aria'] });
  validateSteps(steps);

  const browser = await loadChromium();
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: parseViewport(options.viewport), locale: 'en-US' });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
    });
    for (const step of steps) await runStep(page, step, baseUrl, log);
    if (command === 'open') {
      const headings = await page.getByRole('heading').allInnerTexts();
      log(`Title: ${await page.title()}\nURL: ${page.url()}\nHeadings: ${headings.slice(0, 12).join(' | ') || '(none)'}`);
    }
    if (command === 'text') log(await page.locator('body').innerText());
    if (command === 'aria' && !options.out) log(await page.locator('body').ariaSnapshot());
    if (command === 'aria' && options.out) await save(page, 'aria', options.out, log);
  } finally {
    await browser.close();
  }
  for (const problem of problems.slice(0, 20)) log(`! ${problem}`);
  return 0;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { command, positional, options } = parseArgs(argv);
  switch (command) {
    case 'launch': return launch(options, log);
    case 'doctor': return doctor(log);
    case 'warm': return warm(positional, options, log);
    case 'stop': return stop(log);
    case 'open': case 'text': case 'aria': case 'shot': case 'click': case 'fill': case 'steps':
      if (command === 'shot' && !options.out) throw new Error('shot needs --out FILE.png');
      if (command === 'click' && !(options.role && options.name)) throw new Error('click needs --role and --name');
      if (command === 'fill' && !(options.label && options.value !== undefined)) throw new Error('fill needs --label and --value');
      if (command === 'steps' && !options.file) throw new Error('steps needs --file STEPS.json');
      return drive(command, positional, options, log);
    default:
      log(USAGE);
      return command ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

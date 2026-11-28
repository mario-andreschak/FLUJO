#!/usr/bin/env node
// The scripted pilot (#577): several first-time users, each on a fresh FLUJO with an empty data
// folder, work through the tester guide's day-one tasks with a free local stand-in AI model. Every
// task has a fixed rule (expected result visible, within its time limit, no error message), each
// tester ends by creating the diagnostic report, and the run writes a short plain-language result.
// Exit code 0 means every task of every tester passed. How to run it: docs/pilots/product-fit/start-here.md.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, freePort, isAlive, loadChromium, parseArgs, probe, tail } from '../flujo-drive.mjs';
import { killTree } from '../release-sweep/run.mjs';
import { STUB_MODEL_ID, startStubModel } from '../first-journey/stub-model.mjs';
import { PRACTICE_FILE, PRACTICE_NOTE, PRACTICE_PHRASE, planPilotCompletion } from './pilot-model.mjs';
import { startPulseCollector } from './pulse-collector.mjs';
import { judgeTask, newErrors, plainResult } from './result.mjs';
import { FIRST_RUN_LIMIT_SECONDS, FIRST_RUN_TASKS, NAMES, TASKS } from './tasks.mjs';
import { pickTesters } from './testers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX_PREFIX = 'flujo-pilot-';
const MEMORY_CAP = '--max-old-space-size=4096';
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const USAGE = `Usage: npm run pilot:scripted -- [options]

Plays ${'several'} first-time users through the tester guide's day-one tasks, each on a fresh FLUJO
started from this checkout with an empty data folder and a local stand-in AI model (no account, no key).
Writes result.md (plain language), result.json, each tester's diagnostic report, and a screenshot and
page snapshot of every task. Never touches the everyday FLUJO on port 4200.

Options:
  --mode start|dev         start (default when "npm run build" has been run) uses the production build;
                           dev compiles pages on first use and is much slower.
  --only p01-desk,...      Only these testers.
  --out DIR                Result folder (default: ${path.join(EVIDENCE_DIR, 'scripted-pilot', '<time>')}).
  --startup-timeout SECONDS  Longest FLUJO may take to start (default 300).

Exit code 0: every task passed. 1: a task failed. 2: FLUJO could not be started.`;

/**
 * The error messages a person would see: red alerts and error banners, red field messages,
 * FLUJO's own dead-end screen, and plain lines of text that start like an error.
 */
function watchErrors() {
  const seen = new Set();
  let queued = false;
  const report = (element) => {
    if (!element.getClientRects().length) return;
    const text = (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text && !seen.has(text)) {
      seen.add(text);
      window.__pilotSawError?.(text);
    }
  };
  const scan = () => {
    queued = false;
    const boxes = '.MuiAlert-colorError, .MuiAlert-standardError, .MuiAlert-filledError, .MuiAlert-outlinedError, '
      + '.MuiFormHelperText-root.Mui-error, .app-loading[role="alert"]';
    for (const element of document.querySelectorAll(boxes)) report(element);
    for (const element of document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, li')) {
      if (element.childElementCount === 0 && /^(Error:|Error -|Failed to |Something went wrong)/.test((element.textContent || '').trim())) report(element);
    }
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    setTimeout(scan, 100);
  };
  new MutationObserver(queue).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(queue, 1_000);
}

function pickMode(mode) {
  if (mode === 'start' || mode === 'dev') return mode;
  if (mode !== undefined) throw new Error('--mode must be start or dev.');
  return existsSync(path.join(ROOT, '.next', 'BUILD_ID')) ? 'start' : 'dev';
}

export async function startFlujo({ mode, startupSeconds, log, pulseUrl }) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const dataDir = path.join(sandbox, 'data');
  const practiceFolder = path.join(sandbox, 'flujo-practice');
  mkdirSync(dataDir);
  mkdirSync(practiceFolder);
  writeFileSync(path.join(practiceFolder, PRACTICE_FILE), PRACTICE_NOTE);
  const port = await freePort();
  const logFile = path.join(sandbox, 'flujo.log');
  const nodeOptions = [process.env.NODE_OPTIONS, /max-old-space-size/.test(process.env.NODE_OPTIONS ?? '') ? '' : MEMORY_CAP].filter(Boolean).join(' ');
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['scripts/launch-next.mjs', mode, ...(mode === 'dev' ? ['--webpack'] : []), '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, FLUJO_DATA_DIR: dataDir, FLUJO_PORT: String(port), FLUJO_TELEMETRY_URL: pulseUrl, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: nodeOptions },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  const handle = { sandbox, dataDir, logFile, pid: child.pid, baseUrl: `http://127.0.0.1:${port}/`, practice: { folder: practiceFolder, file: path.join(practiceFolder, PRACTICE_FILE) } };
  log(`Starting FLUJO (${mode}) at ${handle.baseUrl}, everything in ${sandbox}.`);
  const deadline = Date.now() + startupSeconds * 1000;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) throw Object.assign(new Error(`FLUJO stopped while starting:\n${tail(logFile)}`), { handle });
    const { api, page } = await probe(handle.baseUrl);
    if (api && page) return handle;
    await delay(2_000);
  }
  throw Object.assign(new Error(`FLUJO did not answer within ${startupSeconds}s:\n${tail(logFile)}`), { handle });
}

export async function stopFlujo(handle, folder, log) {
  if (!handle) return;
  killTree(handle.pid);
  for (let waited = 0; waited < 15_000 && isAlive(handle.pid); waited += 500) await delay(500);
  if (folder && existsSync(handle.logFile)) writeFileSync(path.join(folder, 'flujo-log-tail.txt'), `${tail(handle.logFile, 300)}\n`);
  if (!path.basename(handle.sandbox).startsWith(SANDBOX_PREFIX) || path.dirname(handle.sandbox) !== path.resolve(os.tmpdir())) return;
  // Tool servers FLUJO started may hold files for a moment after the process tree is gone.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      rmSync(handle.sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch {
      await delay(5_000);
    }
  }
  log(`! ${handle.sandbox} was still locked after a minute; it stays in the temporary folder.`);
}

/** The first line of a failure plus what the browser was waiting for and why it could not act. */
export function describeFailure(error) {
  const lines = String(error?.message ?? error).split('\n').map((line) => line.trim()).filter(Boolean);
  const details = lines.slice(1).filter((line) => /waiting for|intercepts pointer|not visible|not enabled|not stable|detached|outside of the viewport|resolved to/.test(line));
  return [lines[0], ...new Set(details)].slice(0, 4).join(' ').replace(/\u001b\[[0-9;]*m/g, '');
}

async function evidence(page, folder, name) {
  await page.screenshot({ path: path.join(folder, `${name}.png`), fullPage: true }).catch(() => undefined);
  const snapshot = await page.locator('body').ariaSnapshot().catch(() => undefined);
  if (snapshot) writeFileSync(path.join(folder, `${name}.yml`), snapshot);
}

async function runTester(tester, { mode, out, startupSeconds, log }) {
  const folder = path.join(out, tester.id);
  mkdirSync(folder, { recursive: true });
  const record = { id: tester.id, name: tester.name, description: tester.description, viewport: tester.viewport, tasks: [], notes: {}, consoleErrors: [] };
  const model = await startStubModel({ plan: planPilotCompletion });
  const collector = await startPulseCollector();
  let handle;
  let browser;
  try {
    try {
      handle = await startFlujo({ mode, startupSeconds, log, pulseUrl: collector.url });
    } catch (error) {
      handle = error.handle;
      record.startFailure = error.message.split('\n')[0];
      record.stopped = 'FLUJO did not start';
      record.tasks.push({ id: 'start', title: 'Open a fresh FLUJO', passed: false, seconds: 0, limitSeconds: startupSeconds, reasons: [error.message.split('\n')[0]] });
      return record;
    }
    const privateValues = [
      handle.sandbox, handle.dataDir, handle.practice.folder, handle.practice.file, model.url, new URL(model.url).host,
      NAMES.ai, NAMES.agent, NAMES.app, PRACTICE_PHRASE, STUB_MODEL_ID, PRACTICE_FILE,
    ];
    browser = await loadChromium();
    const context = await browser.newContext({ viewport: tester.viewport, locale: 'en-US' });
    const errors = [];
    await context.exposeBinding('__pilotSawError', (_source, text) => { errors.push(String(text)); });
    await context.addInitScript(watchErrors);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`The page crashed: ${error.message.split('\n')[0]}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && record.consoleErrors.length < 50) record.consoleErrors.push(message.text().slice(0, 300));
    });
    let firstRun = 0;
    for (const task of TASKS) {
      const before = [...errors];
      const started = Date.now();
      let failure;
      try {
        await task.run({ page, baseUrl: handle.baseUrl, log, model, practice: handle.practice, notes: record.notes, privateValues, pulses: collector.pulses });
      } catch (error) {
        failure = `The expected result did not show: ${describeFailure(error)}`;
      }
      const seconds = (Date.now() - started) / 1000;
      const verdict = judgeTask({ limitSeconds: task.limitSeconds, seconds, errors: newErrors(before, errors), failure });
      record.tasks.push({ id: task.id, title: task.title, expected: task.expected, limitSeconds: task.limitSeconds, seconds, finished: !failure, ...verdict });
      await evidence(page, folder, `${task.id}${verdict.passed ? '' : '-failed'}`);
      log(`${verdict.passed ? '✓' : '✗'} ${tester.id} ${task.title} (${seconds.toFixed(1)}s)${verdict.passed ? '' : `: ${verdict.reasons.join(' ')}`}`);
      if (FIRST_RUN_TASKS.includes(task.id)) firstRun += seconds;
      if (task.id === FIRST_RUN_TASKS.at(-1) && record.tasks.filter((entry) => FIRST_RUN_TASKS.includes(entry.id)).every((entry) => entry.finished)) {
        record.firstRunSeconds = firstRun;
      }
      if (!verdict.passed && failure) {
        record.stopped = task.title;
        break;
      }
    }
    if (record.notes.diagnosticReport) writeFileSync(path.join(folder, 'diagnostic-report.txt'), record.notes.diagnosticReport);
    await context.close();
    return record;
  } finally {
    await browser?.close().catch(() => undefined);
    record.modelCalls = model.events.map(({ kind, offeredTools, calledTools, answered }) => ({ kind, offeredTools, calledTools, answered }));
    record.pulsesReceived = collector.pulses.length;
    await model.close();
    await collector.close();
    await stopFlujo(handle, folder, log);
  }
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { command, options } = parseArgs(['run', ...argv]);
  if (command !== 'run' || options.help) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  const mode = pickMode(options.mode);
  const testers = pickTesters(options.only);
  const startedAt = new Date().toISOString();
  const out = path.resolve(typeof options.out === 'string' ? options.out : path.join(EVIDENCE_DIR, 'scripted-pilot', startedAt.replace(/[:.]/g, '-')));
  const startupSeconds = Number(options['startup-timeout'] ?? 300);
  mkdirSync(out, { recursive: true });
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const records = [];
  for (const tester of testers) {
    log(`— ${tester.name}`);
    records.push(await runTester(tester, { mode, out, startupSeconds, log }));
  }
  const result = plainResult({ testers: records, version, mode, startedAt, firstRunLimitSeconds: FIRST_RUN_LIMIT_SECONDS });
  writeFileSync(path.join(out, 'result.md'), result.text);
  writeFileSync(path.join(out, 'result.json'), `${JSON.stringify({
    passed: result.passed, version, mode, startedAt, finishedAt: new Date().toISOString(), firstRunLimitSeconds: FIRST_RUN_LIMIT_SECONDS,
    testers: records.map(({ notes, ...rest }) => ({ ...rest, notes: { ...notes, diagnosticReport: undefined } })),
  }, null, 2)}\n`);
  log(`\n${result.text}\nResult folder: ${out}`);
  if (records.some((record) => record.startFailure)) return 2;
  return result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

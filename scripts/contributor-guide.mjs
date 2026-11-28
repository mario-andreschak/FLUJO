#!/usr/bin/env node
// Follows the contributor guide the way a newcomer on Linux or macOS would, in a fresh clone of
// this commit: every `sh` block in order, then every command in the "Run" column of its tables.
// The commands are read from the guide itself, so the guide and this check cannot drift apart
// (#1441). CI runs it in the contributor-guide job of verify-full.yml on Ubuntu and macOS.
//
//   node scripts/contributor-guide.mjs [--report DIR]
//
// It clones the current commit, so commit first. The report folder gets report.json, summary.md
// and one log per step; without --report it goes to a new folder in the system temp folder.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probe } from './flujo-drive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GUIDE = 'docs/contributing/README.md';

const SHELL_LANGUAGES = new Set(['sh', 'bash', 'shell']);
const COMMAND = /^(?:node|npm|npx|git)\s/;
const PLACEHOLDER = /<[A-Za-z][\w -]*>|YOUR-[A-Z]+/;
const STOP_HINT = /stop (?:it )?with Ctrl\+C/i;
const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?/;
const STEP_TIMEOUT_MS = 30 * 60_000;
const SERVER_READY_MS = 15 * 60_000;
const SERVER_STOP_MS = 30_000;

/**
 * Words in the guide that only the reader can fill in, and what the walkthrough uses instead.
 * Every entry must still appear in the guide, and nothing else may look like a placeholder.
 */
export const STAND_INS = Object.freeze([
  // Your fork: a link named FLUJO.git to the checkout under test, so the clone lands in FLUJO/ as it would from GitHub.
  { text: 'https://github.com/YOUR-NAME/FLUJO.git', use: ({ fork }) => fork, clones: true },
  { text: '<test files>', use: () => '__tests__/scripts/localTestDependencies.test.ts' },
  { text: '<files>', use: () => 'scripts/contributor-guide.mjs' },
]);

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function nextParagraph(lines, from) {
  let index = from;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const paragraph = [];
  while (index < lines.length && lines[index].trim()) paragraph.push(lines[index++]);
  return paragraph.join(' ');
}

function tableCommands(rows, section) {
  const cells = (row) => row.text.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const column = cells(rows[0]).findIndex((cell) => cell.toLowerCase() === 'run');
  if (column < 0) return [];
  return rows.slice(1).filter((row) => !/^\|[\s|:-]+\|$/.test(row.text.trim())).flatMap((row) =>
    [...(cells(row)[column] ?? '').matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim())
      .filter((command) => COMMAND.test(command))
      .map((command) => ({ section, line: row.line, kind: 'shell', script: command })));
}

/**
 * The steps a reader on Linux or macOS follows, in order: each shell block, and each command in a
 * table's "Run" column. A block followed by "stop with Ctrl+C" and a local address ends in a
 * server: that last line becomes a server step that must answer at the address the guide names.
 * Line numbers count from 1.
 */
export function parseGuide(markdown) {
  const lines = markdown.split(/\r?\n/);
  const steps = [];
  const skipped = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#{1,6}\s+(.+)$/.exec(lines[index]);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (lines[index].trim().startsWith('|')) {
      const rows = [];
      for (; index < lines.length && lines[index].trim().startsWith('|'); index += 1) rows.push({ text: lines[index], line: index + 1 });
      index -= 1;
      steps.push(...tableCommands(rows, section));
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(lines[index]);
    if (!fence) continue;
    const opening = index + 1;
    const body = [];
    for (index += 1; index < lines.length && !lines[index].trim().startsWith(fence[1]); index += 1) body.push(lines[index]);
    const language = fence[2].toLowerCase();
    if (!SHELL_LANGUAGES.has(language)) {
      if (language) skipped.push({ section, line: opening, language });
      continue;
    }
    const after = nextParagraph(lines, index + 1);
    const url = STOP_HINT.test(after) ? LOCAL_URL.exec(after)?.[0] : undefined;
    if (!url) {
      steps.push({ section, line: opening, kind: 'shell', script: body.join('\n') });
      continue;
    }
    const last = body.findLastIndex((text) => text.trim() && !text.trim().startsWith('#'));
    const before = body.slice(0, last);
    if (before.some((text) => text.trim())) steps.push({ section, line: opening, kind: 'shell', script: before.join('\n') });
    steps.push({ section, line: opening + 1 + last, kind: 'server', script: body[last].trim(), url: url.replace(/\/?$/, '/') });
  }
  return { steps, skipped };
}

/** The Node.js versions the guide asks for: the lowest version of each supported major line. */
export function guideNodeVersions(markdown) {
  const need = /\*\*Node\.js ([^*]+)\*\*/.exec(markdown)?.[1] ?? '';
  return [...need.matchAll(/(\d+)\.(\d+)\.(\d+) or newer (\d+)\.x/g)].map((match) => {
    if (match[1] !== match[4]) throw new Error(`The guide says "${match[0]}", which mixes two major versions.`);
    return `${match[1]}.${match[2]}.${match[3]}`;
  });
}

/** Fills in the reader's own words. Refuses a placeholder it cannot fill and a stand-in the guide no longer needs. */
export function planWalkthrough(steps, context, standIns = STAND_INS) {
  const used = new Set();
  const planned = steps.map((step) => {
    let script = step.script;
    let clones = false;
    for (const standIn of standIns) {
      if (!script.includes(standIn.text)) continue;
      script = script.replaceAll(standIn.text, quote(standIn.use(context)));
      clones ||= Boolean(standIn.clones);
      used.add(standIn.text);
    }
    const left = PLACEHOLDER.exec(script);
    if (left) {
      throw new Error(`${GUIDE} line ${step.line} ("${step.section}") has ${left[0]}, which the walkthrough cannot fill in. `
        + 'Add what a reader would type there to STAND_INS in scripts/contributor-guide.mjs.');
    }
    return { ...step, original: step.script, script, clones };
  });
  const unused = standIns.filter((standIn) => !used.has(standIn.text)).map((standIn) => standIn.text);
  if (unused.length) {
    throw new Error(`${GUIDE} no longer contains ${unused.join(', ')}; remove it from STAND_INS in scripts/contributor-guide.mjs.`);
  }
  return planned;
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const SHELL_STATE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/** Copies a child's output to its log (and the console). Background processes may keep the pipes open, so it never waits long after exit. */
function record(child, logFile, echo) {
  const log = createWriteStream(logFile, { flags: 'a' });
  const ends = [child.stdout, child.stderr].map((stream) => new Promise((resolve) => {
    stream.on('data', (chunk) => {
      log.write(chunk);
      echo?.write(chunk);
    });
    stream.once('close', resolve);
  }));
  return async () => {
    await Promise.race([Promise.all(ends), delay(2_000)]);
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((resolve) => { log.end(resolve); });
  };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function waitForExit(child, ms) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Runs one shell step like a terminal would: in the folder and with the exported variables the
 * steps before it left behind, which it then hands on to the next step through `stateFile`.
 */
export async function runShellStep(step, state, { logFile, stateFile, echo, timeoutMs = STEP_TIMEOUT_MS }) {
  const capture = `${quote(process.execPath)} -e 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }))' > ${quote(stateFile)}`;
  rmSync(stateFile, { force: true });
  const child = spawn('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${step.script}\n${capture}\n`], {
    cwd: state.cwd, env: state.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finish = record(child, logFile, echo);
  const finished = await waitForExit(child, timeoutMs);
  if (!finished) killGroup(child.pid, 'SIGKILL');
  await finish();
  if (!finished) throw new Error(`was still running after ${timeoutMs / 60_000} minutes`);
  if (child.exitCode !== 0) throw new Error(`failed (exit ${child.exitCode ?? child.signalCode})`);
  const next = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const name of SHELL_STATE) delete next.env[name];
  return { cwd: next.cwd, env: next.env };
}

/**
 * Starts the server the guide tells the reader to start, waits until it answers at the address
 * the guide gives, then presses Ctrl+C (SIGINT to its process group) and checks that it stopped.
 */
export async function runServerStep(step, state, { logFile, echo, readyMs = SERVER_READY_MS, stopMs = SERVER_STOP_MS, check = probe }) {
  const child = spawn('bash', ['--noprofile', '--norc', '-c', `exec ${step.script}`], {
    cwd: state.cwd, env: state.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finish = record(child, logFile, echo);
  try {
    const ready = Date.now() + readyMs;
    for (;;) {
      if (exited(child)) throw new Error(`stopped before it answered at ${step.url} (exit ${child.exitCode ?? child.signalCode})`);
      const { api, page } = await check(step.url);
      if (api && page) break;
      if (Date.now() > ready) throw new Error(`did not answer at ${step.url} within ${readyMs / 60_000} minutes`);
      await delay(2_000);
    }
    echo?.write(`\n${step.url} answers. Pressing Ctrl+C.\n`);
    killGroup(child.pid, 'SIGINT');
    if (!(await waitForExit(child, stopMs))) throw new Error(`was still running ${stopMs / 1000} seconds after Ctrl+C`);
    const gone = Date.now() + stopMs;
    while ((await check(step.url, 2_000)).api) {
      if (Date.now() > gone) throw new Error(`still answered at ${step.url} ${stopMs / 1000} seconds after Ctrl+C`);
      await delay(1_000);
    }
  } finally {
    killGroup(child.pid, 'SIGKILL');
    await finish();
  }
  return state;
}

function versionOf(command, env) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', env });
  return result.status === 0 ? result.stdout.trim() : `unavailable (${result.error?.code ?? result.status})`;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function insideTemp(target) {
  const relative = path.relative(realpathSync(os.tmpdir()), realpathSync(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function summaryMarkdown(report) {
  const cell = (text) => text.replaceAll('\n', '; ').replaceAll('|', '\\|');
  return [
    `## Contributor guide on ${report.system.platform} ${report.system.release} (${report.system.arch})`,
    '',
    report.result === 'passed' ? 'Every step of the guide worked.' : `Stopped: ${report.error}`,
    '',
    `Commit ${report.commit}. Node.js ${report.versions.node}, npm ${report.versions.npm}, ${report.versions.git}.`
      + (report.cloneMegabytes ? ` The clone with its installed packages took ${report.cloneMegabytes} MB.` : ''),
    '',
    '| Section | Command | Time | Result |',
    '| --- | --- | --- | --- |',
    ...report.steps.map((step) => `| ${cell(step.section)} | \`${cell(step.command)}\` | ${Math.round(step.seconds)} s | ${step.result} |`),
    '',
  ].join('\n');
}

/** Follows the guide in a fresh clone of `source` and writes the report. Resolves to the report; never leaves a server running. */
export async function walk({ source = ROOT, reportDir, echo = process.stdout } = {}) {
  if (process.platform === 'win32') {
    throw new Error('This walkthrough follows the Linux and macOS steps of the guide. Run it on Linux or macOS, or in WSL.');
  }
  const { steps, skipped } = parseGuide(readFileSync(path.join(source, GUIDE), 'utf8'));
  const commit = git(['rev-parse', 'HEAD'], source);
  if (git(['status', '--porcelain'], source)) echo?.write('Note: uncommitted changes are not part of the walkthrough; it clones the last commit.\n');
  const reports = path.resolve(reportDir ?? mkdtempSync(path.join(os.tmpdir(), 'flujo-guide-report-')));
  mkdirSync(reports, { recursive: true });
  const workdir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flujo-guide-')));
  const stateFile = path.join(workdir, '.walkthrough-state.json');
  const fork = path.join(workdir, 'fork', 'FLUJO.git');
  let state = { cwd: workdir, env: { ...process.env } };
  const report = {
    guide: GUIDE, commit, startedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), arch: process.arch },
    versions: { node: versionOf('node', state.env), npm: versionOf('npm', state.env), git: versionOf('git', state.env) },
    skipped, steps: [], result: 'passed',
  };
  let clone;
  try {
    mkdirSync(path.dirname(fork));
    symlinkSync(source, fork, 'dir');
    const plan = planWalkthrough(steps, { fork });
    for (const [index, step] of plan.entries()) {
      const firstLine = step.original.split('\n').find((text) => text.trim()) ?? step.original;
      const logFile = path.join(reports, `${String(index + 1).padStart(2, '0')}-${slug(firstLine)}.log`);
      echo?.write(`\n== ${step.section} (${GUIDE}:${step.line}) ==\n${step.original}\n`);
      const entry = { section: step.section, line: step.line, kind: step.kind, command: step.original, seconds: 0, result: 'passed', log: path.basename(logFile) };
      report.steps.push(entry);
      const started = Date.now();
      try {
        state = step.kind === 'server'
          ? await runServerStep(step, state, { logFile, echo })
          : await runShellStep(step, state, { logFile, stateFile, echo });
        if (step.clones) {
          clone = state.cwd;
          const cloned = git(['rev-parse', 'HEAD'], clone);
          if (cloned !== commit) throw new Error(`left the reader in ${clone} at ${cloned}, not in a clone of the commit under test ${commit}`);
        }
      } catch (error) {
        entry.result = 'failed';
        throw new Error(`"${firstLine}" in "${step.section}" (${GUIDE}:${step.line}) ${error.message}`);
      } finally {
        entry.seconds = (Date.now() - started) / 1000;
      }
    }
    const size = clone ? spawnSync('du', ['-sk', clone], { encoding: 'utf8' }) : undefined;
    if (size?.status === 0) report.cloneMegabytes = Math.round(Number.parseInt(size.stdout, 10) / 1024);
    const changed = clone ? git(['status', '--porcelain'], clone) : '';
    if (changed) throw new Error(`Following the guide changed files the reader never touched, which would end up in their first pull request:\n${changed}`);
  } catch (error) {
    report.result = 'failed';
    report.error = error.message;
  } finally {
    if (clone && existsSync(path.join(clone, 'scripts/flujo-drive.mjs'))) {
      spawnSync(process.execPath, ['scripts/flujo-drive.mjs', 'stop'], { cwd: clone, env: state.env, stdio: 'ignore' });
    }
    const data = state.env.FLUJO_DATA_DIR;
    if (data && data !== process.env.FLUJO_DATA_DIR && existsSync(data) && insideTemp(data)) {
      rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
    rmSync(fork, { force: true });
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    report.finishedAt = new Date().toISOString();
    writeFileSync(path.join(reports, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const summary = summaryMarkdown(report);
    writeFileSync(path.join(reports, 'summary.md'), summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    echo?.write(`\n${summary}\nReport and logs: ${reports}\n`);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--report');
  walk({ reportDir: at > 0 ? process.argv[at + 1] : undefined })
    .then((report) => { process.exitCode = report.result === 'passed' ? 0 : 1; })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

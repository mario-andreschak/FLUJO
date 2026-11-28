#!/usr/bin/env node
// Codex checks against FLUJO as it is shipped: the Codex program an installed
// FLUJO (Windows installer, npm package or this checkout) runs. It talks to the
// local model stand-in only, so it needs no login, account or real model.
//
// Checks: the program sits where FLUJO looks for it and is the version FLUJO
// pins; one conversation turn completes; a restarted Codex finds that turn by
// FLUJO's client id; a cancelled turn ends as interrupted; and once Codex is
// stopped, none of the processes it started is left running.
//
// Usage: node scripts/packaged-codex-acceptance.mjs --app-root DIR [--report FILE]
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  bundledCodex, descendantProcessIds, HANG_PROMPT, listProcesses, prepareStandInHome, STAND_IN_MODEL, startAppServer, startStandInModel,
} from './codex-stand-in.mjs';

export const USAGE = 'Usage: node scripts/packaged-codex-acceptance.mjs --app-root DIR [--report FILE]\nPaths must be absolute.';

export function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { 'app-root': { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean' } } }));
  } catch (error) { throw new Error(`${error.message}\n\n${USAGE}`); }
  if (values.help) return { help: true };
  for (const name of ['app-root', 'report']) {
    if (values[name] !== undefined && !path.isAbsolute(values[name])) throw new Error(`--${name} needs an absolute path.\n\n${USAGE}`);
  }
  if (!values['app-root']) throw new Error(`--app-root DIR is required.\n\n${USAGE}`);
  return { appRoot: values['app-root'], report: values.report };
}

const versionOutput = executable => new Promise((resolve, reject) => {
  execFile(executable, ['--version'], { windowsHide: true, timeout: 30000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
});

/** Runs every check; returns the report. Never leaves a process behind. */
export async function runCodexAcceptance({ appRoot, log = () => {} }) {
  const report = { schemaVersion: 1, kind: 'flujo-packaged-codex-acceptance', platform: process.platform, arch: process.arch,
    node: process.version, startedAt: new Date().toISOString(), codex: null, checks: [], result: 'failed' };
  let model, place;
  const before = await descendantProcessIds();
  const check = async (title, run) => {
    const started = Date.now();
    try {
      await run();
      report.checks.push({ title, result: 'passed', seconds: Math.round((Date.now() - started) / 100) / 10 });
    } catch (error) {
      report.checks.push({ title, result: 'failed', seconds: Math.round((Date.now() - started) / 100) / 10, error: error.message });
      throw error;
    } finally { log(report.checks.at(-1)); }
  };
  try {
    const declared = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')).dependencies?.['@openai/codex-sdk'];
    const codex = bundledCodex(appRoot);
    report.codex = { cliVersion: codex.cliVersion, sdkVersion: codex.sdkVersion, declared, executable: path.relative(appRoot, codex.executable) };
    await check('The installed Codex is where FLUJO looks and is the version FLUJO pins', async () => {
      await fs.access(codex.executable);
      if (codex.sdkVersion !== declared || codex.cliVersion !== declared) {
        throw new Error(`FLUJO pins Codex ${declared}, but the installed SDK is ${codex.sdkVersion} and the CLI is ${codex.cliVersion}.`);
      }
      const output = await versionOutput(codex.executable);
      if (!output.includes(codex.cliVersion)) throw new Error(`The installed Codex reports "${output}", not ${codex.cliVersion}.`);
    });
    model = await startStandInModel();
    place = await prepareStandInHome(model.port);
    const params = { model: STAND_IN_MODEL, cwd: place.workspace, approvalPolicy: 'never', sandbox: 'read-only',
      config: { web_search: 'disabled', features: { shell_tool: false } }, developerInstructions: 'FLUJO packaged Codex check.', serviceTier: 'default' };
    const initialize = async server => {
      const result = await server.request('initialize', { clientInfo: { name: 'flujo_conversation', title: 'FLUJO', version: '1' } });
      server.notify('initialized');
      return result;
    };
    const turnDone = threadId => message => message.method === 'turn/completed' && message.params?.threadId === threadId;
    let threadId, clientUserMessageId;
    await check('One conversation turn completes with the installed Codex', async () => {
      const server = startAppServer({ executable: codex.executable, env: place.env, cwd: place.workspace });
      try {
        const agent = (await initialize(server)).userAgent;
        if (!String(agent).includes(`/${codex.cliVersion} `)) throw new Error(`Codex named itself "${agent}".`);
        threadId = (await server.request('thread/start', { ...params, ephemeral: false })).thread.id;
        clientUserMessageId = 'flujo-packaged-check-1';
        const done = server.waitFor(turnDone(threadId), 'the first turn');
        await server.request('turn/start', { threadId, input: [{ type: 'text', text: 'Say the fixture reply.' }], clientUserMessageId });
        const turn = (await done).params.turn;
        const text = turn.items.find(item => item.type === 'agentMessage')?.text;
        if (turn.status !== 'completed' || !/^Fixture reply \d+\.$/.test(text ?? '')) throw new Error(`The turn ended ${turn.status} with "${text}".`);
      } finally { await server.stop(); }
    });
    await check('A restarted Codex finds that turn by FLUJO\'s client id', async () => {
      const server = startAppServer({ executable: codex.executable, env: place.env, cwd: place.workspace });
      try {
        await initialize(server);
        await server.request('thread/resume', { ...params, threadId, excludeTurns: true });
        const turns = (await server.request('thread/turns/list', { threadId, limit: 4, sortDirection: 'desc', itemsView: 'full' })).data;
        if (!turns.some(turn => turn.status === 'completed' && turn.items.some(item => item.clientId === clientUserMessageId))) {
          throw new Error('The resumed conversation has no completed turn with FLUJO\'s client id.');
        }
      } finally { await server.stop(); }
    });
    await check('A cancelled turn ends as interrupted and no Codex process is left', async () => {
      const server = startAppServer({ executable: codex.executable, env: place.env, cwd: place.workspace });
      let started = [];
      try {
        await initialize(server);
        await server.request('thread/resume', { ...params, threadId, excludeTurns: true });
        const answering = model.nextRequest(body => JSON.stringify(body.input ?? []).includes(HANG_PROMPT));
        const done = server.waitFor(turnDone(threadId), 'the cancelled turn');
        const turnId = (await server.request('turn/start', { threadId, input: [{ type: 'text', text: HANG_PROMPT }], clientUserMessageId: 'flujo-packaged-check-2' })).turn.id;
        await answering;
        started = [...await descendantProcessIds()].filter(pid => !before.has(pid));
        await server.request('turn/interrupt', { threadId, turnId });
        const status = (await done).params.turn.status;
        if (status !== 'interrupted') throw new Error(`The cancelled turn ended ${status}.`);
      } finally { await server.stop(); }
      const deadline = Date.now() + 15000;
      let alive = started;
      while (alive.length && Date.now() < deadline) {
        const table = await listProcesses();
        alive = started.filter(pid => table.has(pid));
        if (alive.length) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (alive.length) throw new Error(`Processes Codex started are still running: ${alive.join(', ')}.`);
    });
    report.result = 'passed';
  } catch (error) {
    report.failure ??= error.message;
  } finally {
    await model?.close();
    await place?.remove();
    report.completedAt = new Date().toISOString();
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log(USAGE); return 0; }
  console.log(`Packaged Codex checks: ${options.appRoot}`);
  const report = await runCodexAcceptance({ appRoot: options.appRoot,
    log: entry => console.log(`${entry.result === 'passed' ? 'PASS' : 'FAIL'}  ${entry.title} (${entry.seconds} s)${entry.error ? `\n      ${entry.error}` : ''}`) });
  if (options.report) {
    await fs.mkdir(path.dirname(options.report), { recursive: true });
    await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.result !== 'passed') { console.error(`\nPackaged Codex checks failed: ${report.failure}`); return 1; }
  console.log(`\nAll ${report.checks.length} Codex checks passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
export const SCRIPT = fileURLToPath(import.meta.url);

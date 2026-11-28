#!/usr/bin/env node
// The first-use journey as one repeatable check: connect and test an AI, inspect and test an
// app's tool, build an agent in the simple builder, run it with a tool approval, look at the
// executed steps, then reuse the agent over the OpenAI-compatible API and the app over the MCP proxy.
// It drives a throwaway FLUJO like a user and answers with a free local stub model, so it needs no
// account or key. How to run it: docs/feature-map/README.md.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_DIR, gotoWithRetry, isAlive, loadChromium, parseArgs, parseViewport, readState, routeUrl, save, settle,
} from '../flujo-drive.mjs';
import { startProductionFlujo } from './production.mjs';
import { STUB_FINAL_PREFIX, STUB_MODEL_ID, startStubModel } from './stub-model.mjs';

export const NAMES = Object.freeze({
  ai: 'Local stub AI',
  agent: 'Folder helper',
  app: 'filesystem',
  tool: 'get_allowed_directories',
  goal: 'Tell me which folders you can read.',
  question: 'Which folders can you read? Please use get_allowed_directories.',
});
const WAIT = 120_000;
/** The issue's target for a newcomer: the whole first-use path in under 15 minutes. */
export const TARGET_SECONDS = 15 * 60;

export const USAGE = `Usage: node scripts/first-journey/run.mjs [--viewport WxH] [--base-url URL] [--out FOLDER]

Walks the first-use journey with a local stub model it starts itself, on a throwaway FLUJO with a
fresh data folder (never port 4200):
  - the instance "npm run drive -- launch" started from this checkout, while it runs;
  - otherwise one it starts itself from the production build ("npm run build" first), with the
    memory capped at 4 GB, and stops and deletes again at the end.
Screenshots and accessibility snapshots of every stage, plus report.json, are saved under
${path.join(EVIDENCE_DIR, 'first-journey')}. Exit code 0 means every stage passed without errors on
the page and, on the production build, within ${TARGET_SECONDS / 60} minutes.`;

const visible = (locator) => locator.filter({ visible: true }).first();
const button = (page, name, exact = false) => visible(page.getByRole('button', { name, exact }));
const link = (page, name) => visible(page.getByRole('link', { name }));

async function seeText(page, text, timeout = WAIT) {
  await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout });
}

async function openNavigationTo(page, url, log) {
  await gotoWithRetry(page, url, log);
  await settle(page, log);
}

async function json(response) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** Each stage acts like a user and checks what a user would see. */
export const STAGES = [
  {
    id: 'home',
    title: 'Home points a new user at Connect AI',
    async run({ page, baseUrl, log, notes }) {
      await openNavigationTo(page, baseUrl, log);
      await link(page, 'Connect AI').waitFor({ timeout: WAIT });
      notes.setupCards = (await page.getByRole('region', { name: 'Getting started' }).innerText()).replace(/\s+/g, ' ');
      notes.tourShown = await page.getByText('Start with your AI setup').isVisible();
    },
  },
  {
    id: 'connect-ai',
    title: 'Connect a local AI by hand (Ollama-style, no key)',
    async run({ page, log, stub }) {
      // The guided tour may open on Home; following its highlighted button must not bounce back.
      await link(page, 'Connect AI').click();
      await seeText(page, 'Let’s connect your AI!');
      await button(page, 'I’m an expert').click();
      await seeText(page, 'Connect your AI');
      await visible(page.getByLabel('Display name')).fill(NAMES.ai);
      await visible(page.getByRole('combobox', { name: 'Provider' })).click();
      await visible(page.getByRole('option', { name: 'Ollama', exact: true })).click();
      await visible(page.getByLabel('Base URL')).fill(stub.url);
      await visible(page.getByLabel('Technical name')).fill(STUB_MODEL_ID);
      await button(page, /^Save$/).click();
      await seeText(page, NAMES.ai);
      await settle(page, log);
    },
  },
  {
    id: 'test-ai',
    title: 'Test the AI, including a real tool round-trip',
    async run({ page }) {
      await button(page, 'Test model').click();
      await seeText(page, 'The FLUJO tool round-trip also passed.');
      await page.keyboard.press('Escape');
    },
  },
  {
    id: 'app-tool',
    title: 'Inspect a connected app and test one tool',
    async run({ page, baseUrl, log }) {
      await openNavigationTo(page, routeUrl(baseUrl, 'mcp'), log);
      // The built-in apps connect on their own, so the first-run guide is already gone (#1278).
      // Open the app from its card with the keyboard, the way a keyboard or screen-reader user must.
      await button(page, `Open ${NAMES.app}`, true).focus();
      await page.keyboard.press('Enter');
      await visible(page.getByRole('combobox', { name: /^Select tool/ })).click();
      await visible(page.getByRole('option', { name: NAMES.tool, exact: true })).click();
      await button(page, 'Test tool', true).click();
      await seeText(page, '"directories"');
      await page.keyboard.press('Escape');
    },
  },
  {
    id: 'build-agent',
    title: 'Build an agent in the simple builder and try it',
    async run({ page, baseUrl, log, notes }) {
      await openNavigationTo(page, baseUrl, log);
      // With the bundled FLUJO agent, Home may offer "Create another" instead of "Open simple builder".
      const create = link(page, /^(Open simple builder|Create another)$/);
      notes.createAgentLabel = (await create.innerText()).trim();
      await create.click();
      await seeText(page, 'Build it like a simple recipe.');
      await button(page, 'No, I’ll build it myself').click();
      await visible(page.getByLabel('Workflow goal')).fill(NAMES.goal);
      await button(page, 'Create goal step').click();
      await button(page, 'Add an app').click();
      // Each choice reads as the app's name followed by what it brings ("All tools included").
      await visible(page.getByRole('dialog', { name: 'Choose an app' }).getByRole('button', { name: new RegExp(`^${NAMES.app}\\b`) })).click();
      await visible(page.getByLabel('Agent name')).fill(NAMES.agent);
      await button(page, 'Try my agent').click();
      await page.waitForURL(/\/chat/, { timeout: WAIT });
      await settle(page, log);
    },
  },
  {
    id: 'run-with-approval',
    title: 'Run the agent, approve its tool call, read the answer',
    async run({ page, log }) {
      const approvals = page.getByRole('checkbox', { name: 'Require tool approvals' });
      if (!(await visible(approvals).isVisible().catch(() => false))) await button(page, 'Run options', true).click();
      await visible(approvals).check();
      await page.keyboard.press('Escape');
      await visible(page.getByRole('textbox', { name: 'Message' })).fill(NAMES.question);
      await button(page, 'Send message', true).click();
      await seeText(page, 'Tool approval required');
      await button(page, 'Approve', true).click();
      await seeText(page, STUB_FINAL_PREFIX);
      await settle(page, log);
    },
  },
  {
    id: 'inspect-steps',
    title: 'Inspect the executed steps of the run',
    async run({ page }) {
      await button(page, 'Toggle executed steps panel', true).click();
      await seeText(page, 'Executed steps');
    },
  },
  {
    id: 'reuse-api',
    title: 'Reuse the agent through the OpenAI-compatible API',
    async run({ baseUrl, notes }) {
      const models = await json(await fetch(routeUrl(baseUrl, 'v1/models')));
      const model = `flow-${NAMES.agent}`;
      if (!models.data?.some((entry) => entry.id === model)) throw new Error(`/v1/models does not list "${model}".`);
      const completion = await json(await fetch(routeUrl(baseUrl, 'v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: NAMES.question }] }),
        signal: AbortSignal.timeout(WAIT),
      }));
      const answer = completion.choices?.[0]?.message?.content ?? '';
      if (!answer.includes(STUB_FINAL_PREFIX)) throw new Error(`The API answer did not include the tool result: ${answer.slice(0, 200)}`);
      notes.apiAnswer = answer.slice(0, 200);
    },
  },
  {
    id: 'reuse-mcp',
    title: 'Expose the app and use it from an outside MCP client',
    async run({ page, baseUrl, log, notes }) {
      await openNavigationTo(page, routeUrl(baseUrl, 'mcp'), log);
      const card = page.locator(`[data-tutorial-server-name="${NAMES.app}"]`).first();
      await visible(card.getByLabel('Expose to external apps')).check();
      const address = (await visible(card.getByText(/\/mcp-proxy\//)).innerText({ timeout: WAIT })).trim();
      notes.proxyUrl = address;
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'flujo-first-journey', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(address)), { timeout: 60_000 });
      try {
        const { tools } = await client.listTools();
        if (!tools.some((tool) => tool.name === NAMES.tool)) throw new Error(`The proxy does not offer ${NAMES.tool}.`);
        const result = await client.callTool({ name: NAMES.tool, arguments: {} });
        if (!JSON.stringify(result.content).includes('directories')) throw new Error('The proxied tool call returned no directories.');
      } finally {
        await client.close();
      }
    },
  },
];

/**
 * What makes a run fail besides a stage: a crash on the page, or a path slower than the target.
 * The time only counts on the production build: a dev server spends minutes compiling pages.
 */
export function verdict(report) {
  const seconds = report.stages.reduce((sum, stage) => sum + stage.seconds, 0);
  const pageErrors = report.problems.filter((problem) => problem.startsWith('page error:'));
  const reasons = [];
  if (report.stages.some((stage) => !stage.ok) || report.stages.length !== STAGES.length) reasons.push('a stage did not pass');
  if (pageErrors.length) reasons.push(`${pageErrors.length} error(s) crashed code on the page`);
  if (report.server === 'production build' && seconds > TARGET_SECONDS) reasons.push(`the path took ${(seconds / 60).toFixed(1)} minutes; the target is under ${TARGET_SECONDS / 60}`);
  return { passed: reasons.length === 0, seconds, reasons };
}

export async function runJourney({ baseUrl, viewport, out, log = console.log, server }) {
  const stub = await startStubModel();
  const evidence = path.join('first-journey', out);
  const report = {
    startedAt: new Date().toISOString(), baseUrl, server: server ?? 'given', viewport, stubModel: stub.url, stages: [], notes: {}, problems: [],
  };
  const browser = await loadChromium();
  let result = { passed: false, seconds: 0, reasons: [] };
  try {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') report.problems.push(`console error: ${message.text().slice(0, 300)}`);
    });
    for (const stage of STAGES) {
      const started = Date.now();
      try {
        await stage.run({ page, baseUrl, log, stub, notes: report.notes });
        await save(page, 'shot', path.join(evidence, `${stage.id}.png`), log);
        await save(page, 'aria', path.join(evidence, `${stage.id}.yml`), log);
        report.stages.push({ id: stage.id, ok: true, seconds: (Date.now() - started) / 1000 });
        log(`✓ ${stage.title} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } catch (error) {
        report.stages.push({ id: stage.id, ok: false, seconds: (Date.now() - started) / 1000, error: error.message.split('\n')[0] });
        log(`✗ ${stage.title}: ${error.message.split('\n')[0]}`);
        await save(page, 'shot', path.join(evidence, `${stage.id}-failed.png`), log).catch(() => undefined);
        await save(page, 'aria', path.join(evidence, `${stage.id}-failed.yml`), log).catch(() => undefined);
        break;
      }
    }
  } finally {
    await browser.close();
    report.stubCalls = stub.events.map(({ kind, offeredTools, calledTools, answered }) => ({ kind, offeredTools, calledTools, answered }));
    await stub.close();
    result = verdict(report);
    const target = path.join(EVIDENCE_DIR, evidence, 'report.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({
      ...report, finishedAt: new Date().toISOString(), seconds: result.seconds, targetSeconds: TARGET_SECONDS,
      passed: result.passed, failedBecause: result.reasons,
    }, null, 2)}\n`);
    log(`Report: ${target}`);
  }
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  log(result.passed
    ? `First-use journey passed in ${(result.seconds / 60).toFixed(1)} minutes.`
    : `First-use journey failed: ${result.reasons.join('; ')}.`);
  return result.passed ? 0 : 1;
}

/** The instance "npm run drive -- launch" started from this checkout, if it still runs. */
function drivenInstance() {
  const state = readState();
  return state?.baseUrl && Number.isInteger(state.pid) && isAlive(state.pid) ? state.baseUrl : undefined;
}

export async function main(argv = process.argv.slice(2), log = console.log, { start = startProductionFlujo } = {}) {
  const { command, options } = parseArgs(['run', ...argv]);
  if (command !== 'run' || options.help) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  const given = options['base-url'] || drivenInstance();
  if (given && new URL(given).port === '4200') throw new Error('Refusing to drive port 4200: it is the everyday FLUJO with real data.');
  const viewport = parseViewport(options.viewport);
  const out = typeof options.out === 'string' ? options.out : `${viewport.width}x${viewport.height}`;
  if (!/^[\w-][\w.-]*$/.test(out) || out.includes('..')) throw new Error(`--out must be a plain folder name such as "phone", got "${out}".`);
  // Screenshots of an earlier run's failed stage must not sit next to this run's results.
  rmSync(path.join(EVIDENCE_DIR, 'first-journey', out), { recursive: true, force: true });
  if (given) return runJourney({ baseUrl: given, viewport, out, log, server: 'given' });
  const instance = await start({ logFile: path.join(EVIDENCE_DIR, 'first-journey', out, 'flujo.log'), log });
  try {
    return await runJourney({ baseUrl: instance.baseUrl, viewport, out, log, server: 'production build' });
  } finally {
    await instance.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

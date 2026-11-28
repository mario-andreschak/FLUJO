#!/usr/bin/env node
// Chat goals (#1225) as one repeatable browser check: with the free local stub model and an agent,
// type "/goal …" in the agent's chat and watch FLUJO keep the agent working, round after round,
// until the agent says the goal is met; then the other slash commands. It drives a throwaway
// FLUJO (`npm run drive -- launch`) like a user. How to run it: docs/feature-map/talk.md ("Chat goals").
// The AI and the agent are set up through the API: the first-use journey checks those pages, and
// this check then needs only the chat page compiled.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_DIR, gotoWithRetry, loadChromium, parseArgs, parseViewport, readState, routeUrl, save, settle,
} from '../flujo-drive.mjs';
import {
  STUB_FINAL_PREFIX, STUB_GOAL_DONE, STUB_GOAL_ROUNDS, STUB_MODEL_ID, startStubModel, stubGoalReply,
} from './stub-model.mjs';

export const GOAL = 'Tell me which folders you can read, and check them once more.';
export const AGENT = 'Goal helper';
const WAIT = 180_000;

export const USAGE = `Usage: node scripts/first-journey/goal-check.mjs [--viewport WxH] [--base-url URL] [--out FOLDER]

Sets a goal in an agent chat on a throwaway FLUJO started with "npm run drive -- launch" (fresh data
folder, never port 4200) and a local stub model it starts itself, then checks that FLUJO keeps the
agent working until the goal is met, and that the other slash commands answer. Screenshots and
accessibility snapshots of every stage, plus report.json, are saved under
${path.join(EVIDENCE_DIR, 'goal-check')}. Exit code 0 means every stage passed.`;

const visible = (locator) => locator.filter({ visible: true }).first();

async function seeText(page, text, timeout = WAIT) {
  await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout });
}

/** Type in the message box and press Enter, as a person does. */
async function command(page, text) {
  const box = visible(page.getByRole('textbox', { name: 'Message' }));
  await box.fill(text);
  await page.keyboard.press('Enter');
}

/** POST with a few tries: a dev server compiling a route, or restarting to free memory, drops the first request. */
async function postJson(baseUrl, route, body, log, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(routeUrl(baseUrl, route), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WAIT),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`POST ${route}: ${response.status} ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } catch (error) {
      if (attempt >= attempts || /: 4\d\d /.test(String(error?.message))) throw error;
      log(`! POST ${route} failed (${error.message}); trying again.`);
    }
  }
}

const goalBar = (page) => visible(page.getByRole('region', { name: 'Chat goal' }));

/** Each stage after the set-up acts like a user and checks what a user sees. */
export const STAGES = [
  {
    id: 'setup',
    title: 'Connect the stub AI, create an agent with the "filesystem" app, and open its chat',
    async run({ page, baseUrl, log, stub, notes }) {
      const run = randomUUID().slice(0, 8);
      const model = await postJson(baseUrl, 'api/model', {
        // Like the AI Setup page, a keyless provider is saved with the placeholder key "ollama".
        name: STUB_MODEL_ID, displayName: `Local stub AI ${run}`, provider: 'ollama', baseUrl: stub.url, ApiKey: 'ollama',
      }, log);
      const agent = await postJson(baseUrl, 'api/flow/model-agent', {
        creationId: randomUUID(), modelId: model.id, name: `${AGENT} ${run}`, servers: [{ name: 'filesystem' }],
      }, log);
      notes.flowId = agent.flowId;
      await gotoWithRetry(page, routeUrl(baseUrl, `chat?flow=${encodeURIComponent(agent.flowId)}`), log);
      await settle(page, log);
      await visible(page.getByRole('textbox', { name: 'Message' })).waitFor({ timeout: WAIT });
      // The saved agent's name (FLUJO may have tidied it) shows on the chat's agent chip.
      await seeText(page, agent.name);
    },
  },
  {
    id: 'set-goal',
    title: 'Type /goal in the agent chat',
    async run({ page, log }) {
      await command(page, `/goal ${GOAL}`);
      await seeText(page, 'Goal set:');
      await seeText(page, 'The agent starts now and keeps going until it says the goal is met.');
      await goalBar(page).waitFor({ timeout: WAIT });
      await settle(page, log);
    },
  },
  {
    id: 'goal-rounds',
    title: `FLUJO keeps the agent working for ${STUB_GOAL_ROUNDS} rounds until it says the goal is met`,
    async run({ page, log, notes }) {
      await goalBar(page).getByText('Reached').waitFor({ timeout: WAIT });
      notes.goalBar = (await goalBar(page).innerText()).replace(/\s+/g, ' ').trim();
      // The finished goal turns show in the chat, labelled as FLUJO's goal turns, not as the person.
      await seeText(page, `Goal, round ${STUB_GOAL_ROUNDS}`);
      await seeText(page, stubGoalReply(1));
      await seeText(page, stubGoalReply(STUB_GOAL_ROUNDS));
      notes.finalReply = `${stubGoalReply(STUB_GOAL_ROUNDS)} ${STUB_GOAL_DONE}`;
      await settle(page, log);
    },
  },
  {
    id: 'goal-status',
    title: 'Type /goal to see that the goal is reached',
    async run({ page }) {
      await command(page, '/goal');
      await seeText(page, 'Goal of this chat');
      await seeText(page, 'Type /goal and a new goal to start another.');
    },
  },
  {
    id: 'slash-commands',
    title: 'The other slash commands answer, and an unknown /word is sent as a message',
    async run({ page, log, notes }) {
      const box = visible(page.getByRole('textbox', { name: 'Message' }));
      await box.fill('/');
      const list = visible(page.getByRole('listbox', { name: 'Commands' }));
      await list.waitFor({ timeout: WAIT });
      notes.commands = (await list.getByRole('option').allInnerTexts()).map((option) => option.split(/\s/)[0]);
      for (const name of ['/goal', '/compact', '/new', '/fork', '/context', '/status', '/help']) {
        if (!notes.commands.includes(name)) throw new Error(`The command list does not offer ${name}: ${notes.commands.join(', ')}`);
      }
      await command(page, '/sta');
      await seeText(page, 'Chat status');
      await command(page, '/context');
      await seeText(page, 'AI memory for this chat');
      await command(page, '/compact');
      await seeText(page, /^(Summary requested|Nothing to summarize yet)$/);
      await command(page, '/help');
      await seeText(page, 'Commands you can use here');
      await command(page, '/deploy now');
      await seeText(page, '/deploy now');
      await seeText(page, STUB_FINAL_PREFIX);
      await settle(page, log);
    },
  },
];

export async function runGoalCheck({ baseUrl, viewport, out, log = console.log }) {
  const stub = await startStubModel();
  const evidence = path.join('goal-check', out);
  const report = { startedAt: new Date().toISOString(), baseUrl, viewport, stubModel: stub.url, stages: [], notes: {}, problems: [] };
  const browser = await loadChromium();
  let failed = false;
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
        failed = true;
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
    const target = path.join(EVIDENCE_DIR, evidence, 'report.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed: !failed }, null, 2)}\n`);
    log(`Report: ${target}`);
  }
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { command: name, options } = parseArgs(['run', ...argv]);
  if (name !== 'run' || options.help) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  const baseUrl = options['base-url'] || readState()?.baseUrl;
  if (!baseUrl) throw new Error('No instance to drive. Run "npm run drive -- launch" first, or pass --base-url.');
  if (new URL(baseUrl).port === '4200') throw new Error('Refusing to drive port 4200: it is the everyday FLUJO with real data.');
  const viewport = parseViewport(options.viewport);
  const out = typeof options.out === 'string' ? options.out : `${viewport.width}x${viewport.height}`;
  return runGoalCheck({ baseUrl, viewport, out, log });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// The Human step (#1095) as one repeatable browser check: add a Human step in the Easy view and on
// the Expert canvas, then run Draft -> Review and edit -> Send in a real chat and answer the card,
// and answer a Fill-in step at phone width, with a wrong answer first and a reload afterwards.
// It drives a throwaway FLUJO like a user and answers with a free local stand-in model, so it needs
// no account or key. How to run it: docs/feature-map/agents.md ("Human step journey").
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_DIR, gotoWithRetry, isAlive, loadChromium, parseArgs, readState, routeUrl, save, settle,
} from '../flujo-drive.mjs';
import { startProductionFlujo } from '../first-journey/production.mjs';
import { STAGES as FIRST_USE_STAGES } from '../first-journey/run.mjs';
import { planCompletion, startStubModel } from '../first-journey/stub-model.mjs';

const WAIT = 120_000;
export const DRAFT = 'Dear Ben, the meeting moves to Friday.';
export const EDITED = 'Dear Ben, the meeting moves to Monday at ten.';
export const NAMES = Object.freeze({
  easyAgent: 'Review before sending',
  expertAgent: 'Ask before acting',
  reviewFlow: 'Draft review send',
  phoneFlow: 'Order copies',
});

export const USAGE = `Usage: node scripts/human-step-journey/run.mjs [--base-url URL]

Checks the Human step like a user, with a local stand-in model it starts itself, on a throwaway
FLUJO with a fresh data folder (never port 4200): the instance "npm run drive -- launch" started
from this checkout while it runs, otherwise one it starts from the production build ("npm run build"
first) and stops and deletes at the end. Screenshots, accessibility snapshots and report.json are
saved under ${path.join(EVIDENCE_DIR, 'human-step-journey')}. Exit code 0 means every stage passed
without a crash on the page.`;

const text = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('') : '');

/**
 * The stand-in model's answers. A step whose instructions say WRITE-THE-DRAFT gets the draft; a step
 * whose instructions say SEND-THIS gets back exactly what follows, so the check can see which text
 * reached the step after the person. Anything else (the AI test in setup) gets the usual stub answer.
 */
export function reviewPlan(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const all = messages.map((message) => text(message.content)).join('\n');
  const send = /SEND-THIS:\s*(.+)/.exec(all);
  if (send) return { role: 'assistant', content: `Sent: ${send[1].trim()}` };
  if (/WRITE-THE-DRAFT/.test(all)) return { role: 'assistant', content: DRAFT };
  return planCompletion(body);
}

const visible = (locator) => locator.filter({ visible: true }).first();
const button = (page, name, exact = false) => visible(page.getByRole('button', { name, exact }));

async function seeText(page, value, timeout = WAIT) {
  await page.getByText(value).filter({ visible: true }).first().waitFor({ timeout });
}

async function json(response) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function open(page, baseUrl, route, log) {
  await gotoWithRetry(page, routeUrl(baseUrl, route), log);
  await settle(page, log);
}

/** Save a flow through the same address the builder uses. */
async function saveFlow(baseUrl, flow) {
  await json(await fetch(routeUrl(baseUrl, 'api/flow'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(flow),
  }));
  return flow.id;
}

async function stubModelId(baseUrl) {
  const models = await json(await fetch(routeUrl(baseUrl, 'api/model')));
  const model = (Array.isArray(models) ? models : []).find((entry) => entry.displayName === 'Local stub AI' || entry.name === 'Local stub AI');
  if (!model?.id) throw new Error('The stand-in model was not saved.');
  return model.id;
}

const graphNode = (id, type, label, properties) => ({ id, type, position: { x: 0, y: 0 }, data: { label, type, properties } });
const graphEdge = (source, target) => ({
  id: `${source}:${source.split('-')[0]}-bottom->${target}:${target.split('-')[0]}-top`, source, target,
  sourceHandle: `${source.split('-')[0]}-bottom`, targetHandle: `${target.split('-')[0]}-top`, type: 'custom',
  data: { edgeType: 'standard' }, animated: true,
});

/** Start -> Draft (AI) -> Human step -> Send (AI) -> Finish, the shape the issue describes. */
export function reviewFlow(id, name, modelId, human) {
  return {
    id, name, nodes: [
      graphNode('start-1', 'start', 'Start', { promptTemplate: '' }),
      graphNode('process-draft', 'process', 'Draft', { boundModel: modelId, promptTemplate: 'WRITE-THE-DRAFT: write a short email to Ben.' }),
      graphNode('human-review', 'human', 'Review', human),
      graphNode('process-send', 'process', 'Send', { boundModel: modelId, promptTemplate: 'SEND-THIS: ${var:review.value}' }),
      graphNode('finish-1', 'finish', 'Finish', {}),
    ],
    edges: [
      graphEdge('start-1', 'process-draft'),
      // An AI step moves on through a handoff or a condition; "the draft is written" is the condition here.
      { ...graphEdge('process-draft', 'human-review'), data: { edgeType: 'standard', condition: { kind: 'contains', value: 'Dear Ben' } } },
      graphEdge('human-review', 'process-send'),
      graphEdge('process-send', 'finish-1'),
    ],
  };
}

async function startChat(page, baseUrl, flowId, log) {
  await open(page, baseUrl, `chat?flow=${encodeURIComponent(flowId)}`, log);
  const message = visible(page.getByRole('textbox', { name: 'Message' }));
  await message.waitFor({ timeout: WAIT });
  await message.fill('Please write the email.');
  await button(page, 'Send message', true).click();
}

/** Each stage acts like a user and checks what a user would see. */
export const STAGES = [
  ...FIRST_USE_STAGES.filter((stage) => stage.id === 'home' || stage.id === 'connect-ai'),
  {
    id: 'easy-view',
    title: 'Add a Human step in the Easy view and save the agent',
    async run({ page, baseUrl, log, notes }) {
      await open(page, baseUrl, 'flows', log);
      await button(page, 'Start simple').click();
      await seeText(page, 'Build it like a simple recipe.');
      // With an AI connected, the Easy view first asks whether it may help; it asks once the models are loaded.
      await button(page, 'No, I’ll build it myself').click({ timeout: WAIT });
      await visible(page.getByLabel('Workflow goal')).fill('Write a short email to Ben.');
      await button(page, 'Create goal step').click();
      await button(page, 'Add human step').click();
      const dialog = visible(page.getByRole('dialog', { name: /Human step/ }));
      await dialog.waitFor({ timeout: WAIT });
      for (const mode of ['Approve', 'Fill in', 'Review and edit']) await visible(dialog.getByRole('button', { name: mode, exact: true })).waitFor();
      await visible(dialog.getByRole('button', { name: 'Review and edit', exact: true })).click();
      const question = visible(dialog.getByLabel('Question for the person'));
      await question.fill('');
      if (await visible(dialog.getByRole('button', { name: 'Save', exact: true })).isEnabled()) throw new Error('Save is on while the question is empty.');
      await question.fill('Check the email before it goes out.');
      await visible(dialog.getByRole('button', { name: 'Save', exact: true })).click();
      await dialog.waitFor({ state: 'hidden', timeout: WAIT });
      await seeText(page, 'Review and edit');
      await visible(page.getByLabel('Agent name')).fill(NAMES.easyAgent);
      await button(page, 'Save flow', true).click();
      await seeText(page, 'Agent saved.');
      const flows = await json(await fetch(routeUrl(baseUrl, 'api/flow')));
      const saved = (Array.isArray(flows) ? flows : flows.flows ?? []).find((flow) => flow.name === NAMES.easyAgent);
      const human = saved?.nodes?.find((node) => node.type === 'human');
      if (human?.data?.properties?.mode !== 'edit') throw new Error('The saved agent has no Review and edit step.');
      notes.easyHumanPrompt = human.data.properties.prompt;
    },
  },
  {
    id: 'expert-canvas',
    title: 'Add "Ask a person" on the Expert canvas and fill its settings',
    async run({ page, baseUrl, log }) {
      await open(page, baseUrl, 'flows', log);
      await button(page, 'Start expert').click();
      await visible(page.getByRole('button', { name: /^Ask a person/ })).click();
      await button(page, 'Full settings').click();
      const dialog = visible(page.getByRole('dialog', { name: /Human step/ }));
      await dialog.waitFor({ timeout: WAIT });
      const question = visible(dialog.getByLabel('Question for the person'));
      await question.fill('');
      if (await visible(dialog.getByRole('button', { name: 'Save', exact: true })).isEnabled()) throw new Error('Save is on while the question is empty.');
      await question.fill('May the agent go on?');
      await visible(dialog.getByRole('button', { name: 'Save', exact: true })).click();
      await dialog.waitFor({ state: 'hidden', timeout: WAIT });
      await seeText(page, 'May the agent go on?');
    },
  },
  {
    id: 'chat-review',
    title: 'Run Draft -> Review and edit -> Send in the chat and answer the card',
    async run({ page, baseUrl, log, notes }) {
      const modelId = await stubModelId(baseUrl);
      const flowId = await saveFlow(baseUrl, reviewFlow('human-journey-review', NAMES.reviewFlow, modelId, {
        mode: 'edit', title: 'Check the email', prompt: 'Fix anything before it goes out.',
      }));
      await startChat(page, baseUrl, flowId, log);
      await seeText(page, 'Check the email');
      const edit = visible(page.getByLabel('Change the text if needed'));
      await edit.waitFor({ timeout: WAIT });
      if ((await edit.inputValue()) !== DRAFT) throw new Error(`The card does not show the draft: ${await edit.inputValue()}`);
      await edit.fill(EDITED);
      await seeText(page, 'You changed the text. Your version is what goes on.');
      await save(page, 'shot', path.join('human-step-journey', 'chat-review-card.png'), log);
      await button(page, 'Send answer', true).click();
      await seeText(page, `Sent: ${EDITED}`);
      const listed = await json(await fetch(routeUrl(baseUrl, 'api/human-tasks?include=finished')));
      const step = listed.tasks?.find((task) => task.title === 'Check the email');
      if (step?.outcome !== 'submitted') throw new Error(`The step list does not show the answer: ${JSON.stringify(step)}`);
      notes.reviewReceipt = step.decisionId;
    },
  },
  {
    id: 'phone',
    title: 'Answer a Fill-in step at phone width, wrong first, then reload',
    viewport: { width: 360, height: 800 },
    async run({ page, baseUrl, log, notes }) {
      const modelId = await stubModelId(baseUrl);
      const flowId = await saveFlow(baseUrl, reviewFlow('human-journey-phone', NAMES.phoneFlow, modelId, {
        mode: 'input', title: 'How many copies?', prompt: 'Say how many copies to print.',
        fields: [{ name: 'copies', label: 'Copies', type: 'integer', required: true, min: 1, max: 5 }],
      }));
      await startChat(page, baseUrl, flowId, log);
      await seeText(page, 'How many copies?');
      await button(page, 'Send answer', true).click();
      await seeText(page, 'This answer is needed.');
      await save(page, 'shot', path.join('human-step-journey', 'phone-wrong-answer.png'), log);
      const copies = visible(page.getByLabel('Copies'));
      await copies.fill('9');
      await button(page, 'Send answer', true).click();
      await seeText(page, 'Enter 5 or less.');
      await copies.fill('3');
      await button(page, 'Send answer', true).click();
      await seeText(page, 'Sent: {"copies":3}');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`The page scrolls sideways at phone width (${overflow}px).`);
      // Reopen the conversation as after a lost connection: the answer is kept, nothing asks again.
      const listed = await json(await fetch(routeUrl(baseUrl, 'api/human-tasks?include=finished')));
      const step = listed.tasks?.find((task) => task.title === 'How many copies?');
      if (step?.outcome !== 'submitted' || !step.conversationId) throw new Error(`The step list does not show the answer: ${JSON.stringify(step)}`);
      await open(page, baseUrl, `chat?conversation=${encodeURIComponent(step.conversationId)}`, log);
      await seeText(page, 'Sent: {"copies":3}');
      if (await page.getByText('Waiting for you').filter({ visible: true }).count()) throw new Error('The answered step asks again after reopening.');
      notes.phoneConversation = step.conversationId;
    },
  },
];

export function verdict(report) {
  const pageErrors = report.problems.filter((problem) => problem.startsWith('page error:'));
  const reasons = [];
  if (report.stages.some((stage) => !stage.ok) || report.stages.length !== STAGES.length) reasons.push('a stage did not pass');
  if (pageErrors.length) reasons.push(`${pageErrors.length} error(s) crashed code on the page`);
  return { passed: reasons.length === 0, reasons };
}

export async function runJourney({ baseUrl, log = console.log, server }) {
  const stub = await startStubModel({ plan: reviewPlan });
  const evidence = 'human-step-journey';
  const report = { startedAt: new Date().toISOString(), baseUrl, server: server ?? 'given', stubModel: stub.url, stages: [], notes: {}, problems: [] };
  const browser = await loadChromium();
  let result = { passed: false, reasons: [] };
  try {
    const contexts = new Map();
    const pageFor = async (viewport = { width: 1600, height: 900 }) => {
      const key = `${viewport.width}x${viewport.height}`;
      if (!contexts.has(key)) {
        const context = await browser.newContext({ viewport, locale: 'en-US' });
        await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
        const page = await context.newPage();
        page.on('pageerror', (error) => report.problems.push(`page error: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') report.problems.push(`console error: ${message.text().slice(0, 300)}`);
        });
        contexts.set(key, page);
      }
      return contexts.get(key);
    };
    for (const stage of STAGES) {
      const started = Date.now();
      const page = await pageFor(stage.viewport);
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
    await stub.close();
    result = verdict(report);
    const target = path.join(EVIDENCE_DIR, evidence, 'report.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed: result.passed, failedBecause: result.reasons }, null, 2)}\n`);
    log(`Report: ${target}`);
  }
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  log(result.passed ? 'Human step journey passed.' : `Human step journey failed: ${result.reasons.join('; ')}.`);
  return result.passed ? 0 : 1;
}

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
  rmSync(path.join(EVIDENCE_DIR, 'human-step-journey'), { recursive: true, force: true });
  if (given) return runJourney({ baseUrl: given, log, server: 'given' });
  const instance = await start({ logFile: path.join(EVIDENCE_DIR, 'human-step-journey', 'flujo.log'), log });
  try {
    return await runJourney({ baseUrl: instance.baseUrl, log, server: 'production build' });
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

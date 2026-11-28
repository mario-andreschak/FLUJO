#!/usr/bin/env node
// The tool result size limit (#1226) checked the way a person uses it, in a browser on a throwaway
// FLUJO from the production build with a local stand-in model: set the limit in Settings (and see a
// bad size refused), run an agent whose tool returns about 43 KB and see the result moved behind a
// flujo://run/ link, then give the agent's AI step its own "Keep results in full" and see the whole
// result come back. Screenshots, page snapshots and report.json are saved per stage.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, gotoWithRetry, loadChromium, parseArgs, routeUrl, save, settle } from './flujo-drive.mjs';
import { startProductionFlujo } from './first-journey/production.mjs';
import { STUB_MODEL_ID, planCompletion, startStubModel } from './first-journey/stub-model.mjs';

export const USAGE = `Usage: node scripts/tool-result-limit-check.mjs [--out FOLDER]

Starts its own FLUJO from the production build ("npm run build" first) with an empty data folder and
a local stand-in model, then checks the tool result size limit in the browser: the Settings page,
a run whose big tool result is moved, and an agent step that keeps results in full. Proof is saved
under ${path.join(EVIDENCE_DIR, 'tool-result-limit')}. Exit code 0 means every stage passed.`;

export const BIG_FILE = 'big-log.txt';
export const END_MARKER = 'END OF THE BIG LOG 1226';
export const NAMES = Object.freeze({
  ai: 'Limit check AI',
  agent: 'Big log reader',
  app: 'filesystem',
  goal: `Use the connected app to read ${BIG_FILE} and say how it ends.`,
  question: `Read ${BIG_FILE} with read_file and tell me how it ends.`,
});
/** About 43 KB: over the 32 KB the check sets, far under half of any model's context window. */
export function bigLog() {
  const lines = Array.from({ length: 1000 }, (_, index) => `log line ${String(index).padStart(4, '0')}: everything is fine so far`);
  return `${lines.join('\n')}\n${END_MARKER}\n`;
}
export const MOVED_REPLY = 'The result was moved to';
export const FULL_REPLY = 'The whole result arrived:';
const WAIT = 120_000;

function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : JSON.stringify(content ?? '');
}

/**
 * The stand-in model: asked about the big log, it reads the file with the app's read tool, then says
 * whether the result reached it moved (quoting the flujo://run/ link) or whole (quoting its last line).
 * Everything else is the first-use journey's stub.
 */
export function planLimitCompletion(body, folder) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user').at(-1);
  if (!lastUser || !text(lastUser.message.content).includes(BIG_FILE)) return planCompletion(body);
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function ?? tool).filter((tool) => tool?.name);
  const reader = tools.find((tool) => /(?:^|_)read_(?:text_)?file$/.test(tool.name));
  const result = messages.slice(lastUser.index + 1).filter((message) => message.role === 'tool').at(-1);
  if (!result && reader) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: reader.name, arguments: JSON.stringify({ path: path.join(folder, BIG_FILE) }) } }],
    };
  }
  const resultText = text(result?.content);
  const link = /flujo:\/\/run\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.exec(resultText)?.[0];
  if (link) return { role: 'assistant', content: `${MOVED_REPLY} \`${link}\`` };
  if (resultText.includes(END_MARKER)) return { role: 'assistant', content: `${FULL_REPLY} ${resultText.length} characters ending with "${END_MARKER}".` };
  return { role: 'assistant', content: `I could not read ${BIG_FILE}.` };
}

const visible = (locator) => locator.filter({ visible: true }).first();
const button = (page, name, exact = false) => visible(page.getByRole('button', { name, exact }));

async function seeText(page, wanted, timeout = WAIT) {
  await page.getByText(wanted).filter({ visible: true }).first().waitFor({ timeout });
}

async function openSettingsAdvanced(page, baseUrl, log) {
  await gotoWithRetry(page, routeUrl(baseUrl, 'settings'), log);
  await settle(page, log);
  await button(page, 'Advanced', true).click();
  await visible(page.getByRole('switch', { name: 'Move large tool results to a resource' })).waitFor({ timeout: WAIT });
}

async function ask(page, question, reply) {
  await visible(page.getByRole('textbox', { name: 'Message' })).fill(question);
  await button(page, 'Send message', true).click();
  await seeText(page, reply);
}

/** Finds the agent with the search box, as a person with several agents would, and presses a button on its card. */
async function openAgentCard(page, action) {
  await visible(page.getByRole('textbox', { name: 'Search agents…' })).fill(NAMES.agent);
  await visible(page.getByText('1 of 2 agents')).waitFor({ timeout: WAIT });
  await button(page, action, true).click();
}

async function openStepSettings(page, baseUrl, log, notes) {
  await gotoWithRetry(page, routeUrl(baseUrl, 'flows'), log);
  await settle(page, log);
  await openAgentCard(page, 'Edit');
  await settle(page, log);
  const expert = visible(page.getByRole('switch', { name: 'Expert view' }));
  if (!(await expert.isChecked())) await expert.click();
  await settle(page, log);
  // Canvas steps have no names of their own; the AI step is the node that shows the agent's goal step.
  const steps = page.getByRole('group').filter({ has: page.locator('[aria-roledescription="node"]') }).or(page.locator('[aria-roledescription="node"]'));
  const aiStep = visible(steps.filter({ hasText: /AI|goal|Goal/ }));
  notes.aiStepText = (await aiStep.innerText()).replace(/\s+/g, ' ').slice(0, 120);
  await aiStep.click();
  await button(page, /Full settings/).click();
  await visible(page.getByRole('tab', { name: 'Input / output' })).click();
}

/** Each stage acts like a person and checks what a person would see. */
export const STAGES = [
  {
    id: 'settings-limit',
    title: 'Settings: turn the limit on, refuse 0 KB, save 32 KB, and keep it after a reload',
    async run({ page, baseUrl, log }) {
      await openSettingsAdvanced(page, baseUrl, log);
      const toggle = visible(page.getByRole('switch', { name: 'Move large tool results to a resource' }));
      if (!(await toggle.isChecked())) await toggle.click();
      await seeText(page, 'Saved. The next tool call uses the new setting.');
      // The choice saves at once and shows as chosen when the server answers.
      const custom = visible(page.getByRole('radio', { name: 'Custom size' }));
      await custom.click();
      await page.waitForFunction(() => document.querySelector('input[type="radio"][value="custom"]')?.checked === true, null, { timeout: WAIT });
      const size = visible(page.getByRole('spinbutton', { name: 'Size limit (KB)' }));
      await size.fill('0');
      await seeText(page, 'Enter a whole number of kilobytes from 1 to 102,400.');
      if (await button(page, 'Save limits', true).isEnabled()) throw new Error('"Save limits" stayed enabled for 0 KB.');
      await size.fill('32');
      await button(page, 'Save limits', true).click();
      await seeText(page, 'Saved. The next tool call uses the new setting.');
      await openSettingsAdvanced(page, baseUrl, log);
      const kept = [
        await visible(page.getByRole('switch', { name: 'Move large tool results to a resource' })).isChecked(),
        await visible(page.getByRole('radio', { name: 'Custom size' })).isChecked(),
        await visible(page.getByRole('spinbutton', { name: 'Size limit (KB)' })).inputValue(),
      ];
      if (JSON.stringify(kept) !== JSON.stringify([true, true, '32'])) throw new Error(`After a reload the limit shows ${JSON.stringify(kept)}.`);
    },
  },
  {
    id: 'connect-ai',
    title: 'Connect the local stand-in AI',
    async run({ page, baseUrl, log, model }) {
      await gotoWithRetry(page, baseUrl, log);
      await settle(page, log);
      const close = button(page, 'Close tour', true);
      if (await close.isVisible().catch(() => false)) await close.click();
      await visible(page.getByRole('link', { name: 'Connect AI' })).click();
      await settle(page, log);
      await seeText(page, 'Let’s connect your AI!');
      await button(page, 'I’m an expert').click();
      await seeText(page, 'Connect your AI');
      await visible(page.getByLabel('Display name')).fill(NAMES.ai);
      await visible(page.getByRole('combobox', { name: 'Provider' })).click();
      await visible(page.getByRole('option', { name: 'Ollama', exact: true })).click();
      await visible(page.getByLabel('Base URL')).fill(model.url);
      await visible(page.getByLabel('Technical name')).fill(STUB_MODEL_ID);
      await button(page, /^Save$/).click();
      await seeText(page, NAMES.ai);
      await settle(page, log);
    },
  },
  {
    id: 'big-result-moved',
    title: 'Run an agent whose tool returns about 43 KB: the model gets a flujo://run/ link instead',
    async run({ page, baseUrl, log }) {
      await gotoWithRetry(page, routeUrl(baseUrl, 'flows'), log);
      await settle(page, log);
      await button(page, 'Start simple').click();
      await seeText(page, 'Build it like a simple recipe.');
      await button(page, 'No, I’ll build it myself').click();
      await visible(page.getByLabel('Workflow goal')).fill(NAMES.goal);
      await button(page, 'Create goal step').click();
      await button(page, 'Add an app').click();
      await visible(page.getByRole('dialog', { name: 'Choose an app' }).getByRole('button', { name: new RegExp(`^${NAMES.app}\\b`) })).click();
      await visible(page.getByLabel('Agent name')).fill(NAMES.agent);
      await button(page, 'Try my agent').click();
      await page.waitForURL(/\/chat/, { timeout: WAIT });
      await settle(page, log);
      await ask(page, NAMES.question, MOVED_REPLY);
      await seeText(page, 'flujo://run/');
    },
  },
  {
    id: 'step-keeps-full',
    title: 'Give the agent\'s AI step "Keep results in full": the next run gets the whole result',
    async run({ page, baseUrl, log, notes }) {
      await openStepSettings(page, baseUrl, log, notes);
      const limit = visible(page.getByRole('combobox', { name: 'Tool result size limit' }));
      await limit.click();
      await visible(page.getByRole('option', { name: 'Custom size' })).click();
      const size = visible(page.getByRole('spinbutton', { name: 'Size limit for this step (KB)' }));
      await size.fill('0');
      await seeText(page, 'Enter a whole number of kilobytes from 1 to 102,400.');
      if (await button(page, 'Save changes', true).isEnabled()) throw new Error('"Save changes" stayed enabled for 0 KB.');
      await limit.click();
      await visible(page.getByRole('option', { name: 'Keep results in full' })).click();
      await button(page, 'Save changes', true).click();
      await button(page, 'Save flow', true).click();
      await seeText(page, 'Agent saved.');
      await openStepSettings(page, baseUrl, log, notes);
      const shown = (await visible(page.getByRole('combobox', { name: 'Tool result size limit' })).innerText()).trim();
      if (shown !== 'Keep results in full') throw new Error(`After saving, the step shows "${shown}".`);
      await page.keyboard.press('Escape');
      await gotoWithRetry(page, routeUrl(baseUrl, 'flows'), log);
      await settle(page, log);
      await openAgentCard(page, 'Use');
      await page.waitForURL(/\/chat/, { timeout: WAIT });
      await settle(page, log);
      await ask(page, NAMES.question, FULL_REPLY);
      await seeText(page, END_MARKER);
    },
  },
  {
    id: 'settings-off-again',
    title: 'Switch the limit off again, as a person would after trying it',
    async run({ page, baseUrl, log }) {
      await openSettingsAdvanced(page, baseUrl, log);
      const toggle = visible(page.getByRole('switch', { name: 'Move large tool results to a resource' }));
      if (await toggle.isChecked()) await toggle.click();
      await seeText(page, 'Saved. The next tool call uses the new setting.');
    },
  },
];

export async function runCheck({ baseUrl, folder, out, log = console.log }) {
  const model = await startStubModel({ plan: (body) => planLimitCompletion(body, folder) });
  const evidence = path.join('tool-result-limit', out);
  const report = { startedAt: new Date().toISOString(), baseUrl, stages: [], notes: {}, problems: [] };
  const browser = await loadChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'en-US' });
    await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.problems.push(`page error: ${error.message}`));
    for (const stage of STAGES) {
      const started = Date.now();
      try {
        await stage.run({ page, baseUrl, log, model, notes: report.notes });
        await save(page, 'shot', path.join(evidence, `${stage.id}.png`), log);
        await save(page, 'aria', path.join(evidence, `${stage.id}.yml`), log);
        report.stages.push({ id: stage.id, ok: true, seconds: (Date.now() - started) / 1000 });
        log(`✓ ${stage.title}`);
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
    report.modelCalls = model.events.map(({ kind, calledTools, answered }) => ({ kind, calledTools, answered }));
    await model.close();
  }
  const passed = report.stages.length === STAGES.length && report.stages.every((stage) => stage.ok)
    && !report.problems.some((problem) => problem.startsWith('page error:'));
  const target = path.join(EVIDENCE_DIR, evidence, 'report.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed }, null, 2)}\n`);
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  log(`Report: ${target}`);
  log(passed ? 'The tool result size limit check passed.' : 'The tool result size limit check failed.');
  return passed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), log = console.log, { start = startProductionFlujo } = {}) {
  const { command, options } = parseArgs(['run', ...argv]);
  if (command !== 'run' || options.help) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  const out = typeof options.out === 'string' ? options.out : 'desktop';
  if (!/^[\w-][\w.-]*$/.test(out) || out.includes('..')) throw new Error(`--out must be a plain folder name such as "desktop", got "${out}".`);
  rmSync(path.join(EVIDENCE_DIR, 'tool-result-limit', out), { recursive: true, force: true });
  const folder = mkdtempSync(path.join(os.tmpdir(), 'flujo-tool-result-limit-'));
  writeFileSync(path.join(folder, BIG_FILE), bigLog());
  try {
    const instance = await start({ logFile: path.join(EVIDENCE_DIR, 'tool-result-limit', out, 'flujo.log'), log, env: { FLUJO_FS_ROOTS: folder } });
    try {
      return await runCheck({ baseUrl: instance.baseUrl, folder, out, log });
    } finally {
      await instance.stop();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

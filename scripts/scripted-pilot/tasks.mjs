// The tester guide's day-one tasks (docs/pilots/product-fit/tester-guide.md), each played like a
// first-time user and each with a fixed time limit and the result that must be visible.
import { gotoWithRetry, routeUrl, settle } from '../flujo-drive.mjs';
import { STUB_MODEL_ID } from '../first-journey/stub-model.mjs';
import { ANSWER_PREFIX, COULD_NOT_READ, PRACTICE_FILE, PRACTICE_PHRASE } from './pilot-model.mjs';
import { checkPulse } from './pulse-collector.mjs';
import { checkDiagnosticReport } from './result.mjs';

export const NAMES = Object.freeze({
  ai: 'Pilot local AI',
  agent: 'Practice note reader',
  app: 'filesystem',
  readTool: 'read_file',
  goal: `Use the connected app to read ${PRACTICE_FILE} and tell me its receipt phrase. Don't guess.`,
  question: `Read the practice note (${PRACTICE_FILE}) using the connected tool. What is its receipt phrase?`,
});

/** Tasks 1 to 3 are the first run the pilot plan times. */
export const FIRST_RUN_TASKS = Object.freeze(['connect-ai', 'app-tool', 'build-agent']);
export const FIRST_RUN_LIMIT_SECONDS = 15 * 60;

const WAIT = 90_000;
const visible = (locator) => locator.filter({ visible: true }).first();
const button = (page, name, exact = false) => visible(page.getByRole('button', { name, exact }));
const link = (page, name, exact = false) => visible(page.getByRole('link', { name, exact }));

async function seeText(page, text, timeout = WAIT) {
  await page.getByText(text).filter({ visible: true }).first().waitFor({ timeout });
}

async function isShown(locator) {
  return locator.isVisible().catch(() => false);
}

/** Opens a page from the top navigation, through the menu button on narrow screens, as a person would. */
async function navigate(page, name, log) {
  const direct = link(page, name, true);
  const menu = button(page, 'Open navigation menu', true);
  const more = visible(page.getByRole('link', { name: 'More', exact: true }).or(page.getByRole('button', { name: /^More/ })));
  // A window that is still closing hides the rest of the page for a moment.
  await visible(direct.or(menu).or(more)).waitFor({ timeout: WAIT });
  if (!(await isShown(direct))) {
    if (await isShown(menu)) await menu.click();
    else {
      await more.click();
      await settle(page, log);
    }
  }
  const target = visible(page.getByRole('link', { name, exact: true }).or(page.getByRole('tab', { name, exact: true })));
  await target.click();
  await settle(page, log);
}

async function closeTour(page) {
  const close = button(page, 'Close tour', true);
  if (await isShown(close)) await close.click();
}

async function openRunOptions(page) {
  const approvals = page.getByRole('checkbox', { name: 'Require tool approvals' });
  if (!(await isShown(visible(approvals)))) await button(page, 'Run options', true).click();
  await visible(approvals).waitFor({ timeout: WAIT });
  return approvals;
}

async function ask(page, question) {
  await visible(page.getByRole('textbox', { name: 'Message' })).fill(question);
  await button(page, 'Send message', true).click();
}

/**
 * Whether a reply containing `needle` shows after the newest copy of `question`. The chat only
 * keeps the messages near the bottom on screen, so counting replies over the whole chat misleads.
 */
function repliedAfterQuestion({ question, needle }) {
  const leaves = [...document.querySelectorAll('p, span, div')].filter((element) => element.childElementCount === 0 && element.getClientRects().length);
  const asked = leaves.map((element) => element.textContent.trim()).lastIndexOf(question);
  return asked >= 0 && leaves.slice(asked + 1).some((element) => element.textContent.includes(needle));
}

async function hasReply(page, question, needle) {
  return page.evaluate(repliedAfterQuestion, { question, needle });
}

async function waitForReply(page, question, needle, timeout = WAIT) {
  await page.waitForFunction(repliedAfterQuestion, { question, needle }, { timeout }).catch(() => {
    throw new Error(`No reply with "${needle}" showed after the question within ${timeout / 1000}s.`);
  });
}

/** The debugger waits for the person: its step buttons are on. With `orClosed`, a debugger that closed because the run ended counts too. */
function debuggerReady(orClosed = false) {
  const controls = [...document.querySelectorAll('button')].filter((element) => /^(Step next|Next trace step|Continue)$/.test(element.textContent.trim()));
  return controls.length > 0 ? controls.every((element) => !element.disabled) : orClosed;
}

function debuggerBusy() {
  return [...document.querySelectorAll('button')].some((element) => /^(Step next|Next trace step)$/.test(element.textContent.trim()) && element.disabled);
}

export const TASKS = Object.freeze([
  {
    id: 'connect-ai',
    title: 'Task 1: connect the AI and test it',
    limitSeconds: 180,
    expected: 'The model test shows the answer and the tool round-trip from the AI.',
    async run({ page, baseUrl, log, model }) {
      await gotoWithRetry(page, baseUrl, log);
      await settle(page, log);
      await closeTour(page);
      await link(page, 'Connect AI').click();
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
      await button(page, 'Test model').click();
      await seeText(page, 'The FLUJO tool round-trip also passed.');
      await page.keyboard.press('Escape');
    },
  },
  {
    id: 'app-tool',
    title: 'Task 2: connect an app and test one tool',
    limitSeconds: 180,
    expected: `The filesystem app may read only the practice folder, and its ${NAMES.readTool} tool returns the practice note.`,
    async run({ page, log, practice }) {
      await navigate(page, 'Connected Apps', log);
      await button(page, `Open ${NAMES.app}`, true).click();
      await settle(page, log);
      const details = visible(page.getByRole('dialog'));
      await visible(details.getByRole('tab', { name: /^Environment Variables/ })).click();
      await button(details, 'Add variable', true).click();
      await details.getByRole('textbox', { name: 'Variable name' }).last().fill('FLUJO_FS_ROOTS');
      await details.getByRole('textbox', { name: 'Value' }).last().fill(practice.folder);
      await button(details, 'Save changes', true).click();
      await settle(page, log);
      await visible(details.getByRole('tab', { name: /^Tools/ })).click();
      await visible(details.getByRole('combobox', { name: /^Select tool/ })).click();
      await visible(page.getByRole('option', { name: NAMES.readTool, exact: true })).click();
      await visible(details.getByRole('textbox', { name: 'path', exact: true })).fill(practice.file);
      await button(details, 'Test tool', true).click();
      await seeText(page, PRACTICE_PHRASE);
      await page.keyboard.press('Escape');
    },
  },
  {
    id: 'build-agent',
    title: 'Task 3: build an agent that uses the app',
    limitSeconds: 240,
    expected: `The agent calls ${NAMES.readTool} and answers with the phrase the tool returned (${PRACTICE_PHRASE}).`,
    async run({ page, log }) {
      await navigate(page, 'Agents', log);
      await button(page, 'Start simple').click();
      await settle(page, log);
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
      await ask(page, NAMES.question);
      await waitForReply(page, NAMES.question, `${ANSWER_PREFIX} ${PRACTICE_PHRASE}`);
      await button(page, 'Toggle executed steps panel', true).click();
      await seeText(page, 'Executed steps');
      await seeText(page, NAMES.readTool);
      // On a phone the steps open as a window over the chat; close it after looking, as a person would.
      const stepsWindow = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Executed steps' }) });
      if (await isShown(stepsWindow)) await button(stepsWindow, 'Hide executed steps panel', true).click();
    },
  },
  {
    id: 'approve-reject',
    title: 'Task 4: approve before the agent acts, then reject',
    limitSeconds: 240,
    expected: 'With approvals on, the tool runs only after Approve, and nothing runs after Reject.',
    async run({ page, log, notes }) {
      const approvals = await openRunOptions(page);
      await visible(approvals).check();
      await page.keyboard.press('Escape');
      const answer = `${ANSWER_PREFIX} ${PRACTICE_PHRASE}`;
      const approve = button(page, 'Approve', true);
      await ask(page, NAMES.question);
      const deadline = Date.now() + WAIT;
      for (let approved = 0; !(await hasReply(page, NAMES.question, answer)); ) {
        if (Date.now() > deadline) throw new Error('Neither an approval prompt nor the answer showed after the question.');
        if (!(await isShown(approve))) {
          await page.waitForTimeout(250);
          continue;
        }
        if (approved >= 4) throw new Error('The agent asked for approval more than four times for one question.');
        const clicked = await approve.elementHandle();
        await clicked.click();
        await clicked.waitForElementState('hidden', { timeout: WAIT });
        approved += 1;
      }
      notes.approvedAnswer = true;
      await ask(page, NAMES.question);
      const reject = await button(page, 'Reject', true).elementHandle({ timeout: WAIT });
      await reject.click();
      await reject.waitForElementState('hidden', { timeout: WAIT });
      await waitForReply(page, NAMES.question, COULD_NOT_READ);
      if (await hasReply(page, NAMES.question, answer)) {
        throw new Error('After Reject the agent still answered with the phrase, so the tool ran anyway.');
      }
      await button(page, 'Approve', true).waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {
        throw new Error('The run ended after Reject, but the approval prompt stayed on screen and the chat stayed blocked.');
      });
      await visible(page.getByRole('textbox', { name: 'Message' })).waitFor({ timeout: WAIT });
      await settle(page, log);
    },
  },
  {
    id: 'debugger',
    title: 'Task 5: watch the agent step by step in the debugger',
    limitSeconds: 240,
    expected: 'The debugger stops before a step, shows what the tool returned, and the run finishes after continuing.',
    async run({ page, log, notes }) {
      const approvals = await openRunOptions(page);
      if (await visible(approvals).isChecked()) await visible(approvals).uncheck();
      await button(page, /^(Debugger|Open the debugger)/).click();
      // Wide screens show "Debugger armed" beside the chat; on a phone the options sheet says it is on.
      await seeText(page, 'Debugger armed', 5_000).catch(async () => {
        await button(page, 'Run options', true).click();
        await button(page, /^Close the debugger/).waitFor({ timeout: WAIT });
        await page.keyboard.press('Escape');
      });
      await ask(page, NAMES.question);
      await page.waitForFunction(debuggerReady, null, { timeout: WAIT });
      const toolResult = page.getByText(`Receipt phrase: ${PRACTICE_PHRASE}`).filter({ visible: true });
      const stateAfter = page.locator('[aria-expanded="false"]').filter({ hasText: /^State after$/ });
      let steps = 0;
      for (; steps < 20 && !(await toolResult.count()); steps += 1) {
        await button(page, /^(Step next|Next trace step)$/).click();
        await page.waitForFunction(debuggerBusy, null, { timeout: 2_000 }).catch(() => undefined);
        await page.waitForFunction(debuggerReady, true, { timeout: WAIT });
        if (!(await button(page, 'Continue', true).count())) throw new Error(`The run ended before the debugger showed what ${NAMES.readTool} returned.`);
        if (await page.getByText('After tool call').filter({ visible: true }).count() && await stateAfter.count()) {
          await stateAfter.first().click();
        }
      }
      if (!(await toolResult.count())) throw new Error(`The debugger never showed what ${NAMES.readTool} returned after ${steps} steps.`);
      notes.debuggerSteps = steps;
      await button(page, 'Continue', true).click();
      await waitForReply(page, NAMES.question, `${ANSWER_PREFIX} ${PRACTICE_PHRASE}`);
      await settle(page, log);
    },
  },
  {
    id: 'reuse-app',
    title: 'Task 6: use the same app from another program',
    limitSeconds: 120,
    expected: `Another MCP program lists the app's tools through FLUJO and reads the practice note with ${NAMES.readTool}.`,
    async run({ page, baseUrl, log, practice, notes }) {
      await gotoWithRetry(page, routeUrl(baseUrl, 'mcp'), log);
      await settle(page, log);
      const card = page.locator(`[data-tutorial-server-name="${NAMES.app}"]`).first();
      await visible(card.getByLabel('Expose to external apps')).check();
      const address = (await visible(card.getByText(/\/mcp-proxy\//)).innerText({ timeout: WAIT })).trim();
      notes.proxyAddress = address;
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'flujo-scripted-pilot', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(address)), { timeout: 60_000 });
      try {
        const { tools } = await client.listTools();
        if (!tools.some((tool) => tool.name === NAMES.readTool)) throw new Error(`The other program does not see ${NAMES.readTool}.`);
        const result = await client.callTool({ name: NAMES.readTool, arguments: { path: practice.file } });
        if (!JSON.stringify(result).includes(PRACTICE_PHRASE)) throw new Error('Reading the practice note from the other program did not return its phrase.');
      } finally {
        await client.close();
      }
    },
  },
  {
    id: 'diagnostic-report',
    title: 'Share a diagnostic report',
    limitSeconds: 120,
    expected: 'Settings → Privacy & usage → Create report shows a complete report that counts this tester\'s work and holds nothing private, and the anonymous usage pulse holds only what its notice says.',
    async run({ page, log, notes, privateValues, pulses }) {
      await navigate(page, 'Settings', log);
      const section = visible(page.getByRole('button', { name: 'Privacy & usage' }));
      const picker = visible(page.getByRole('combobox', { name: 'Settings section' }));
      await visible(section.or(picker)).waitFor({ timeout: WAIT });
      if (await isShown(section)) await section.click();
      else {
        await picker.click();
        await visible(page.getByRole('option', { name: 'Privacy & usage' })).click();
      }
      await button(page, 'Create report', true).click();
      const box = visible(page.getByRole('textbox', { name: /Report \(read it before you share it\)/ }));
      await box.waitFor({ timeout: WAIT });
      const report = await box.inputValue();
      notes.diagnosticReport = report;
      await button(page, 'Copy', true).waitFor({ timeout: WAIT });
      await button(page, 'Save as file', true).waitFor({ timeout: WAIT });
      const problems = checkDiagnosticReport(report, {
        privateValues,
        expected: { aiConnections: 1, agentsUsingApps: 1, runs: 1, toolCalls: 1, aiRequests: 1 },
      });
      if (!pulses.length) problems.push('FLUJO sent no anonymous usage pulse, although its notice says it did.');
      for (const pulse of pulses) problems.push(...checkPulse(pulse, privateValues));
      if (problems.length) throw new Error(problems.join(' '));
    },
  },
]);

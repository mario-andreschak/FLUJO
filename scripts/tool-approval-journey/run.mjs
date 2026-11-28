#!/usr/bin/env node
// "Require tool approvals" (#1284) as one repeatable browser check, in place of the eleven steps a
// person used to click through: off runs tools unasked; on asks per call with mixed decisions;
// each conversation keeps its own box; unticking keeps a waiting card; a reload brings the card
// back and a double click runs a tool once; Stop drops the card; a failed save puts the box back;
// a sub-flow asks in the parent chat, its card survives a reload, shows in the approval inbox and
// unticking mid-run lets its next call run; the card works by keyboard; a Claude subscription model
// asks on the same card; and an automation that pauses is answered once through the inbox.
// It drives a throwaway FLUJO from the production build with local stand-ins for an OpenAI-style
// model and for Anthropic's service, so it needs no account or key. Proof: screenshots, page
// snapshots and report.json per stage. How to run it: docs/feature-map/talk.md.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, gotoWithRetry, loadChromium, parseArgs, routeUrl, save, settle } from '../flujo-drive.mjs';
import { startProductionFlujo } from '../first-journey/production.mjs';
import { STAGES as FIRST_USE_STAGES } from '../first-journey/run.mjs';
import { planCompletion, startStubModel } from '../first-journey/stub-model.mjs';
import { startAnthropicStandIn, textOf } from '../anthropic-stand-in.mjs';

const WAIT = 120_000;
/** How long a stage watches for something that must not happen (a tool running, a card coming back). */
const QUIET_MS = 3_000;
export const FILE_TEXT = 'Written by the tool approval journey.';
export const CLAUDE_TOKEN = 'sk-ant-oat01-tool-approval-journey-not-a-token';
export const NAMES = Object.freeze({
  agent: 'Approval helper',
  goal: 'Write the files the person asks for.',
  subflow: 'Approval parent',
  claudeModel: 'Approval Claude',
  claudeFlow: 'Approval Claude agent',
  automation: 'Approval automation',
});
export const APPROVAL_BOX = 'Require tool approvals';
export const CARD_TITLE = 'Tool approval required';
export const SAVE_FAILED = 'Could not save "Require tool approvals"';

export const USAGE = `Usage: node scripts/tool-approval-journey/run.mjs [--out FOLDER]

Starts its own FLUJO from the production build ("npm run build" first) with an empty data folder, a
local stand-in model and a local stand-in for Anthropic's service, then checks "Require tool
approvals" in the browser the way a person uses it. Proof is saved under
${path.join(EVIDENCE_DIR, 'tool-approval-journey')}. Exit code 0 means every stage passed without a
crash on the page.`;

const text = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('') : '');
const ASK = /\b(WRITE-FILE|TWO-CALLS|TWO-ROUNDS)\s+([\w.-]+)(?:\s+([\w.-]+))?/;
const toolNamed = (tools, tool) => tools.find((candidate) => candidate.name === tool
  || new RegExp(`(^|_)${tool}(_[A-Za-z0-9]+)?$`).test(candidate.name));

/**
 * The stand-in model. "WRITE-FILE a.txt" writes one file; "TWO-CALLS a.txt" asks for the allowed
 * folders and a write at once; "TWO-ROUNDS a.txt b.txt" writes one file per model turn. Once the
 * results are in it answers "Finished <kind> <file>: <results>", so a stage can wait for its own
 * answer. Anything else (the AI test in setup) gets the first-use journey's stub answer.
 */
export function approvalPlan(body, folder) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function ?? tool).filter((tool) => tool?.name);
  const lastUser = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user').at(-1);
  const asked = lastUser ? ASK.exec(text(lastUser.message.content)) : null;
  if (!asked) return planCompletion(body);
  const [, kind, first, second] = asked;
  const results = messages.slice(lastUser.index + 1).filter((message) => message.role === 'tool')
    .map((message) => text(message.content).replace(/\s+/g, ' ').trim().slice(0, 120));
  const write = toolNamed(tools, 'write_file');
  const allowed = toolNamed(tools, 'get_allowed_directories');
  if (!write || (kind === 'TWO-CALLS' && !allowed)) return { role: 'assistant', content: `No tool for ${kind}.` };
  const call = (tool, args) => ({ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(args) } });
  const writeCall = (name) => call(write, { path: path.join(folder, name), content: FILE_TEXT });
  const ask = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
  const done = { role: 'assistant', content: `Finished ${kind} ${first}: ${results.join(' | ')}` };
  if (kind === 'WRITE-FILE') return results.length ? done : ask(writeCall(first));
  if (kind === 'TWO-CALLS') return results.length ? done : ask(call(allowed, {}), writeCall(first));
  if (results.length === 0) return ask(writeCall(first));
  if (results.length === 1) return ask(writeCall(second ?? `${first}.second`));
  return done;
}

/** The Anthropic stand-in: Claude calls the write tool for "WRITE-FILE a.txt", then says it is done. */
export function claudeReply(body, folder) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const blocks = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]);
  const lastText = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && textOf(message.content).trim()).at(-1);
  const asked = lastText ? /WRITE-FILE\s+([\w.-]+)/.exec(textOf(lastText.message.content)) : null;
  const resultIn = lastText ? messages.slice(lastText.index + 1).some((message) => blocks(message.content).some((block) => block?.type === 'tool_result')) : false;
  const tool = (Array.isArray(body?.tools) ? body.tools : []).find((entry) => String(entry?.name ?? '').includes('write_file'));
  if (asked && tool && !resultIn) return { type: 'tool_use', name: tool.name, input: { path: path.join(folder, asked[1]), content: FILE_TEXT } };
  if (asked && resultIn) return { type: 'text', text: `Claude finished WRITE-FILE ${asked[1]}.` };
  return { type: 'text', text: 'Hello from the Claude stand-in.' };
}

const visible = (locator) => locator.filter({ visible: true }).first();
const button = (page, name, exact = false) => visible(page.getByRole('button', { name, exact }));
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function seeText(page, wanted, timeout = WAIT) {
  await page.getByText(wanted).filter({ visible: true }).first().waitFor({ timeout });
}

async function json(response) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const api = async (baseUrl, route, init) => json(await fetch(routeUrl(baseUrl, route), {
  ...init,
  headers: { 'Content-Type': 'application/json', ...init?.headers },
  signal: AbortSignal.timeout(WAIT),
}));

async function open(page, baseUrl, route, log) {
  await gotoWithRetry(page, routeUrl(baseUrl, route), log);
  await settle(page, log);
}

const card = (page) => visible(page.getByRole('region', { name: CARD_TITLE }));
const approveButtons = (page) => card(page).getByRole('button', { name: 'Approve', exact: true });
const rejectButtons = (page) => card(page).getByRole('button', { name: 'Reject', exact: true });

/** The approval box in Run options, opened when it is folded away. */
async function approvalBox(page) {
  const box = visible(page.getByRole('checkbox', { name: APPROVAL_BOX }));
  if (!(await box.isVisible().catch(() => false))) await button(page, 'Run options', true).click();
  await box.waitFor({ timeout: WAIT });
  return box;
}

/** Tick or untick the box and wait until its save has answered (a chat not saved yet sends none). */
async function setApproval(page, wanted) {
  const box = await approvalBox(page);
  if ((await box.isChecked()) !== wanted) {
    const savedChat = new URL(page.url()).searchParams.has('conversation');
    const saved = savedChat ? page.waitForResponse((response) => response.request().method() === 'PATCH'
      && /\/v1\/chat\/conversations\//.test(response.url()), { timeout: WAIT }) : undefined;
    await box.click();
    await saved;
  }
  await page.keyboard.press('Escape');
}

async function boxIsTicked(page) {
  const ticked = await (await approvalBox(page)).isChecked();
  await page.keyboard.press('Escape');
  return ticked;
}

async function ask(page, message) {
  const input = visible(page.getByRole('textbox', { name: 'Message' }));
  await input.waitFor({ timeout: WAIT });
  await input.fill(message);
  await button(page, 'Send message', true).click();
}

async function conversationIdOf(page) {
  await page.waitForURL(/[?&]conversation=/, { timeout: WAIT });
  return new URL(page.url()).searchParams.get('conversation');
}

async function savedConversation(baseUrl, conversationId) {
  return api(baseUrl, `v1/chat/conversations/${encodeURIComponent(conversationId)}`);
}

/** Watches for a while that something stays as it is (a file stays absent, a card stays). */
async function staysFor(check, message) {
  const until = Date.now() + QUIET_MS;
  while (Date.now() < until) {
    if (!(await check())) throw new Error(message);
    await pause(250);
  }
}

async function agentFlowId(baseUrl, name) {
  const flows = await api(baseUrl, 'api/flow');
  const flow = (Array.isArray(flows) ? flows : flows.flows ?? []).find((entry) => entry.name === name);
  if (!flow?.id) throw new Error(`The agent "${name}" was not saved.`);
  return flow;
}

const graphNode = (id, type, label, properties) => ({ id, type, position: { x: 0, y: 0 }, data: { label, type, properties } });
const graphEdge = (source, target, edgeType = 'standard') => ({
  id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
  sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType },
});

/** Start -> Subflow (the agent) -> Finish: the agent's tools run inside a sub-flow. */
export function subflowParent(id, childId) {
  const nodes = [
    graphNode('start-1', 'start', 'Start', { promptTemplate: '' }),
    graphNode('subflow-1', 'subflow', 'Helper', { subflowId: childId }),
    graphNode('finish-1', 'finish', 'Finish', {}),
  ];
  return { id, name: NAMES.subflow, nodes, edges: [graphEdge(nodes[0], nodes[1]), graphEdge(nodes[1], nodes[2])] };
}

/** Start -> one AI step on the Claude subscription model, with the filesystem app's write tool. */
export function claudeAgent(id, modelId) {
  const nodes = [
    graphNode('start-1', 'start', 'Start', { promptTemplate: '' }),
    graphNode('process-1', 'process', 'Claude', { boundModel: modelId, inputMode: 'full-history', allowQuestion: false,
      promptTemplate: 'Write the files the person asks for.' }),
    graphNode('finish-1', 'finish', 'Finish', {}),
    graphNode('mcp-1', 'mcp', 'Files', { boundServer: 'filesystem', enabledTools: ['write_file'] }),
  ];
  return {
    id, name: NAMES.claudeFlow, nodes,
    edges: [graphEdge(nodes[0], nodes[1]), graphEdge(nodes[1], nodes[2]),
      { id: 'mcp-1-process-1', source: 'mcp-1', target: 'process-1', type: 'custom', data: { edgeType: 'mcp' } }],
  };
}

/** Each stage acts like a person and checks what a person would see; `notes` carries ids between stages. */
export const STAGES = [
  ...FIRST_USE_STAGES.filter((stage) => stage.id === 'home' || stage.id === 'connect-ai'),
  {
    id: 'build-agent',
    title: 'Build an agent with the filesystem app in the simple builder',
    async run({ page, baseUrl, log, notes }) {
      await open(page, baseUrl, 'flows', log);
      await button(page, 'Start simple').click();
      await seeText(page, 'Build it like a simple recipe.');
      await button(page, 'No, I’ll build it myself').click({ timeout: WAIT });
      await visible(page.getByLabel('Workflow goal')).fill(NAMES.goal);
      await button(page, 'Create goal step').click();
      await button(page, 'Add an app').click();
      await visible(page.getByRole('dialog', { name: 'Choose an app' }).getByRole('button', { name: /^filesystem\b/ })).click();
      await visible(page.getByLabel('Agent name')).fill(NAMES.agent);
      await button(page, 'Try my agent').click();
      await page.waitForURL(/\/chat/, { timeout: WAIT });
      await settle(page, log);
      notes.agentFlowId = (await agentFlowId(baseUrl, NAMES.agent)).id;
    },
  },
  {
    id: 'off-runs-unasked',
    title: 'Step 1: with the box off a tool runs at once, with no card',
    async run({ page, baseUrl, folder, notes }) {
      await setApproval(page, false);
      await ask(page, 'WRITE-FILE off.txt');
      await seeText(page, 'Finished WRITE-FILE off.txt');
      if (await card(page).isVisible()) throw new Error('A card showed although the box is off.');
      if (!existsSync(path.join(folder, 'off.txt'))) throw new Error('The tool did not run.');
      notes.conversationA = await conversationIdOf(page);
      if ((await savedConversation(baseUrl, notes.conversationA)).requireApproval !== false) throw new Error('The conversation was not saved with the box off.');
    },
  },
  {
    id: 'mixed-decisions',
    title: 'Step 2: two calls at once show two cards; approve one, reject the other; the answer waits for both',
    async run({ page, folder }) {
      await setApproval(page, true);
      await ask(page, 'TWO-CALLS denied.txt');
      await seeText(page, CARD_TITLE);
      if ((await approveButtons(page).count()) !== 2) throw new Error(`Expected two calls on the card, saw ${await approveButtons(page).count()}.`);
      // The card names each tool and shows its arguments.
      for (const shown of ['get_allowed_directories', 'write_file', 'denied.txt']) await card(page).getByText(shown).first().waitFor({ timeout: WAIT });
      await approveButtons(page).first().click();
      await staysFor(async () => (await page.getByText('Finished TWO-CALLS').count()) === 0 && (await approveButtons(page).count()) === 1,
        'The answer went on before the second call had a decision.');
      await rejectButtons(page).first().click();
      await seeText(page, 'Finished TWO-CALLS denied.txt');
      await seeText(page, 'tool denied');
      if (existsSync(path.join(folder, 'denied.txt'))) throw new Error('The rejected write ran.');
    },
  },
  {
    id: 'own-box-per-conversation',
    title: 'Step 3: each conversation shows its own saved box after switching',
    async run({ page, baseUrl, log, notes }) {
      await open(page, baseUrl, `chat?flow=${encodeURIComponent(notes.agentFlowId)}`, log);
      await setApproval(page, false);
      await ask(page, 'WRITE-FILE second-conversation.txt');
      await seeText(page, 'Finished WRITE-FILE second-conversation.txt');
      notes.conversationB = await conversationIdOf(page);
      const titles = { [notes.conversationA]: 'Approval journey A', [notes.conversationB]: 'Approval journey B' };
      for (const [id, title] of Object.entries(titles)) {
        await api(baseUrl, `v1/chat/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      }
      await open(page, baseUrl, `chat?conversation=${encodeURIComponent(notes.conversationB)}`, log);
      const openIn = async (title, ticked) => {
        await visible(page.getByRole('button', { name: new RegExp(`^Open ${title};`) })).click();
        await page.waitForURL(new RegExp(`conversation=${title.endsWith('A') ? notes.conversationA : notes.conversationB}`), { timeout: WAIT });
        await settle(page, log);
        if ((await boxIsTicked(page)) !== ticked) throw new Error(`"${title}" shows the box ${ticked ? 'off' : 'on'}, but it was saved ${ticked ? 'on' : 'off'}.`);
      };
      await openIn('Approval journey A', true);
      await openIn('Approval journey B', false);
      await openIn('Approval journey A', true);
    },
  },
  {
    id: 'untick-keeps-card',
    title: 'Step 4: unticking the box keeps the waiting card, and nothing runs until a click',
    async run({ page, folder }) {
      await ask(page, 'WRITE-FILE untick.txt');
      await seeText(page, CARD_TITLE);
      await setApproval(page, false);
      await staysFor(async () => (await card(page).isVisible()) && !existsSync(path.join(folder, 'untick.txt')),
        'Unticking the box released or hid the waiting call.');
      await approveButtons(page).first().click();
      await seeText(page, 'Finished WRITE-FILE untick.txt');
      if (!existsSync(path.join(folder, 'untick.txt'))) throw new Error('The approved write did not run.');
      await setApproval(page, true);
    },
  },
  {
    id: 'reload-and-double-click',
    title: 'Step 5: a reload shows the card again; a double click on Approve runs the tool once',
    async run({ page, baseUrl, log, notes }) {
      await ask(page, 'WRITE-FILE reload.txt');
      await seeText(page, CARD_TITLE);
      await page.reload();
      await page.waitForLoadState('load'); // the waiting card shows a busy indicator, which settle() would wait a minute for
      await seeText(page, CARD_TITLE);
      await approveButtons(page).first().dblclick();
      await seeText(page, 'Finished WRITE-FILE reload.txt');
      if (await page.getByText('Could not approve the tool call.').count()) throw new Error('The second click of the double click showed an error.');
      const saved = await savedConversation(baseUrl, notes.conversationA);
      const writes = (saved.messages ?? []).filter((message) => message.role === 'assistant')
        .flatMap((message) => message.tool_calls ?? []).filter((call) => String(call.function?.arguments).includes('reload.txt'));
      const results = (saved.messages ?? []).filter((message) => message.role === 'tool' && writes.some((call) => call.id === message.tool_call_id));
      if (writes.length !== 1 || results.length !== 1) throw new Error(`The write ran ${results.length} time(s) for ${writes.length} call(s).`);
    },
  },
  {
    id: 'stop-drops-card',
    title: 'Step 6: Stop takes the card away and nothing runs',
    async run({ page, folder }) {
      await ask(page, 'WRITE-FILE stopped.txt');
      await seeText(page, CARD_TITLE);
      await button(page, 'Stop', true).click();
      await card(page).waitFor({ state: 'hidden', timeout: WAIT });
      await staysFor(async () => !(await card(page).isVisible()) && !existsSync(path.join(folder, 'stopped.txt')),
        'After Stop the card came back or the tool ran.');
    },
  },
  {
    id: 'failed-save',
    title: 'Step 7: a save that fails puts the box back and says so; a working save says nothing',
    async run({ page, baseUrl, log, notes }) {
      await setApproval(page, false);
      const failPatch = (route) => (route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.fallback());
      await page.route('**/v1/chat/conversations/**', failPatch);
      try {
        await (await approvalBox(page)).click();
        await seeText(page, SAVE_FAILED);
        if (await (await approvalBox(page)).isChecked()) throw new Error('The box stayed ticked although the save failed.');
        await page.keyboard.press('Escape');
      } finally {
        await page.unroute('**/v1/chat/conversations/**', failPatch);
      }
      await page.reload();
      await settle(page, log);
      await setApproval(page, true);
      await staysFor(async () => (await page.getByText(SAVE_FAILED).count()) === 0, 'A working save showed the failure message.');
      if (!(await boxIsTicked(page)) || (await savedConversation(baseUrl, notes.conversationA)).requireApproval !== true) {
        throw new Error('The working save did not keep the box ticked.');
      }
    },
  },
  {
    id: 'subflow-live-wait',
    title: 'Step 8: a sub-flow asks in the parent chat; its card survives a reload and shows in the inbox; unticking lets its next call run',
    async run({ page, baseUrl, log, folder, notes }) {
      notes.subflowId = 'tool-approval-journey-parent';
      await api(baseUrl, 'api/flow', { method: 'POST', body: JSON.stringify(subflowParent(notes.subflowId, notes.agentFlowId)) });
      await open(page, baseUrl, `chat?flow=${encodeURIComponent(notes.subflowId)}`, log);
      await setApproval(page, true);
      await ask(page, 'TWO-ROUNDS sub-one.txt sub-two.txt');
      await seeText(page, CARD_TITLE);
      await card(page).getByText('sub-one.txt').first().waitFor({ timeout: WAIT });
      const parent = await conversationIdOf(page);
      await page.reload();
      await page.waitForLoadState('load'); // the waiting card shows a busy indicator, which settle() would wait a minute for
      await seeText(page, CARD_TITLE);
      const inbox = await api(baseUrl, 'api/approvals');
      const entry = inbox.approvals?.find((approval) => approval.conversationId === parent);
      if (!entry?.live || !String(entry.approvalId).startsWith('apr_') || entry.pendingToolCalls?.length !== 1) {
        throw new Error(`The approval inbox does not list the sub-flow's wait: ${JSON.stringify(inbox.approvals)}`);
      }
      if (JSON.stringify(entry).includes('sub-one.txt')) throw new Error('The inbox listing shows the tool arguments.');
      notes.liveInboxEntry = { live: entry.live, expiresAt: entry.expiresAt };
      await setApproval(page, false);
      if (await page.getByText(SAVE_FAILED).count()) throw new Error('Unticking during the run could not be saved.');
      if (existsSync(path.join(folder, 'sub-one.txt'))) throw new Error('The waiting call ran when the box was unticked.');
      await approveButtons(page).first().click();
      await seeText(page, 'Finished TWO-ROUNDS sub-one.txt');
      for (const name of ['sub-one.txt', 'sub-two.txt']) {
        if (!existsSync(path.join(folder, name))) throw new Error(`${name} was not written.`);
      }
    },
  },
  {
    id: 'claude-subscription',
    title: 'Step 9: a Claude subscription model asks on the same card; Approve runs the tool',
    async run({ page, baseUrl, log, folder }) {
      await api(baseUrl, 'api/model', { method: 'POST', body: JSON.stringify({ id: 'tool-approval-journey-claude', name: 'haiku',
        displayName: NAMES.claudeModel, provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: CLAUDE_TOKEN }) });
      await api(baseUrl, 'api/flow', { method: 'POST', body: JSON.stringify(claudeAgent('tool-approval-journey-claude-flow', 'tool-approval-journey-claude')) });
      await open(page, baseUrl, 'chat?flow=tool-approval-journey-claude-flow', log);
      await setApproval(page, true);
      await ask(page, 'WRITE-FILE claude.txt');
      await seeText(page, CARD_TITLE);
      await card(page).getByText('write_file').first().waitFor({ timeout: WAIT });
      if (existsSync(path.join(folder, 'claude.txt'))) throw new Error('Claude ran the tool before the decision.');
      await approveButtons(page).first().click();
      await seeText(page, 'Claude finished WRITE-FILE claude.txt.');
      if (readFileSync(path.join(folder, 'claude.txt'), 'utf8') !== FILE_TEXT) throw new Error('Claude did not write the file.');
    },
  },
  {
    id: 'keyboard',
    title: 'Step 10: reach Approve and Reject with the keyboard, press Enter; focus stays visible',
    async run({ page, baseUrl, log, folder, notes }) {
      await open(page, baseUrl, `chat?conversation=${encodeURIComponent(notes.conversationA)}`, log);
      await setApproval(page, true);
      await ask(page, 'TWO-CALLS keys.txt');
      await seeText(page, CARD_TITLE);
      // From the message box, Shift+Tab walks back up the page into the card above it.
      const keyTo = async (name) => {
        const input = visible(page.getByRole('textbox', { name: 'Message' }));
        await input.focus();
        for (let presses = 0; presses < 60; presses += 1) {
          await page.keyboard.press('Shift+Tab');
          const focused = await page.evaluate(() => {
            const element = document.activeElement;
            return element?.tagName === 'BUTTON' ? { name: element.textContent?.trim(), ring: element.matches(':focus-visible') } : null;
          });
          if (focused?.name === name) {
            if (!focused.ring) throw new Error(`"${name}" has the focus but shows no focus ring.`);
            return;
          }
        }
        throw new Error(`The keyboard never reached "${name}".`);
      };
      // The last call on the card (the write) comes first going backwards.
      await keyTo('Approve');
      await page.keyboard.press('Enter');
      await staysFor(async () => (await approveButtons(page).count()) === 1, 'Enter on Approve did not decide exactly one call.');
      await keyTo('Reject');
      await page.keyboard.press('Enter');
      await seeText(page, 'Finished TWO-CALLS keys.txt');
      await seeText(page, 'tool denied');
      if (!existsSync(path.join(folder, 'keys.txt'))) throw new Error('The write approved by keyboard did not run.');
    },
  },
  {
    id: 'automation-inbox',
    title: 'Step 11: an automation that pauses is listed in the inbox; one approval runs it, the same request again is refused',
    async run({ baseUrl, folder, notes }) {
      const created = await api(baseUrl, 'api/planned-executions', { method: 'POST', body: JSON.stringify({
        name: NAMES.automation, enabled: false, flowId: notes.agentFlowId, prompt: 'WRITE-FILE automation.txt',
        saveConversations: true, approvalPolicy: 'pause', overlapStrategy: 'skip', startRestriction: 'singleton',
        trigger: { type: 'schedule', cron: '0 0 1 1 *', catchUp: false },
      }) });
      const ran = await api(baseUrl, `api/planned-executions/${encodeURIComponent(created.execution.id)}/run`, { method: 'POST', body: '{}' });
      notes.automationRun = ran.record?.status;
      const inbox = await api(baseUrl, 'api/approvals');
      const entry = inbox.approvals?.find((approval) => approval.plannedExecutionId === created.execution.id);
      if (!entry || !String(entry.approvalId).startsWith('apr_') || entry.live) throw new Error(`The paused automation is not in the inbox: ${JSON.stringify(inbox.approvals)}`);
      if (existsSync(path.join(folder, 'automation.txt'))) throw new Error('The automation ran its tool before the decision.');
      const decide = () => fetch(routeUrl(baseUrl, `api/approvals/${encodeURIComponent(entry.approvalId)}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }), signal: AbortSignal.timeout(WAIT),
      });
      const first = await json(await decide());
      if (first.status !== 'completed' || !existsSync(path.join(folder, 'automation.txt'))) throw new Error(`Approving did not finish the automation: ${JSON.stringify(first)}`);
      const again = await decide();
      if (again.status !== 404) throw new Error(`Sending the same approval again answered ${again.status}, not 404.`);
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

export async function runJourney({ baseUrl, folder, stub, claude, out, log = console.log }) {
  const evidence = path.join('tool-approval-journey', out);
  const report = { startedAt: new Date().toISOString(), baseUrl, stages: [], notes: {}, problems: [] };
  const browser = await loadChromium();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'en-US' });
    await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') report.problems.push(`console error: ${message.text().slice(0, 300)}`);
    });
    for (const stage of STAGES) {
      const started = Date.now();
      try {
        await stage.run({ page, baseUrl, log, folder, stub, claude, notes: report.notes });
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
  }
  report.modelCalls = stub.events.map(({ kind, calledTools, answered }) => ({ kind, calledTools, answered }));
  report.claudeRequests = claude.requests.length;
  const result = verdict(report);
  const target = path.join(EVIDENCE_DIR, evidence, 'report.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed: result.passed, failedBecause: result.reasons }, null, 2)}\n`);
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  log(`Report: ${target}`);
  log(result.passed ? 'The tool approval journey passed.' : `The tool approval journey failed: ${result.reasons.join('; ')}.`);
  return result.passed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), log = console.log, { start = startProductionFlujo } = {}) {
  const { command, options } = parseArgs(['run', ...argv]);
  if (command !== 'run' || options.help) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  const out = typeof options.out === 'string' ? options.out : 'desktop';
  if (!/^[\w-][\w.-]*$/.test(out) || out.includes('..')) throw new Error(`--out must be a plain folder name such as "desktop", got "${out}".`);
  rmSync(path.join(EVIDENCE_DIR, 'tool-approval-journey', out), { recursive: true, force: true });
  const folder = mkdtempSync(path.join(os.tmpdir(), 'flujo-tool-approval-'));
  const stub = await startStubModel({ plan: (body) => approvalPlan(body, folder) });
  const claude = { requests: [] };
  const anthropic = await startAnthropicStandIn({ requireCredential: false, reply: ({ body }) => {
    claude.requests.push(Date.now());
    return { blocks: [claudeReply(body, folder)], usage: { output_tokens: 8 } };
  } });
  try {
    const instance = await start({
      logFile: path.join(EVIDENCE_DIR, 'tool-approval-journey', out, 'flujo.log'), log,
      env: { FLUJO_FS_ROOTS: folder, ANTHROPIC_BASE_URL: anthropic.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    try {
      return await runJourney({ baseUrl: instance.baseUrl, folder, stub, claude, out, log });
    } finally {
      await instance.stop();
    }
  } finally {
    await stub.close();
    await anthropic.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

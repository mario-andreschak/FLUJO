// FLUJO's side of the packaged-artifact checks: the test data, its backups and
// the schedule and approval set-up. The data reuses the synthetic state of the
// maintainer drills: one empty flow, one finished conversation with two
// archived messages, the theme and one non-secret setting. Schedules and
// approvals talk only to the local stand-ins (stand-ins.mjs).
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  stateSelections, syntheticIdentifiers, seedSyntheticState, readSyntheticState,
  assertSyntheticState, verifySyntheticStateArchive, readFlowInventory, assertFlowInventory,
  restoreSyntheticState, invalidSyntheticStateArchives,
} from '../maintainer-synthetic-state.mjs';
import { STAND_IN_MODEL_KEY, STAND_IN_TOOL } from './stand-ins.mjs';
import { delay, waitFor, waitUntil } from './targets.mjs';

const { conversationId, flowId, variable } = syntheticIdentifiers;
const fixtureFlow = Object.freeze({ id: flowId, name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] });
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** An unexpected HTTP answer. `status` 0 means nothing answered. */
export class AnswerError extends Error {
  constructor(message, status) { super(message); this.name = 'AnswerError'; this.status = status; }
}

async function expectStatus(request, route, status, options) {
  const response = await request(route, options);
  if (response.status !== status) {
    throw new AnswerError(`${options?.method ?? 'GET'} ${route.split('?')[0]} answered ${response.status}, expected ${status}.`, response.status);
  }
  return response;
}
const readJson = async (request, route, options, status = 200) => JSON.parse((await expectStatus(request, route, status, options)).bytes);

/** What a user would call "the same data", independent of the version that stored it. */
export function semanticView({ state, flows }) {
  const flow = flows.find(item => item.id === flowId);
  return {
    theme: state.theme,
    setting: { value: state.environment?.value, secret: state.environment?.metadata?.isSecret ?? null },
    conversation: {
      id: state.conversation?.id, title: state.conversation?.title,
      messages: (state.conversation?.messages ?? []).map(({ role, content }) => ({ role, content })),
    },
    flow: flow ? { id: flow.id, name: flow.name, nodes: flow.nodes, edges: flow.edges } : null,
  };
}

/**
 * Strict: every stored field of the test data is identical (same version on
 * both sides). Otherwise only what a user sees must match, because a newer
 * version may add fields to records written by an older one.
 */
export function assertSameData(observed, expected, { strict }) {
  if (strict) {
    assertSyntheticState(observed.state, expected.state);
    assertFlowInventory(observed.flows, expected.flows);
    return;
  }
  const found = stable(semanticView(observed));
  const wanted = stable(semanticView(expected));
  if (found !== wanted) throw new Error(`The data differs.\nExpected: ${wanted}\nFound:    ${found}`);
}

/**
 * Backups carry a setting's name only, never its value
 * (src/backend/services/workspace/backupExport.ts), and restoring one keeps
 * the value already stored. These two describe that contract.
 */
const asBackedUp = state => ({ ...state, environment: { value: '', metadata: { isSecret: true } } });
export function expectedAfterRestore(backup, current) {
  return { state: { ...backup.state, environment: current.state.environment }, flows: backup.flows };
}

/** The four parts of the test data a change touches, and how a user sees each. */
export const CHANGE_ITEMS = Object.freeze(['theme', 'setting', 'title', 'flowName']);
const ITEM = Object.freeze({
  theme: { label: 'theme', read: view => view.theme, clear: view => ({ ...view, theme: null }) },
  setting: { label: 'setting', read: view => view.setting.value, clear: view => ({ ...view, setting: { ...view.setting, value: null } }) },
  title: { label: 'conversation title', read: view => view.conversation.title,
    clear: view => ({ ...view, conversation: { ...view.conversation, title: null } }) },
  flowName: { label: 'flow name', read: view => view.flow?.name, clear: view => ({ ...view, flow: view.flow && { ...view.flow, name: null } }) },
});

/**
 * New values for every item, each different from what is shown now. Flow
 * names allow only letters, digits, spaces, "_" and "-" (flowNamePolicy.ts).
 */
export function changeValues(view, variant) {
  return {
    theme: view.theme === 'light' ? 'dark' : 'light',
    setting: `${variant} setting`,
    title: `${variant} conversation`,
    flowName: `${variant} flow`,
  };
}

/** Send one item's change and return the HTTP status (0 when nothing answered). */
async function sendItem(request, item, value) {
  try {
    if (item === 'theme') return (await request('/api/storage', post({ key: 'theme', value }))).status;
    if (item === 'setting') {
      return (await request('/api/env', post({ action: 'set', key: variable, value, metadata: { isSecret: false } }))).status;
    }
    if (item === 'title') return (await request(`/v1/chat/conversations/${conversationId}`, { ...post({ title: value }), method: 'PATCH' })).status;
    const current = await request(`/api/flow/${flowId}`);
    if (current.status !== 200) return current.status;
    return (await request(`/api/flow/${flowId}`, { ...post({ ...JSON.parse(current.bytes), name: value }), method: 'PUT' })).status;
  } catch {
    return 0;
  }
}

/** Send each item's change in turn; returns `{ item, status }` per item and never fails on an error answer. */
export async function sendChanges(request, values, items = CHANGE_ITEMS) {
  const results = [];
  for (const item of items) results.push({ item, status: await sendItem(request, item, values[item]) });
  return results;
}

/**
 * After writes during a full disk: every confirmed change is shown, every
 * other item shows its old or its new value (never anything else) and the
 * rest of the data is untouched.
 */
export function assertChangeOutcome(observed, before, attempt) {
  const shown = semanticView(observed); const old = semanticView(before);
  const confirmed = []; const refused = [];
  for (const { item, status } of attempt.results) {
    const value = ITEM[item].read(shown); const wanted = attempt.values[item]; const previous = ITEM[item].read(old);
    const ok = status >= 200 && status < 300;
    (ok ? confirmed : refused).push(item);
    if (ok && value !== wanted) throw new Error(`The app confirmed the ${ITEM[item].label} change while the disk was full, but lost it.`);
    if (value !== wanted && value !== previous) {
      throw new Error(`After the full disk the ${ITEM[item].label} shows ${JSON.stringify(value)}, neither the old nor the new value.`);
    }
  }
  const rest = view => stable(CHANGE_ITEMS.reduce((result, item) => ITEM[item].clear(result), view));
  if (rest(shown) !== rest(old)) throw new Error('Data the check never changed differs after the disk was full.');
  return { confirmed, refused };
}

const recipientKey = () => Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const bearer = token => ({ authorization: `Bearer ${token}` });

/**
 * Start a snapshot backup of the test flow and wait until its archive is ready
 * to download. A whole-workspace snapshot also has to carry every configured
 * MCP server, which a fresh install's bundled servers do not allow.
 */
async function readySnapshot(request, token, { deadlineMs = 60_000, pause = delay } = {}) {
  const begun = await readJson(request, '/api/snapshot/begin', { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ recipientKey: recipientKey(), flowIds: [flowId] }) }, 202);
  let info = begun;
  await waitFor(async () => {
    info = await readJson(request, `/api/snapshot/status?sessionId=${begun.sessionId}`, { headers: bearer(token) });
    if (['failed', 'aborted'].includes(info.state)) {
      throw new Error(`The snapshot backup ended as ${info.state} (${[info.errorCode, info.error].filter(Boolean).join(': ') || 'no reason given'}).`);
    }
    return info.state === 'ready';
  }, { deadlineMs, pause, message: `The snapshot backup was not ready within ${deadlineMs / 1000} s.` });
  return info;
}

/** The schedule and approval set-up: names, flows and plans, all pointing at the stand-ins. */
export const AUTOMATION = Object.freeze({
  model: 'acceptance-stand-in-model', server: 'acceptance-effects',
  scheduledFlow: 'acceptance-scheduled-flow', approvalFlow: 'acceptance-approval-flow',
  everyFiveSeconds: '*/5 * * * * *', never: '0 0 1 1 *', intervalMs: 5_000,
});
const PLANS = Object.freeze({
  schedule: { name: 'Acceptance schedule', flowId: AUTOMATION.scheduledFlow, enabled: true, cron: AUTOMATION.everyFiveSeconds, approvalPolicy: 'auto' },
  disabled: { name: 'Acceptance switched-off schedule', flowId: AUTOMATION.scheduledFlow, enabled: false, cron: AUTOMATION.everyFiveSeconds, approvalPolicy: 'auto' },
  approve: { name: 'Acceptance run to approve', flowId: AUTOMATION.approvalFlow, enabled: false, cron: AUTOMATION.never, approvalPolicy: 'pause' },
  deny: { name: 'Acceptance run to deny', flowId: AUTOMATION.approvalFlow, enabled: false, cron: AUTOMATION.never, approvalPolicy: 'pause' },
});
const PLAN_FIELDS = Object.freeze(['id', 'generationId', 'name', 'enabled', 'flowId', 'prompt', 'approvalPolicy', 'trigger']);

function automationFlow(id, withTool) {
  const node = (key, type, properties = {}) => ({ id: key, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
  const edge = (source, target, edgeType = 'standard') => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: AUTOMATION.model, promptTemplate: 'Reply to the user.',
    inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edges = [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])];
  if (withTool) {
    nodes.push(node('effect', 'mcp', { boundServer: AUTOMATION.server, enabledTools: [STAND_IN_TOOL] }));
    edges.push(edge(nodes[1], nodes[3], 'mcp'));
  }
  return { id, name: id, nodes, edges };
}

const addStandInModel = (request, standIns) => expectStatus(request, '/api/model', 201, post({ id: AUTOMATION.model, name: AUTOMATION.model,
  provider: 'openai', adapter: 'openai', ApiKey: STAND_IN_MODEL_KEY, baseUrl: standIns.modelUrl }));
async function addPlan(request, marker, plan) {
  const created = await readJson(request, '/api/planned-executions', post({ name: plan.name, enabled: plan.enabled, flowId: plan.flowId,
    prompt: `Acceptance marker: ${marker}.`, saveConversations: true, approvalPolicy: plan.approvalPolicy, overlapStrategy: 'skip',
    startRestriction: 'singleton', trigger: { type: 'schedule', cron: plan.cron, catchUp: false } }), 201);
  return created.execution;
}
const runPlan = async (request, id) => (await readJson(request, `/api/planned-executions/${id}/run`, { ...post({}), timeoutMs: 120_000 })).record;
const approvalsOf = async request => (await readJson(request, '/api/approvals')).approvals ?? [];
const runsOf = async (request, planId) => (await readJson(request, `/api/planned-executions/${planId}/runs`)).runs ?? [];

/**
 * Schedule runs and the stand-in model's requests must match one to one. Each
 * request carries its run's fire time. Only the run that was under way when
 * the app was killed may have called the model without a record. No occurrence
 * runs twice, and the schedule ran both before the kill and after the restart.
 */
export function assertScheduleRuns({ runs, requests, killedAt, restartedAt, intervalMs }) {
  if (requests.some(request => !request.firedAt)) {
    throw new Error('A schedule run\'s prompt has no fire time ("now" in its run info), so model calls cannot be matched to runs.');
  }
  const calls = new Map();
  for (const request of requests) calls.set(request.firedAt, (calls.get(request.firedAt) ?? 0) + 1);
  for (const [firedAt, count] of calls) {
    if (count > 1) throw new Error(`The schedule run fired at ${firedAt} called the model ${count} times.`);
  }
  const recorded = new Set(runs.map(run => run.firedAt));
  const unrecorded = requests.filter(request => !recorded.has(request.firedAt));
  if (unrecorded.length > 1 || unrecorded.some(request => !(Date.parse(request.firedAt) < killedAt))) {
    throw new Error(`The model was called for schedule runs that are not in the run history: ${unrecorded.map(item => item.firedAt).join(', ')}.`);
  }
  for (const run of runs.filter(item => item.status === 'completed')) {
    if (!calls.has(run.firedAt)) throw new Error(`The schedule run fired at ${run.firedAt} is recorded as completed but never called the model.`);
  }
  const slots = new Set();
  for (const run of runs) {
    const slot = Math.round(Date.parse(run.firedAt) / intervalMs);
    if (slots.has(slot)) throw new Error(`The schedule ran twice for the occurrence at ${new Date(slot * intervalMs).toISOString()}.`);
    slots.add(slot);
  }
  const before = runs.filter(run => Date.parse(run.firedAt) < killedAt).length;
  const after = runs.filter(run => Date.parse(run.firedAt) >= restartedAt).length;
  const during = runs.filter(run => Date.parse(run.firedAt) >= killedAt && Date.parse(run.firedAt) < restartedAt).length;
  if (!before) throw new Error('The schedule has no recorded run from before the restart.');
  if (!after) throw new Error('The schedule has no recorded run from after the restart.');
  if (during) throw new Error('The run history has schedule runs from while the app was stopped.');
  return { runsBefore: before, runsAfter: after, modelCalls: requests.length, unrecordedRunAtKill: unrecorded.length === 1 };
}

export function createFlujoProbe({ JSZip, pause = delay }) {
  const probe = {
    /** Join the app's own startup work before reading or changing anything. */
    async ready(request) {
      const response = await request('/api/init', { timeoutMs: 180_000 });
      let body;
      try { body = JSON.parse(response.bytes); } catch { body = undefined; }
      if (response.status !== 200 || body?.success !== true) {
        throw new Error(`Startup did not finish: GET /api/init answered ${response.status}.`);
      }
    },
    async seed(request) {
      const initial = await readFlowInventory(request, false);
      await expectStatus(request, '/api/flow', 201, post(fixtureFlow));
      const state = await seedSyntheticState(request, async () => {}, JSZip);
      const flows = await readFlowInventory(request);
      assertFlowInventory(flows.filter(flow => flow.id !== flowId), initial, false);
      return { state, flows };
    },
    async observe(request) {
      return { state: await readSyntheticState(request, JSZip), flows: await readFlowInventory(request) };
    },
    async backup(request, expected) {
      const response = await expectStatus(request, '/api/backup', 200, post({ selections: stateSelections }));
      await verifySyntheticStateArchive(response.bytes, JSZip, asBackedUp(expected.state), expected.flows);
      return response.bytes;
    },
    expectedAfterRestore,
    /** Change `items` to new values and return what the app then shows. */
    async change(request, current, { variant = 'Changed before a forced stop', items = CHANGE_ITEMS } = {}) {
      const values = changeValues(semanticView(current), variant);
      for (const { item, status } of await sendChanges(request, values, items)) {
        if (status !== 200) throw new AnswerError(`Changing the ${ITEM[item].label} answered ${status || 'nothing'}.`, status);
      }
      const after = await probe.observe(request);
      const view = semanticView(after);
      const missing = items.filter(item => ITEM[item].read(view) !== values[item]);
      if (missing.length) throw new Error(`The app confirmed the changes but does not show the new ${missing.map(item => ITEM[item].label).join(', ')}.`);
      return after;
    },
    /** Try every change once and keep each answer; nothing here fails on an error answer. */
    async attemptChange(request, current, variant) {
      const values = changeValues(semanticView(current), variant);
      return { values, results: await sendChanges(request, values) };
    },
    assertChangeOutcome,
    damagedBackups: bytes => invalidSyntheticStateArchives(bytes, JSZip),
    async restore(request, bytes) { return (await restoreSyntheticState(request, bytes)).status; },
    assertSame: assertSameData,

    /**
     * Put backups under way for the forced stop: an ordinary backup, and on
     * host installations a snapshot backup whose download is open.
     */
    async startBackups(request, { snapshotToken }) {
      const open = [];
      const stages = {};
      if (snapshotToken) {
        const info = await readySnapshot(request, snapshotToken, { pause });
        const download = request.open(`/api/snapshot/download?sessionId=${info.sessionId}`, { headers: bearer(snapshotToken), timeoutMs: 120_000 });
        open.push(download);
        const response = await download.response;
        if (response.status !== 200) throw new AnswerError(`The snapshot download answered ${response.status}.`, response.status);
        const reader = response.body.getReader();
        await reader.read();
        stages.snapshot = 'download open';
      }
      const ordinary = request.open('/api/backup', { ...post({ selections: stateSelections }), timeoutMs: 120_000 });
      open.push(ordinary);
      let answered = false;
      ordinary.response.then(() => { answered = true; }, () => {});
      return {
        kinds: Object.keys(stages).concat('ordinary'),
        settle() {
          stages.ordinary = answered ? 'answered before the stop' : 'cut off by the stop';
          for (const item of open) item.abort();
          return stages;
        },
      };
    },
    /** Backups of every kind complete after the restart and hold exactly the data. */
    async completeBackups(request, { snapshotToken }, expected) {
      const details = { ordinaryBytes: (await probe.backup(request, expected)).length };
      if (snapshotToken) {
        const info = await readySnapshot(request, snapshotToken, { pause });
        const download = await expectStatus(request, `/api/snapshot/download?sessionId=${info.sessionId}`, 200, { headers: bearer(snapshotToken), timeoutMs: 120_000 });
        if (createHash('sha256').update(download.bytes).digest('hex') !== info.sha256) {
          throw new Error('The snapshot backup taken after the restart does not match its own checksum.');
        }
        const finalized = await readJson(request, `/api/snapshot/finalize?sessionId=${info.sessionId}`, { method: 'POST', headers: bearer(snapshotToken) });
        if (finalized.state !== 'finalized') throw new Error(`The snapshot backup could not be finished (${finalized.state}).`);
        details.snapshotBytes = download.bytes.length;
      }
      return details;
    },

    /** A job whose model refuses its request (HTTP 400), run once so its last run failed. */
    async seedFailedJob(request, standIns, name) {
      await addStandInModel(request, standIns);
      await expectStatus(request, '/api/flow', 201, post(automationFlow(AUTOMATION.scheduledFlow, false)));
      const job = await addPlan(request, 'fail-job', { name, flowId: AUTOMATION.scheduledFlow, enabled: false, cron: AUTOMATION.never, approvalPolicy: 'auto' });
      const record = await runPlan(request, job.id);
      if (record?.status !== 'error') throw new Error(`The job meant to fail ended as ${record?.status}.`);
      return { id: job.id, runId: record.runId, error: record.error };
    },

    /** Set up the stand-in model and tool, a running and a switched-off schedule, and two runs that wait for approval. */
    async prepareAutomation(request, standIns, { deadlineMs = 120_000 } = {}) {
      await addStandInModel(request, standIns);
      await expectStatus(request, '/api/mcp/servers', 201, post({ name: AUTOMATION.server, transport: 'streamable', serverUrl: standIns.mcpUrl, disabled: false }));
      await waitFor(async () => (await readJson(request, `/api/mcp/servers/${AUTOMATION.server}/status`)).status === 'connected',
        { deadlineMs, pause, message: 'The stand-in MCP server did not connect.' });
      await expectStatus(request, '/api/flow', 201, post(automationFlow(AUTOMATION.scheduledFlow, false)));
      await expectStatus(request, '/api/flow', 201, post(automationFlow(AUTOMATION.approvalFlow, true)));
      const plans = {};
      for (const [marker, plan] of Object.entries(PLANS)) plans[marker] = await addPlan(request, marker, plan);
      const runs = {};
      for (const marker of ['approve', 'deny']) {
        const record = await runPlan(request, plans[marker].id);
        if (record?.status !== 'needs_approval') throw new Error(`The run to ${marker} did not wait for approval (it ended as ${record?.status}).`);
        runs[marker] = record.runId;
      }
      const waiting = await approvalsOf(request);
      const approvals = {};
      for (const marker of ['approve', 'deny']) {
        approvals[marker] = waiting.find(item => item.runId === runs[marker])?.approvalId;
        if (!approvals[marker]) throw new Error(`The run to ${marker} is not in the list of waiting approvals.`);
      }
      await waitFor(() => standIns.requestsFor('schedule').length > 0, { deadlineMs, pause, message: 'The schedule did not run before the restart.' });
      return { plans, runs, approvals };
    },

    /** After the forced restart: everything is still there, nothing ran on its own, and decisions act exactly once. */
    async verifyAutomation(request, automation, standIns, { killedAt, restartedAt }) {
      for (const [marker, plan] of Object.entries(automation.plans)) {
        const now = await readJson(request, `/api/planned-executions/${plan.id}`);
        const changed = PLAN_FIELDS.filter(field => stable(now[field]) !== stable(plan[field]));
        if (changed.length) throw new Error(`The ${PLANS[marker].name} changed across the restart: ${changed.join(', ')}.`);
      }
      if (standIns.requestsFor('disabled').length || (await runsOf(request, automation.plans.disabled.id)).length) {
        throw new Error('The switched-off schedule ran.');
      }
      if (standIns.requests.some(item => ['approve', 'deny'].includes(item.marker) && item.at >= killedAt)) {
        throw new Error('The restart started a run that was waiting for approval again on its own.');
      }
      if (standIns.effects.length) throw new Error('The stand-in tool ran although nobody approved it.');
      const waiting = await approvalsOf(request);
      for (const marker of ['approve', 'deny']) {
        if (!waiting.some(item => item.runId === automation.runs[marker])) throw new Error(`The approval for the run to ${marker} was lost in the restart.`);
      }

      let decisions = 0; let status;
      while (status !== 'completed') {
        const current = (await approvalsOf(request)).find(item => item.runId === automation.runs.approve);
        if (!current) throw new Error(`The run to approve stopped waiting without completing (last answer: ${status}).`);
        if (++decisions > 3) throw new Error('Approving the run needed more than three decisions.');
        ({ status } = await readJson(request, `/api/approvals/${current.approvalId}`, { ...post({ action: 'approve' }), timeoutMs: 120_000 }));
      }
      if (standIns.effectsFor('approve').length !== 1) throw new Error(`The approved tool ran ${standIns.effectsFor('approve').length} times, not once.`);
      const reused = await request(`/api/approvals/${automation.approvals.approve}`, { ...post({ action: 'approve' }), timeoutMs: 120_000 });
      if (reused.status < 400) throw new Error(`Approving the already decided run again answered ${reused.status}.`);
      if (standIns.effectsFor('approve').length !== 1) throw new Error('Approving the decided run again ran the tool again.');

      const denied = (await approvalsOf(request)).find(item => item.runId === automation.runs.deny);
      if (!denied) throw new Error('The run to deny stopped waiting for approval before anyone decided.');
      const answer = await readJson(request, `/api/approvals/${denied.approvalId}`, { ...post({ action: 'deny' }), timeoutMs: 120_000 });
      if (answer.status !== 'completed') throw new Error(`The denied run ended as ${answer.status}.`);
      if (standIns.effectsFor('deny').length) throw new Error('The denied tool ran.');

      await readJson(request, `/api/planned-executions/${automation.plans.schedule.id}`, { ...post({ enabled: false }), method: 'PATCH' });
      // A run that fired just before the switch-off may still be finishing; give its record a bounded moment.
      let runs = [];
      const settled = async () => {
        runs = await runsOf(request, automation.plans.schedule.id);
        const recorded = new Set(runs.filter(run => run.finishedAt).map(run => run.firedAt));
        return standIns.requestsFor('schedule').every(item => Date.parse(item.firedAt) < killedAt || recorded.has(item.firedAt));
      };
      await waitUntil(settled, { deadlineMs: 30_000, pause });
      const schedule = assertScheduleRuns({ runs, requests: standIns.requestsFor('schedule'), killedAt, restartedAt, intervalMs: AUTOMATION.intervalMs });
      return { approvalDecisions: decisions, ...schedule };
    },
  };
  return probe;
}

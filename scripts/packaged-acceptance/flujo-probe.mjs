// Test data for the packaged-artifact checks. It reuses the synthetic state of
// the maintainer drills: one empty flow, one finished conversation with two
// archived messages, the theme and one non-secret setting. No model, MCP tool,
// schedule, approval or secret is involved.
import {
  stateSelections, syntheticIdentifiers, syntheticState, seedSyntheticState, readSyntheticState,
  assertSyntheticState, verifySyntheticStateArchive, readFlowInventory, assertFlowInventory,
  restoreSyntheticState, invalidSyntheticStateArchives,
} from '../maintainer-synthetic-state.mjs';

const { conversationId, flowId, variable } = syntheticIdentifiers;
const fixtureFlow = Object.freeze({ id: flowId, name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] });
const changedFlowName = 'Changed right before a forced stop';
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

async function expectStatus(request, route, status, options) {
  const response = await request(route, options);
  if (response.status !== status) {
    throw new Error(`${options?.method ?? 'GET'} ${route} answered ${response.status}, expected ${status}.`);
  }
  return response;
}

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

export function createFlujoProbe({ JSZip }) {
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
      await verifySyntheticStateArchive(response.bytes, JSZip, expected.state, expected.flows);
      return response.bytes;
    },
    /** Change every part of the test data and return what the app then shows. */
    async change(request) {
      const changed = syntheticState(true);
      await expectStatus(request, '/api/storage', 200, post({ key: 'theme', value: changed.theme }));
      await expectStatus(request, '/api/env', 200, post({ action: 'set', key: variable, ...changed.environment }));
      await expectStatus(request, `/v1/chat/conversations/${conversationId}`, 200,
        { ...post({ title: changed.conversation.title }), method: 'PATCH' });
      const flow = JSON.parse((await expectStatus(request, `/api/flow/${flowId}`, 200)).bytes);
      await expectStatus(request, `/api/flow/${flowId}`, 200, { ...post({ ...flow, name: changedFlowName }), method: 'PUT' });
      const after = await probe.observe(request);
      const view = semanticView(after);
      if (view.theme !== changed.theme || view.setting.value !== changed.environment.value
          || view.conversation.title !== changed.conversation.title || view.flow?.name !== changedFlowName) {
        throw new Error('The app confirmed the changes but does not show them.');
      }
      return after;
    },
    damagedBackups: bytes => invalidSyntheticStateArchives(bytes, JSZip),
    async restore(request, bytes) { return (await restoreSyntheticState(request, bytes)).status; },
    assertSame: assertSameData,
  };
  return probe;
}

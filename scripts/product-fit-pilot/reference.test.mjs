import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createReferenceState, REFERENCE_TOOLS, REFERENCE_DEFINITION_SHA256, referenceJsonSha256,
} from './reference-data.mjs';
import { checkReferenceResult } from './reference-check.mjs';

const checker = fileURLToPath(new URL('./reference-check.mjs', import.meta.url));
const recipes = {
  'inbox-triage': { calls: [['product_fit_inbox', { queue: 'weekly' }]], answer: { ids: ['notice-02', 'notice-05'] } },
  'document-check': { calls: [['product_fit_document', { document: 'overview' }], ['product_fit_document', { document: 'deployment' }]],
    answer: { differences: [{ field: 'minimumNodeMajor', overview: 22, deployment: 20 }] } },
  'page-compare': { calls: [['product_fit_page', { page: 'catalog' }], ['product_fit_page', { page: 'status' }]], answer: { ids: ['green-kit'] } },
};
function packet(workflow = 'inbox-triage') {
  const state = createReferenceState();
  const toolResults = recipes[workflow].calls.map(([tool, args]) => state.call(tool, args).structuredContent);
  return { schemaVersion: 1, workflow, fixtureReceipt: state.receipt(), toolResults,
    answer: { ...structuredClone(recipes[workflow].answer), receiptPhrases: toolResults.map(result => result.receiptPhrase) } };
}

test('reference data: three read-only tools start with no calls and no product/human claims', () => {
  assert.equal(REFERENCE_TOOLS.length, 3);
  for (const definition of REFERENCE_TOOLS) {
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.equal(definition.annotations.openWorldHint, false);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(Object.isFrozen(definition.inputSchema.properties));
  }
  const receipt = createReferenceState().receipt();
  assert.equal(receipt.toolCalls, 0);
  assert.equal(receipt.acceptedCalls, 0);
  assert.equal(receipt.definitionSha256, REFERENCE_DEFINITION_SHA256);
  assert.ok(Object.values(receipt.claims).every(value => value === false));
});

for (const workflow of Object.keys(recipes)) {
  test(`reference data: ${workflow} joins actual generated call receipts and its declared answer`, () => {
    const input = packet(workflow);
    const report = checkReferenceResult(input);
    assert.equal(report.result, 'pass');
    assert.equal(report.joinedToolResults, recipes[workflow].calls.length);
    assert.ok(Object.values(report.claims).every(value => value === false));
    for (const result of input.toolResults) {
      assert.equal(input.fixtureReceipt.recentCalls.find(call => call.sequence === result.sequence).resultSha256,
        referenceJsonSha256(result));
    }
  });
}

test('reference data: golden task expectations use different distinctions and retain distractors', () => {
  const state = createReferenceState();
  const inbox = state.call('product_fit_inbox', { queue: 'weekly' }).structuredContent.value;
  assert.equal(inbox.items.length, 6);
  assert.deepEqual(inbox.items.filter(item => item.priority === 'urgent' && item.state === 'open').map(item => item.id),
    ['notice-02', 'notice-05']);
  const overview = state.call('product_fit_document', { document: 'overview' }).structuredContent.value;
  const deployment = state.call('product_fit_document', { document: 'deployment' }).structuredContent.value;
  assert.equal(overview.minimumNodeMajor, 22);
  assert.equal(deployment.minimumNodeMajor, 20);
  assert.equal(overview.port, deployment.port);
  assert.equal(overview.storage, deployment.storage);
  const catalog = state.call('product_fit_page', { page: 'catalog' }).structuredContent.value;
  const status = state.call('product_fit_page', { page: 'status' }).structuredContent.value;
  assert.deepEqual(catalog.items.filter(item => item.listed && status.items.find(entry => entry.id === item.id)?.available)
    .map(item => item.id), ['green-kit']);
});

for (const args of [undefined, null, [], {}, { queue: 'wrong' }, { queue: 1 }, { queue: 'weekly', path: '/private' },
  { queue: 'weekly', url: 'https://private.invalid' }, { queue: 'weekly', command: 'do-not-execute' }]) {
  test(`reference data: rejected input ${JSON.stringify(args)} has no accepted call or disclosed argument`, () => {
    const state = createReferenceState();
    const result = state.call('product_fit_inbox', args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'invalid-arguments');
    const receipt = state.receipt();
    assert.equal(receipt.toolCalls, 1);
    assert.equal(receipt.acceptedCalls, 0);
    assert.equal(receipt.recentCalls[0].argumentsSha256, null);
    assert.ok(!JSON.stringify([result, receipt]).includes('private'));
    assert.ok(!JSON.stringify([result, receipt]).includes('do-not-execute'));
  });
}

test('reference data: unknown tool names are counted without retaining their submitted value', () => {
  const state = createReferenceState();
  const result = state.call('secret-unknown-tool', { credential: 'private' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, 'unknown-tool');
  assert.equal(state.receipt().recentCalls[0].tool, 'unknown');
  assert.ok(!JSON.stringify([result, state.receipt()]).includes('secret-unknown-tool'));
  assert.ok(!JSON.stringify([result, state.receipt()]).includes('private'));
});

test('reference data: fresh markers and defensive copies prevent answer replay and fixture mutation', () => {
  const state = createReferenceState();
  const first = state.call('product_fit_inbox', { queue: 'weekly' }).structuredContent;
  first.value.items[0].id = 'mutated';
  const second = state.call('product_fit_inbox', { queue: 'weekly' }).structuredContent;
  assert.equal(second.value.items[0].id, 'notice-01');
  assert.notEqual(first.receiptPhrase, second.receiptPhrase);
  assert.notEqual(first.runId, createReferenceState().receipt().runId);
  const receipt = state.receipt();
  receipt.recentCalls.length = 0;
  receipt.byTool.product_fit_inbox = 100;
  assert.equal(state.receipt().recentCalls.length, 2);
  assert.equal(state.receipt().byTool.product_fit_inbox, 2);
});

test('reference data: the latest 64 receipts retain cumulative counters and declare dropped observations', () => {
  const state = createReferenceState();
  for (let i = 0; i < 70; i += 1) state.call('product_fit_inbox', { queue: 'weekly' });
  state.call('unknown', {});
  const receipt = state.receipt();
  assert.equal(receipt.toolCalls, 71);
  assert.equal(receipt.acceptedCalls, 70);
  assert.equal(receipt.rejectedCalls, 1);
  assert.equal(receipt.droppedCalls, 7);
  assert.equal(receipt.recentCalls.length, 64);
  assert.equal(receipt.recentCalls[0].sequence, 8);
  assert.equal(receipt.recentCalls.at(-1).sequence, 71);
});

for (const [label, change] of [
  ['different process', input => { input.fixtureReceipt.runId = createReferenceState().receipt().runId; }],
  ['changed definition', input => { input.fixtureReceipt.definitionSha256 = 'a'.repeat(64); }],
  ['altered result', input => { input.toolResults[0].value.items[0].id = 'altered'; }],
  ['altered marker', input => { input.toolResults[0].receiptPhrase = `reference-${createReferenceState().receipt().runId}`; }],
  ['missing result', input => { input.toolResults = []; }],
  ['duplicate document selection', input => { input.toolResults[1] = input.toolResults[0]; }],
  ['dropped witness', input => { input.fixtureReceipt.recentCalls = []; }],
  ['changed counter', input => { input.fixtureReceipt.acceptedCalls += 1; }],
  ['wrong arguments digest', input => { input.fixtureReceipt.recentCalls[0].argumentsSha256 = 'b'.repeat(64); }],
  ['invalid observation time', input => { input.fixtureReceipt.recentCalls[0].observedAt = 'not-a-date'; }],
  ['human claim', input => { input.fixtureReceipt.claims.humanObservation = true; }],
  ['extra private field', input => { input.secret = 'private'; }],
]) {
  test(`reference checker: rejects ${label} rather than accepting an answer without its witness`, () => {
    const input = packet(label === 'duplicate document selection' ? 'document-check' : 'inbox-triage');
    change(input);
    assert.throws(() => checkReferenceResult(input), /^Error: Invalid reference packet;/);
  });
}

test('reference checker: missing answer marker and a wrong answer produce distinct failed checks', () => {
  const input = packet();
  input.answer.receiptPhrases = [];
  assert.deepEqual(checkReferenceResult(input).checks, { answerMatches: true, receiptsMatch: false });
  input.answer.receiptPhrases = [input.toolResults[0].receiptPhrase];
  input.answer.ids = ['notice-03'];
  assert.deepEqual(checkReferenceResult(input).checks, { answerMatches: false, receiptsMatch: true });
  assert.equal(checkReferenceResult(input).result, 'fail');
});

test('reference checker: retained calls cannot exceed their cumulative per-tool counters', () => {
  const input = packet('document-check');
  input.fixtureReceipt.acceptedCalls = 1;
  input.fixtureReceipt.rejectedCalls = 1;
  input.fixtureReceipt.byTool.product_fit_document = 1;
  assert.throws(() => checkReferenceResult(input), /^Error: Invalid reference packet;/);
});

test('reference checker: JSON property ordering is irrelevant, but array ordering follows the task contract', () => {
  const input = packet('document-check');
  input.toolResults = input.toolResults.map(result => Object.fromEntries(Object.entries(result).reverse()));
  input.answer.differences = [{ deployment: 20, overview: 22, field: 'minimumNodeMajor' }];
  assert.equal(checkReferenceResult(input).result, 'pass');
  const inbox = packet();
  inbox.answer.ids.reverse();
  assert.equal(checkReferenceResult(inbox).result, 'fail');
});

test('reference checker CLI: hashes the captured packet and checker, withholds malformed/oversize content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flujo-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'packet.json');
  const bytes = JSON.stringify(packet());
  await writeFile(inputPath, bytes);
  const run = () => spawnSync(process.execPath, [checker, inputPath], { encoding: 'utf8', timeout: 5000 });
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  const report = JSON.parse(passed.stdout);
  assert.equal(report.inputSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.match(report.toolSha256.checker, /^[a-f0-9]{64}$/);
  assert.match(report.toolSha256.data, /^[a-f0-9]{64}$/);
  assert.equal(report.claims.modelOriginVerified, false);
  const wrong = packet();
  wrong.answer.ids = [];
  await writeFile(inputPath, JSON.stringify(wrong));
  assert.equal(run().status, 1);
  for (const bad of ['{"secret":"NEVER-PRINT"', 'NEVER-PRINT'.repeat(4000)]) {
    await writeFile(inputPath, bad);
    const rejected = run();
    assert.equal(rejected.status, 2);
    assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes('NEVER-PRINT'));
  }
});

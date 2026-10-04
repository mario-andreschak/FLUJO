import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { stateSelections, syntheticState, assertSyntheticState, validateSyntheticStateReceipt,
  readStateZipJson, verifySyntheticStateArchive, canonicalFlowInventory, assertFlowInventory, validateFlowInventoryReceipt,
  readFlowInventory, seedSyntheticState, mutateSyntheticState, readSyntheticState,
  assertFreshSyntheticState, restoreSyntheticState, invalidSyntheticStateArchives } from './maintainer-synthetic-state.mjs';

const JSZip = createRequire(import.meta.url)('jszip');
const conversationPath = 'storage/conversations/maintainer_drill_conversation.json';
const variable = 'FLUJO_MAINTAINER_LABEL';
const copy = value => JSON.parse(JSON.stringify(value));
function archive(state = syntheticState(), selections = stateSelections) {
  const zip = new JSZip(); zip.file('backup-info.json', JSON.stringify({ selections }));
  zip.file('storage/flows.json', JSON.stringify([{ id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] }]));
  zip.file('storage/theme.json', JSON.stringify(state.theme));
  zip.file('storage/global_env_vars.json', JSON.stringify({ [variable]: state.environment }));
  const conversation = { ...state.conversation, conversationId: state.conversation.id, updatedAt: 99, trackingInfo: {} }; delete conversation.id;
  zip.file(conversationPath, JSON.stringify(conversation)); zip.file('storage/history.json', '[]'); return zip;
}

test('all conversation messages, stable metadata and non-secret configuration must match the prescribed state', () => {
  assertSyntheticState(syntheticState());
  for (const alter of [value => { value.theme = 'light'; }, value => { value.environment.value = 'changed'; },
    value => { value.environment.metadata.isSecret = true; }, value => { value.conversation.title = 'changed'; },
    value => { value.conversation.requireApproval = false; }, value => { value.conversation.status = 'running'; },
    value => { value.conversation.messages.pop(); }, value => { value.conversation.messages.reverse(); },
    value => { value.conversation.messages[0].content = 'changed'; }, value => { value.conversation.messages[1].role = 'user'; },
    value => { value.privateIdentity = 'unrelated'; }]) {
    const observed = syntheticState(); alter(observed); assert.throws(() => assertSyntheticState(observed), /Synthetic/);
  }
});

test('retained state requires exact profile, verified provenance and unchanged hashed original bytes', () => {
  const bytes = Buffer.from(JSON.stringify(syntheticState()));
  const receipt = { provenanceSignatureVerified: true, syntheticState: { schemaVersion: 1, original: 'original-state.json', verified: true, selections: [...stateSelections] },
    evidence: [{ path: 'original-state.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  assert.deepEqual(validateSyntheticStateReceipt(receipt, bytes), syntheticState());
  for (const alter of [value => { value.provenanceSignatureVerified = false; }, value => { value.syntheticState.verified = false; },
    value => { value.syntheticState.original = '../outside'; }, value => { value.syntheticState.selections.pop(); },
    value => { value.evidence = []; }, value => { value.evidence[0].sha256 = 'f'.repeat(64); }]) {
    const changed = copy(receipt); alter(changed); assert.throws(() => validateSyntheticStateReceipt(changed, bytes), /differ/);
  }
  assert.throws(() => validateSyntheticStateReceipt(receipt, Buffer.from('{}')), /differ/);
});

test('archives require every selected record and reject changed content, ownership, aliases and unrelated/private files', async () => {
  const valid = await archive().generateAsync({ type: 'nodebuffer' });
  assert.equal((await verifySyntheticStateArchive(valid, JSZip)).passed, true);
  for (const change of [zip => { zip.remove(conversationPath); }, zip => { zip.file('storage/theme.json', '"light"'); },
    zip => { zip.file('storage/global_env_vars.json', JSON.stringify({ [variable]: syntheticState().environment, API_KEY: 'synthetic-extra' })); },
    zip => { zip.file('storage/models.json', '[]'); }, zip => { zip.file('storage/encryption_key.json', '"synthetic-extra"'); },
    zip => { zip.file('../storage/theme.json', '"dark"'); }, zip => { zip.file('storage/history.json', '[{"id":"unrelated"}]'); },
    zip => { zip.file('backup-info.json', JSON.stringify({ selections: ['flows'] })); },
    zip => { zip.file(conversationPath, JSON.stringify({ ...syntheticState().conversation, conversationId: 'maintainer_drill_conversation', personaOwned: true })); },
    zip => { zip.file(conversationPath, JSON.stringify({ ...syntheticState().conversation, conversationId: 'maintainer_drill_conversation', messages: [] })); }]) {
    const zip = archive(); change(zip); await assert.rejects(verifySyntheticStateArchive(await zip.generateAsync({ type: 'nodebuffer' }), JSZip));
  }
});

test('compressed oversized members are bounded by emitted bytes and malformed JSON never passes', async () => {
  for (const contents of ['not json', JSON.stringify('x'.repeat(1024 * 1024 + 1))]) {
    const zip = new JSZip(); zip.file('state.json', contents);
    const compressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const loaded = await JSZip.loadAsync(compressed);
    await assert.rejects(readStateZipJson(loaded, 'state.json'), /JSON|1 MiB/);
  }
  await assert.rejects(verifySyntheticStateArchive(Buffer.alloc(16 * 1024 * 1024 + 1), JSZip), /16 MiB/);
  assert.throws(() => readStateZipJson(new JSZip(), 'missing.json'), /omitted/);
});

test('raw exports must retain and compare the complete seeded and created flow inventory', async () => {
  const zip = archive(); const flows = await readStateZipJson(zip, 'storage/flows.json');
  const seeded = { id: 'default-agent-flujo', name: 'Public seeded agent', favorite: true,
    nodes: [{ id: 'not-executed', data: { label: 'Public seeded content' } }], edges: [], createdAt: 1, updatedAt: 2 };
  zip.file('storage/flows.json', JSON.stringify([seeded, ...flows]));
  const raw = await zip.generateAsync({ type: 'nodebuffer' }); const before = Buffer.from(raw);
  const expected = [seeded, ...flows];
  const verified = await verifySyntheticStateArchive(raw, JSZip, syntheticState(), expected);
  assert.deepEqual(raw, before); assert.equal(verified.passed, true);
  assert.deepEqual(verified.flowInventory.ids, ['default-agent-flujo', 'maintainer_drill_flow']);
  assert.deepEqual(await readStateZipJson(await JSZip.loadAsync(raw), 'storage/flows.json'), expected);
  for (const change of [value => value.shift(), value => value.pop(), value => value.push(copy(value[0])),
    value => { value[0].nodes[0].data.label = 'corrupted'; }, value => { value[0].favorite = false; },
    value => { value.push({ ...seeded, id: 'unrelated-private-flow' }); }]) {
    const changed = archive(); const inventory = copy(expected); change(inventory);
    changed.file('storage/flows.json', JSON.stringify(inventory));
    await assert.rejects(verifySyntheticStateArchive(await changed.generateAsync({ type: 'nodebuffer' }), JSZip, syntheticState(), expected));
  }
  const aliased = archive(); aliased.file('storage/flows.json', JSON.stringify([seeded, ...flows])); aliased.file('../storage/theme.json', '"dark"');
  await assert.rejects(verifySyntheticStateArchive(await aliased.generateAsync({ type: 'nodebuffer' }), JSZip, syntheticState(), expected), /aliased/);
});

test('flow comparison permits only collection order and top-level server timestamps to vary', () => {
  const seeded = { id: 'default-agent-flujo', name: 'Public seeded agent', favorite: true,
    nodes: [{ id: 'node', data: { label: 'preserved', timestamp: 17 } }], edges: [{ id: 'edge', source: 'node', target: 'node' }],
    createdAt: 1, updatedAt: 2, extraStableField: 'retained' };
  const fixture = { id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] };
  const expected = [seeded, fixture];
  assertFlowInventory([{ ...fixture, updatedAt: 999 }, { ...seeded, createdAt: 9, updatedAt: 10 }], expected);
  for (const alter of [value => { value[0].nodes[0].data.timestamp++; }, value => { value[0].edges[0].target = 'changed'; },
    value => { value[0].extraStableField = 'changed'; }, value => { delete value[0].favorite; },
    value => { value[0].personaOwnership = false; }, value => { value[1].nodes.push({ id: 'runnable' }); },
    value => { value[0].id = '../unrelated'; }]) {
    const changed = copy(expected); alter(changed); assert.throws(() => assertFlowInventory(changed, expected));
  }
  assert.deepEqual(canonicalFlowInventory([seeded], false).map(flow => flow.id), ['default-agent-flujo']);
  assert.throws(() => canonicalFlowInventory(expected, false), /presence/);
  assert.throws(() => canonicalFlowInventory([], true), /presence/);
});

test('complete inventory receipts bind original and initial snapshots and refuse historical partial receipts', () => {
  const seeded = { id: 'default-agent-flujo', name: 'Public seeded agent', nodes: [{ id: 'preserved' }], edges: [] };
  const fixture = { id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] };
  const original = Buffer.from(JSON.stringify([seeded, fixture])); const initial = Buffer.from(JSON.stringify([seeded]));
  const receipt = { provenanceSignatureVerified: true,
    flowInventory: { schemaVersion: 1, original: 'original-flows.json', initial: 'initial-flows.json', verified: true,
      archiveIncludesAllFlows: true, ignoredFields: ['createdAt', 'updatedAt'], ids: ['default-agent-flujo', 'maintainer_drill_flow'] },
    evidence: [['original-flows.json', original], ['initial-flows.json', initial]].map(([name, bytes]) => ({
      path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  assert.deepEqual(validateFlowInventoryReceipt(receipt, original, initial).original, [seeded, fixture]);
  for (const alter of [value => { delete value.flowInventory; }, value => { value.flowInventory.verified = false; },
    value => { value.flowInventory.ids.shift(); }, value => { value.flowInventory.ignoredFields.push('nodes'); },
    value => { value.flowInventory.archiveIncludesAllFlows = false; }, value => { value.flowInventory.initial = '../outside'; },
    value => { value.evidence.pop(); }, value => { value.provenanceSignatureVerified = false; }]) {
    const changed = copy(receipt); alter(changed); assert.throws(() => validateFlowInventoryReceipt(changed, original, initial), /inventory/);
  }
  const changedInitial = Buffer.from(JSON.stringify([{ ...seeded, name: 'different baseline seed' }]));
  const rehashed = copy(receipt); rehashed.evidence[1].bytes = changedInitial.length;
  rehashed.evidence[1].sha256 = createHash('sha256').update(changedInitial).digest('hex');
  assert.throws(() => validateFlowInventoryReceipt(rehashed, original, changedInitial), /inventory differs/);
});

test('inventory reads require exact status and reject unexpected fresh-root or private membership', async () => {
  const seeded = { id: 'default-agent-flujo', name: 'Public seeded agent', nodes: [], edges: [] };
  const respond = (status, body) => async route => {
    assert.equal(route, '/api/flow'); return { status, bytes: Buffer.from(JSON.stringify(body)) };
  };
  assert.deepEqual(await readFlowInventory(respond(200, [seeded]), false), [seeded]);
  await assert.rejects(readFlowInventory(respond(500, []), false), /expected 200/);
  await assert.rejects(readFlowInventory(respond(200, [{ ...seeded, id: 'private-flow' }]), false), /unrelated/);
});

function protocol() {
  const calls = []; const captures = []; let state = { theme: null, environment: {}, conversation: null };
  const response = (status, body) => ({ status, bytes: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)) });
  const request = async (route, options = {}) => {
    const method = options.method ?? 'GET'; calls.push({ route, method });
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    if (method === 'GET') {
      if (route === '/api/storage?key=theme') return response(200, { value: state.theme });
      if (route === `/api/env?key=${variable}`) return response(200, state.environment);
      if (route === '/v1/chat/conversations/maintainer_drill_conversation') return state.conversation ? response(200, state.conversation) : response(404, {});
    }
    if (route === '/api/storage' && method === 'POST') { assert.equal(body.key, 'theme'); state.theme = body.value; return response(200, {}); }
    if (route === '/api/env' && method === 'POST') { assert.equal(body.key, variable); state.environment = { value: body.value, metadata: body.metadata }; return response(200, {}); }
    if (route === '/v1/chat/conversations' && method === 'POST') {
      state.conversation = { id: body.id, title: body.title, flowId: body.flowId, createdAt: body.createdAt, requireApproval: false, messages: [] }; return response(201, state.conversation);
    }
    if (route === '/v1/chat/conversations/maintainer_drill_conversation' && method === 'PATCH') { state.conversation.title = body.title; return response(200, {}); }
    if (route === '/api/backup') {
      const zip = archive(state, body.selections); return response(200, await zip.generateAsync({ type: 'nodebuffer' }));
    }
    if (route === '/api/restore') {
      const bytes = Buffer.from(await options.body.get('file').arrayBuffer()); const zip = await JSZip.loadAsync(bytes);
      if (!zip.file('backup-info.json')) return response(400, {});
      const record = await readStateZipJson(zip, conversationPath);
      if (record.personaOwned) return response(400, {});
      const selections = JSON.parse(options.body.get('selections'));
      if (selections.includes('settings')) state.theme = await readStateZipJson(zip, 'storage/theme.json');
      if (selections.includes('globalEnvVars')) state.environment = (await readStateZipJson(zip, 'storage/global_env_vars.json'))[variable];
      if (selections.includes('chatHistory')) { state.conversation = { ...record, id: record.conversationId }; delete state.conversation.conversationId; }
      return response(200, {});
    }
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  };
  return { calls, captures, request, capture: async (name, bytes) => captures.push({ name, bytes: Buffer.from(bytes) }),
    change: callback => callback(state) };
}

test('seed/read/mutate/restore protocol preserves both inert messages and uses no execution/provider routes', async () => {
  const fixture = protocol(); await assertFreshSyntheticState(fixture.request);
  await seedSyntheticState(fixture.request, fixture.capture, JSZip);
  const observed = await readSyntheticState(fixture.request); assertSyntheticState(observed);
  const original = await fixture.request('/api/backup', { method: 'POST', body: JSON.stringify({ selections: stateSelections }) });
  await verifySyntheticStateArchive(original.bytes, JSZip);
  await mutateSyntheticState(fixture.request); assertSyntheticState(await readSyntheticState(fixture.request), syntheticState(true));
  for (const invalid of await invalidSyntheticStateArchives(original.bytes, JSZip)) {
    assert.equal((await restoreSyntheticState(fixture.request, invalid.bytes)).status, 400);
    assertSyntheticState(await readSyntheticState(fixture.request), syntheticState(true));
  }
  assert.equal((await restoreSyntheticState(fixture.request, original.bytes)).status, 200);
  assertSyntheticState(await readSyntheticState(fixture.request));
  assert.ok(fixture.calls.every(item => !/respond|run|model|persona|planned-executions/.test(item.route)));
  assert.deepEqual(fixture.captures.map(item => item.name), ['conversation-seed-export.zip', 'conversation-seed-import.zip', 'original-state.json']);
});

test('fresh-root and readable-state checks refuse partial presence, wrong status and ownership-bearing data', async () => {
  for (const change of [state => { state.theme = 'dark'; }, state => { state.environment = syntheticState().environment; }]) {
    const fixture = protocol(); fixture.change(change); await assert.rejects(assertFreshSyntheticState(fixture.request), /already/);
  }
  const fixture = protocol(); await seedSyntheticState(fixture.request, fixture.capture, JSZip);
  fixture.change(state => { state.conversation.personaOwned = true; });
  await assert.rejects(readSyntheticState(fixture.request), /ownership/);
  await assert.rejects(readSyntheticState(async () => ({ status: 500, bytes: Buffer.from('{}') })), /expected 200/);
});

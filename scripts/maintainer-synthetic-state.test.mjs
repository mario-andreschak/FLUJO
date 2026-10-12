import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { stateSelections, conversationComparisonProfile, syntheticState, assertSyntheticSeed, assertSyntheticState,
  mutatedSyntheticState, validateSyntheticStateReceipt,
  readStateZipJson, verifySyntheticStateArchive, canonicalFlowInventory, assertFlowInventory, validateFlowInventoryReceipt,
  readFlowInventory, seedSyntheticState, mutateSyntheticState, readSyntheticState,
  assertFreshSyntheticState, restoreSyntheticState, invalidSyntheticStateArchives } from './maintainer-synthetic-state.mjs';

const JSZip = createRequire(import.meta.url)('jszip');
const conversationPath = 'storage/conversations/maintainer_drill_conversation.json';
const variable = 'FLUJO_MAINTAINER_LABEL';
const copy = value => JSON.parse(JSON.stringify(value));
function apiConversation(record) {
  return { id: record.conversationId, title: record.title, flowId: record.flowId, createdAt: record.createdAt,
    updatedAt: record.updatedAt, requireApproval: record.requireApproval ?? false, ...(record.status ? { status: record.status } : {}),
    messages: copy(record.messages), parentConversationId: record.parentConversationId ?? null, rootConversationId: record.rootConversationId ?? null,
    transcriptWindow: { truncated: false, loadedCount: record.messages.length, totalCount: record.messages.length, source: 'snapshot' } };
}
function observedState() {
  const fixture = syntheticState(); const conversationArchive = { ...copy(fixture.conversation),
    conversationId: fixture.conversation.id, updatedAt: fixture.conversation.createdAt, source: 'chat',
    trackingInfo: { executionId: 'exec-synthetic-created-once', startTime: 1700000000010, nodeExecutionTracker: [] } };
  delete conversationArchive.id;
  return { theme: fixture.theme, environment: copy(fixture.environment), conversation: apiConversation(conversationArchive), conversationArchive };
}
function archive(state = observedState(), selections = stateSelections) {
  const zip = new JSZip(); zip.file('backup-info.json', JSON.stringify({ selections }));
  if (selections.includes('flows')) zip.file('storage/flows.json', JSON.stringify([{ id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] }]));
  if (selections.includes('settings')) zip.file('storage/theme.json', JSON.stringify(state.theme));
  if (selections.includes('globalEnvVars')) zip.file('storage/global_env_vars.json', JSON.stringify({ [variable]: state.environment }));
  if (selections.includes('chatHistory')) {
    zip.file(conversationPath, JSON.stringify(state.conversationArchive)); zip.file('storage/history.json', '[]');
  }
  return zip;
}

test('all conversation messages, stable metadata and non-secret configuration must match the prescribed state', () => {
  const expected = observedState(); assertSyntheticSeed(expected); assertSyntheticState(expected, copy(expected));
  for (const alter of [value => { value.theme = 'light'; }, value => { value.environment.value = 'changed'; },
    value => { value.environment.metadata.isSecret = true; }, value => { value.conversation.title = 'changed'; },
    value => { value.conversation.requireApproval = false; }, value => { value.conversation.status = 'running'; },
    value => { value.conversation.messages.pop(); }, value => { value.conversation.messages.reverse(); },
    value => { value.conversation.messages[0].content = 'changed'; }, value => { value.conversation.messages[1].role = 'user'; },
    value => { value.privateIdentity = 'unrelated'; }]) {
    const observed = copy(expected); alter(observed); assert.throws(() => assertSyntheticState(observed, expected), /Synthetic/);
  }
});

test('complete API and archive observations preserve unknown metadata, nested values and timestamp fields', async () => {
  const expected = observedState();
  expected.conversation.apiOnly = { nested: ['retained', { updatedAt: 11 }] };
  expected.conversation.systemMessage = 'Synthetic durable instruction; never executed';
  expected.conversationArchive.systemMessage = 'Synthetic durable instruction; never executed';
  expected.conversationArchive.extraMetadata = { timestamp: 12, nested: ['first', 'second'] };
  assertSyntheticSeed(expected); assertSyntheticState(copy(expected), expected);
  assert.equal((await verifySyntheticStateArchive(await archive(expected).generateAsync({ type: 'nodebuffer' }), JSZip, expected)).passed, true);
  for (const alter of [value => { value.conversation.apiOnly.nested[1].updatedAt++; },
    value => { value.conversation.newUnknownField = 'unexpected'; }, value => { delete value.conversation.apiOnly; },
    value => { value.conversation.systemMessage = 'corrupted'; },
    value => { value.conversationArchive.systemMessage = 'corrupted'; }, value => { delete value.conversationArchive.systemMessage; },
    value => { value.conversationArchive.extraMetadata.nested.reverse(); },
    value => { value.conversationArchive.newUnknownField = 'unexpected'; }, value => { delete value.conversationArchive.extraMetadata; },
    value => { value.conversationArchive.trackingInfo.executionId = 'regenerated'; },
    value => { value.conversationArchive.trackingInfo.startTime++; },
    value => { value.conversationArchive.trackingInfo.nodeExecutionTracker.push({ id: 'unexpected-execution' }); },
    value => { value.conversation.updatedAt++; value.conversationArchive.updatedAt++; },
    value => { value.conversation.parentConversationId = 'changed'; value.conversationArchive.parentConversationId = 'changed'; },
    value => { value.conversation.rootConversationId = 'changed'; value.conversationArchive.rootConversationId = 'changed'; }]) {
    const changed = copy(expected); alter(changed); assert.throws(() => assertSyntheticState(changed, expected), /Synthetic/);
    if (JSON.stringify(changed.conversationArchive) !== JSON.stringify(expected.conversationArchive)) {
      await assert.rejects(verifySyntheticStateArchive(await archive(changed).generateAsync({ type: 'nodebuffer' }), JSZip, expected), /Synthetic/);
    }
  }
});

test('explicit cross-view aliases, null defaults and derived windows retain raw presence and exact metadata', () => {
  const absent = observedState(); assertSyntheticSeed(absent);
  const explicit = copy(absent); explicit.conversationArchive.parentConversationId = null; explicit.conversationArchive.rootConversationId = null;
  explicit.conversationArchive.id = explicit.conversation.id; explicit.conversation.conversationId = explicit.conversation.id;
  assertSyntheticSeed(explicit); assertSyntheticState(explicit, copy(explicit));
  assert.throws(() => assertSyntheticState(explicit, absent), /differs/);
  const linked = copy(absent);
  for (const key of ['parentConversationId', 'rootConversationId']) {
    linked.conversation[key] = `synthetic-${key}`; linked.conversationArchive[key] = linked.conversation[key];
  }
  assertSyntheticSeed(linked); assertSyntheticState(linked, copy(linked));
  const reordered = copy(absent); reordered.conversation = Object.fromEntries(Object.entries(reordered.conversation).reverse());
  assertSyntheticState(reordered, absent);
  for (const alter of [value => { value.conversationArchive.conversationId = 'wrong'; }, value => { value.conversationArchive.id = 'wrong'; },
    value => { value.conversation.conversationId = 'wrong'; }, value => { delete value.conversation.id; },
    value => { delete value.conversation.parentConversationId; }, value => { delete value.conversation.rootConversationId; },
    value => { value.conversation.transcriptWindow.loadedCount--; }, value => { value.conversation.transcriptWindow.totalCount++; },
    value => { value.conversation.transcriptWindow.truncated = true; }, value => { value.conversation.transcriptWindow.source = 'durable-log'; },
    value => { value.conversation.transcriptWindow.unlisted = 'corrupt'; }, value => { delete value.conversation.transcriptWindow; }]) {
    const changed = copy(absent); alter(changed); assert.throws(() => assertSyntheticState(changed, absent), /Synthetic/);
  }
});

test('retained state requires exact profile, verified provenance and unchanged hashed original bytes', () => {
  const original = observedState(); const bytes = Buffer.from(JSON.stringify(original));
  const receipt = { provenanceSignatureVerified: true, syntheticState: { schemaVersion: 2, original: 'original-state.json', verified: true,
    conversationComparison: conversationComparisonProfile, selections: [...stateSelections] },
    evidence: [{ path: 'original-state.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  assert.deepEqual(validateSyntheticStateReceipt(receipt, bytes), original);
  for (const alter of [value => { value.provenanceSignatureVerified = false; }, value => { value.syntheticState.verified = false; },
    value => { value.syntheticState.original = '../outside'; }, value => { value.syntheticState.selections.pop(); },
    value => { value.evidence = []; }, value => { value.evidence[0].sha256 = 'f'.repeat(64); },
    value => { value.syntheticState.schemaVersion = 1; }, value => { delete value.syntheticState.conversationComparison; },
    value => { value.syntheticState.conversationComparison.ignoredFields.push('systemMessage'); }]) {
    const changed = copy(receipt); alter(changed); assert.throws(() => validateSyntheticStateReceipt(changed, bytes), /differ/);
  }
  assert.throws(() => validateSyntheticStateReceipt(receipt, Buffer.from('{}')), /differ/);
  const partial = Buffer.from(JSON.stringify(syntheticState())); const rehashed = copy(receipt);
  rehashed.evidence[0] = { path: 'original-state.json', bytes: partial.length, sha256: createHash('sha256').update(partial).digest('hex') };
  assert.throws(() => validateSyntheticStateReceipt(rehashed, partial), /Synthetic state/);
});

test('archives require every selected record and reject changed content, ownership, aliases and unrelated/private files', async () => {
  const valid = await archive().generateAsync({ type: 'nodebuffer' });
  assert.equal((await verifySyntheticStateArchive(valid, JSZip, observedState())).passed, true);
  for (const change of [zip => { zip.remove(conversationPath); }, zip => { zip.file('storage/theme.json', '"light"'); },
    zip => { zip.file('storage/global_env_vars.json', JSON.stringify({ [variable]: syntheticState().environment, API_KEY: 'synthetic-extra' })); },
    zip => { zip.file('storage/models.json', '[]'); }, zip => { zip.file('storage/encryption_key.json', '"synthetic-extra"'); },
    zip => { zip.file('../storage/theme.json', '"dark"'); }, zip => { zip.file('storage/history.json', '[{"id":"unrelated"}]'); },
    zip => { zip.file('backup-info.json', JSON.stringify({ selections: ['flows'] })); },
    zip => { zip.file(conversationPath, JSON.stringify({ ...syntheticState().conversation, conversationId: 'maintainer_drill_conversation', personaOwned: true })); },
    zip => { zip.file(conversationPath, JSON.stringify({ ...syntheticState().conversation, conversationId: 'maintainer_drill_conversation', messages: [] })); }]) {
    const zip = archive(); change(zip); await assert.rejects(verifySyntheticStateArchive(await zip.generateAsync({ type: 'nodebuffer' }), JSZip, observedState()));
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
  const verified = await verifySyntheticStateArchive(raw, JSZip, observedState(), expected);
  assert.deepEqual(raw, before); assert.equal(verified.passed, true);
  assert.deepEqual(verified.flowInventory.ids, ['default-agent-flujo', 'maintainer_drill_flow']);
  assert.deepEqual(await readStateZipJson(await JSZip.loadAsync(raw), 'storage/flows.json'), expected);
  for (const change of [value => value.shift(), value => value.pop(), value => value.push(copy(value[0])),
    value => { value[0].nodes[0].data.label = 'corrupted'; }, value => { value[0].favorite = false; },
    value => { value.push({ ...seeded, id: 'unrelated-private-flow' }); }]) {
    const changed = archive(); const inventory = copy(expected); change(inventory);
    changed.file('storage/flows.json', JSON.stringify(inventory));
    await assert.rejects(verifySyntheticStateArchive(await changed.generateAsync({ type: 'nodebuffer' }), JSZip, observedState(), expected));
  }
  const aliased = archive(); aliased.file('storage/flows.json', JSON.stringify([seeded, ...flows])); aliased.file('../storage/theme.json', '"dark"');
  await assert.rejects(verifySyntheticStateArchive(await aliased.generateAsync({ type: 'nodebuffer' }), JSZip, observedState(), expected), /aliased/);
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

function protocol(seedMetadata = {}) {
  const calls = []; const captures = []; const state = { theme: null, environment: {}, conversation: null, conversationArchive: null };
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
      state.conversationArchive = { conversationId: body.id, title: body.title, flowId: body.flowId, createdAt: body.createdAt,
        updatedAt: body.updatedAt, source: 'chat', messages: [], trackingInfo: copy(observedState().conversationArchive.trackingInfo), ...copy(seedMetadata) };
      state.conversation = apiConversation(state.conversationArchive); return response(201, state.conversation);
    }
    if (route === '/v1/chat/conversations/maintainer_drill_conversation' && method === 'PATCH') {
      state.conversation.title = body.title; state.conversationArchive.title = body.title; return response(200, {});
    }
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
      if (selections.includes('chatHistory')) { state.conversationArchive = record; state.conversation = apiConversation(record); }
      return response(200, {});
    }
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  };
  return { calls, captures, request, capture: async (name, bytes) => captures.push({ name, bytes: Buffer.from(bytes) }),
    change: callback => callback(state) };
}

test('seed/read/mutate/restore protocol preserves both inert messages and uses no execution/provider routes', async () => {
  const fixture = protocol(); await assertFreshSyntheticState(fixture.request);
  const originalState = await seedSyntheticState(fixture.request, fixture.capture, JSZip);
  const observed = await readSyntheticState(fixture.request, JSZip); assertSyntheticState(observed, originalState);
  const original = await fixture.request('/api/backup', { method: 'POST', body: JSON.stringify({ selections: stateSelections }) });
  await verifySyntheticStateArchive(original.bytes, JSZip, originalState);
  const mutated = await mutateSyntheticState(fixture.request, JSZip, originalState);
  assert.deepEqual(mutated, mutatedSyntheticState(originalState));
  assertSyntheticState(await readSyntheticState(fixture.request, JSZip), mutated);
  for (const invalid of await invalidSyntheticStateArchives(original.bytes, JSZip)) {
    assert.equal((await restoreSyntheticState(fixture.request, invalid.bytes)).status, 400);
    assertSyntheticState(await readSyntheticState(fixture.request, JSZip), mutated);
  }
  assert.equal((await restoreSyntheticState(fixture.request, original.bytes)).status, 200);
  assertSyntheticState(await readSyntheticState(fixture.request, JSZip), originalState);
  assert.ok(fixture.calls.every(item => !/respond|run|model|persona|planned-executions/.test(item.route)));
  assert.deepEqual(fixture.captures.map(item => item.name), ['conversation-seed-export.zip', 'conversation-seed-import.zip', 'original-state.json']);
});

test('independent seed export and later readbacks preserve stored fields absent from the finite GET response', async () => {
  const metadata = { systemMessage: 'Synthetic preserved instruction; never executed', durableOnly: { nested: ['first', 'second'] } };
  const fixture = protocol(metadata); const original = await seedSyntheticState(fixture.request, fixture.capture, JSZip);
  assert.equal(Object.hasOwn(original.conversation, 'systemMessage'), false);
  assert.equal(original.conversationArchive.systemMessage, metadata.systemMessage);
  const backup = await fixture.request('/api/backup', { method: 'POST', body: JSON.stringify({ selections: stateSelections }) });
  await mutateSyntheticState(fixture.request, JSZip, original);
  assert.equal((await restoreSyntheticState(fixture.request, backup.bytes)).status, 200);
  assertSyntheticState(await readSyntheticState(fixture.request, JSZip), original);
  const corrupted = protocol(metadata);
  const request = async (route, options) => {
    const result = await corrupted.request(route, options);
    if (route === '/api/restore') corrupted.change(state => { delete state.conversationArchive.durableOnly; });
    return result;
  };
  await assert.rejects(seedSyntheticState(request, corrupted.capture, JSZip), /complete observed conversation/);
  assert.ok(!corrupted.captures.some(item => item.name === 'original-state.json'));
});

test('fresh-root and readable-state checks refuse partial presence, wrong status and ownership-bearing data', async () => {
  for (const change of [state => { state.theme = 'dark'; }, state => { state.environment = syntheticState().environment; }]) {
    const fixture = protocol(); fixture.change(change); await assert.rejects(assertFreshSyntheticState(fixture.request), /already/);
  }
  const fixture = protocol(); await seedSyntheticState(fixture.request, fixture.capture, JSZip);
  fixture.change(state => { state.conversation.personaOwned = true; });
  await assert.rejects(readSyntheticState(fixture.request, JSZip), /ownership/);
  await assert.rejects(readSyntheticState(async () => ({ status: 500, bytes: Buffer.from('{}') }), JSZip), /expected 200/);
});

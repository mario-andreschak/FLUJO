import { createHash } from 'node:crypto';

export const stateSelections = Object.freeze(['flows', 'chatHistory', 'settings', 'globalEnvVars']);
const conversationId = 'maintainer_drill_conversation';
const flowId = 'maintainer_drill_flow';
const variable = 'FLUJO_MAINTAINER_LABEL';
const conversationPath = `storage/conversations/${conversationId}.json`;
const timestamp = 1700000000000;
const flowTimestampFields = Object.freeze(['createdAt', 'updatedAt']);
export const conversationComparisonProfile = Object.freeze({
  schemaVersion: 1, observations: Object.freeze(['conversation', 'conversationArchive']),
  identityAlias: 'archive.conversationId = api.id',
  nullDefaults: Object.freeze(['parentConversationId', 'rootConversationId']),
  transcriptWindow: 'snapshot; untruncated; loadedCount = totalCount = messages.length',
  ignoredFields: Object.freeze([]),
});
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function syntheticState(mutated = false) {
  return { theme: mutated ? 'light' : 'dark', environment: { value: mutated ? 'Synthetic changed label' : 'Synthetic maintainer label', metadata: { isSecret: false } },
    conversation: { id: conversationId, title: mutated ? 'Deliberately changed synthetic conversation' : 'Synthetic maintainer conversation',
      flowId, createdAt: timestamp, requireApproval: true, status: 'completed', messages: [
        { id: 'maintainer_user_message', role: 'user', content: 'Synthetic archived user text; no execution requested.', timestamp },
        { id: 'maintainer_assistant_message', role: 'assistant', content: 'Synthetic archived assistant text; no provider was called.', timestamp: timestamp + 1 },
      ] } };
}

function assertConversationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ['personaAttribution', 'personaTargetId', 'personaInstructionContext', 'personaId', 'activityId', 'personaOwned', 'personaArchived']
    .some(key => Object.hasOwn(value, key))) throw new Error('Synthetic conversation contains unrelated ownership or missing data.');
}

function assertConversationPair(observed) {
  if (!observed || stable(Object.keys(observed).sort()) !== stable(['conversation', 'conversationArchive', 'environment', 'theme'])
      || Buffer.byteLength(JSON.stringify(observed)) > 1024 * 1024) {
    throw new Error('Synthetic state contains missing or unrelated fields.');
  }
  const api = observed.conversation; const archive = observed.conversationArchive;
  assertConversationRecord(api); assertConversationRecord(archive);
  if (api.id !== conversationId || archive.conversationId !== api.id
      || (Object.hasOwn(api, 'conversationId') && api.conversationId !== api.id)
      || (Object.hasOwn(archive, 'id') && archive.id !== api.id)
      || !Array.isArray(api.messages) || stable(api.messages) !== stable(archive.messages)
      || !Number.isSafeInteger(archive.updatedAt) || archive.updatedAt <= 0 || api.updatedAt !== archive.updatedAt) {
    throw new Error('Synthetic conversation identity, messages or timestamps differ across API and archive.');
  }
  // These are cross-view checks, not fields removed from either retained observation.
  for (const key of conversationComparisonProfile.nullDefaults) {
    if (api[key] !== (archive[key] ?? null)) throw new Error(`Synthetic conversation ${key} default differs across API and archive.`);
  }
  const window = { truncated: false, loadedCount: api.messages.length, totalCount: api.messages.length, source: 'snapshot' };
  if (stable(api.transcriptWindow) !== stable(window)) throw new Error('Synthetic conversation transcriptWindow is not the complete inert snapshot.');
  for (const key of Object.keys(api).filter(key => Object.hasOwn(archive, key))) {
    if (stable(api[key]) !== stable(archive[key])) throw new Error(`Synthetic conversation shared ${key} differs across API and archive.`);
  }
}

/** Verify the prescribed seed while retaining every additional observed field. */
export function assertSyntheticSeed(observed) {
  assertConversationPair(observed); const expected = syntheticState();
  if (stable(observed.theme) !== stable(expected.theme) || stable(observed.environment) !== stable(expected.environment)
      || observed.conversation.updatedAt !== timestamp || observed.conversationArchive.source !== 'chat'
      || typeof observed.conversationArchive.trackingInfo?.executionId !== 'string'
      || !observed.conversationArchive.trackingInfo.executionId
      || !Number.isSafeInteger(observed.conversationArchive.trackingInfo.startTime)
      || observed.conversationArchive.trackingInfo.startTime <= 0
      || stable(observed.conversationArchive.trackingInfo.nodeExecutionTracker) !== stable([])) {
    throw new Error('Synthetic seed configuration or durable creation metadata differs from the prescribed state.');
  }
  for (const [key, value] of Object.entries(expected.conversation)) {
    if (stable(observed.conversation[key]) !== stable(value)
        || stable(observed.conversationArchive[key === 'id' ? 'conversationId' : key]) !== stable(value)) {
      throw new Error(`Synthetic seed conversation ${key} differs from the prescribed state.`);
    }
  }
}

/** Compare complete raw observations; object-key order is the only within-view normalization. */
export function assertSyntheticState(observed, expected) {
  assertConversationPair(observed); assertConversationPair(expected);
  for (const key of ['theme', 'environment', 'conversation', 'conversationArchive']) {
    if (stable(observed?.[key]) !== stable(expected[key])) throw new Error(`Synthetic ${key} differs from the prescribed state.`);
  }
}

export function mutatedSyntheticState(original) {
  const expected = JSON.parse(JSON.stringify(original)); const fixture = syntheticState(true);
  expected.theme = fixture.theme; expected.environment = fixture.environment;
  expected.conversation.title = fixture.conversation.title; expected.conversationArchive.title = fixture.conversation.title;
  return expected;
}

export function validateSyntheticStateReceipt(receipt, bytes) {
  const witness = receipt.evidence?.find(item => item.path === 'original-state.json');
  if (receipt.syntheticState?.schemaVersion !== 2 || receipt.syntheticState.original !== 'original-state.json'
      || receipt.syntheticState.verified !== true || receipt.provenanceSignatureVerified !== true
      || stable(receipt.syntheticState.conversationComparison) !== stable(conversationComparisonProfile)
      || stable(receipt.syntheticState.selections) !== stable(stateSelections)
      || bytes.length > 1024 * 1024 || witness?.bytes !== bytes.length || witness.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error('Synthetic state receipt or original bytes differ from the verified baseline.');
  }
  const observed = JSON.parse(bytes); assertSyntheticSeed(observed); return observed;
}

/** Compare the entire observed flow inventory; only top-level server timestamps vary. */
export function canonicalFlowInventory(flows, requireFixture = true) {
  if (!Array.isArray(flows) || Buffer.byteLength(JSON.stringify(flows)) > 1024 * 1024) {
    throw new Error('Flow inventory must be an array within 1 MiB.');
  }
  const ids = new Set();
  const canonical = flows.map(flow => {
    if (!flow || typeof flow !== 'object' || Array.isArray(flow)
        || ![flowId, 'default-agent-flujo'].includes(flow.id) || ids.has(flow.id)
        || typeof flow.name !== 'string' || !flow.name || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)
        || Object.hasOwn(flow, 'personaOwnership')) throw new Error('Flow inventory contains duplicate, unrelated or invalid flows.');
    ids.add(flow.id);
    if (flow.id === flowId && (flow.nodes.length || flow.edges.length)) throw new Error('Created fixture must remain an empty flow.');
    return Object.fromEntries(Object.entries(flow).filter(([key]) => !flowTimestampFields.includes(key)));
  });
  if (ids.has(flowId) !== requireFixture) throw new Error('Flow inventory has an unexpected created-fixture presence.');
  return canonical.sort((left, right) => left.id.localeCompare(right.id));
}

export function assertFlowInventory(observed, expected, requireFixture = true) {
  if (stable(canonicalFlowInventory(observed, requireFixture)) !== stable(canonicalFlowInventory(expected, requireFixture))) {
    throw new Error('Flow inventory differs from the complete observed baseline.');
  }
}

export function validateFlowInventoryReceipt(receipt, originalBytes, initialBytes) {
  const profile = receipt.flowInventory;
  const originals = [['original-flows.json', originalBytes], ['initial-flows.json', initialBytes]];
  if (profile?.schemaVersion !== 1 || profile.original !== 'original-flows.json' || profile.initial !== 'initial-flows.json'
      || profile.verified !== true || profile.archiveIncludesAllFlows !== true || receipt.provenanceSignatureVerified !== true
      || stable(profile.ignoredFields) !== stable(flowTimestampFields)
      || originals.some(([name, bytes]) => {
        const witness = receipt.evidence?.find(item => item.path === name);
        return !bytes || bytes.length > 1024 * 1024 || witness?.bytes !== bytes.length
          || witness.sha256 !== createHash('sha256').update(bytes).digest('hex');
      })) throw new Error('Flow inventory receipt or original bytes differ from the verified baseline.');
  const original = JSON.parse(originalBytes); const initial = JSON.parse(initialBytes);
  const canonical = canonicalFlowInventory(original);
  if (canonical.find(flow => flow.id === flowId).name !== 'Synthetic maintainer recovery fixture'
      || stable(profile.ids) !== stable(canonical.map(flow => flow.id))) throw new Error('Flow inventory receipt has an invalid fixture or membership.');
  assertFlowInventory(original.filter(flow => flow.id !== flowId), initial, false);
  return { original, initial };
}

async function expect(request, route, status, options) {
  const response = await request(route, options);
  if (response.status !== status) throw new Error(`Synthetic state ${route} returned ${response.status}, expected ${status}.`);
  return response;
}

export async function readFlowInventory(request, requireFixture = true) {
  const flows = JSON.parse((await expect(request, '/api/flow', 200)).bytes);
  canonicalFlowInventory(flows, requireFixture);
  return flows;
}

export async function readSyntheticState(request, JSZip) {
  const theme = JSON.parse((await expect(request, '/api/storage?key=theme', 200)).bytes).value;
  const environment = JSON.parse((await expect(request, `/api/env?key=${variable}`, 200)).bytes);
  const conversation = JSON.parse((await expect(request, `/v1/chat/conversations/${conversationId}`, 200)).bytes);
  const exported = await expect(request, '/api/backup', 200, { method: 'POST', ...json({ selections: ['chatHistory'] }) });
  const zip = await loadStateArchive(exported.bytes, JSZip);
  await assertArchiveSelections(zip, ['chatHistory']);
  const conversationArchive = await readStateZipJson(zip, conversationPath);
  const observed = { theme, environment, conversation, conversationArchive };
  assertConversationPair(observed); return observed;
}

export async function assertFreshSyntheticState(request) {
  await expect(request, `/v1/chat/conversations/${conversationId}`, 404);
  const theme = JSON.parse((await expect(request, '/api/storage?key=theme', 200)).bytes).value;
  const environment = JSON.parse((await expect(request, `/api/env?key=${variable}`, 200)).bytes);
  if (theme !== null || Object.keys(environment).length) throw new Error('Fresh root already contains synthetic configuration.');
}

/** Decompress only expected JSON members and cap actual emitted bytes, never trust ZIP size metadata. */
export function readStateZipJson(zip, name) {
  const file = zip.file(name);
  if (!file) throw new Error(`Synthetic backup omitted ${name}.`);
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('nodebuffer'); const chunks = []; let length = 0; let settled = false;
    const fail = error => { if (!settled) { settled = true; stream.pause(); reject(error); } };
    stream.on('data', bytes => {
      if (settled) return;
      length += bytes.length;
      if (length > 1024 * 1024) { fail(new Error('Synthetic backup member exceeds 1 MiB.')); return; }
      chunks.push(bytes);
    }).on('error', fail).on('end', () => {
      if (settled) return; settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    }).resume();
  });
}

async function loadStateArchive(bytes, JSZip) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Synthetic backup exceeds 16 MiB.');
  const zip = await JSZip.loadAsync(bytes);
  const allowed = new Set(['backup-info.json', 'storage/flows.json', 'storage/theme.json', 'storage/global_env_vars.json', conversationPath, 'storage/history.json']);
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.unsafeOriginalName && file.unsafeOriginalName !== name) throw new Error('Synthetic backup has an aliased entry.');
    if (!file.dir && !allowed.has(name)) throw new Error('Synthetic backup contains an unrelated or private entry.');
  }
  return zip;
}

async function assertArchiveSelections(zip, selections) {
  const metadata = await readStateZipJson(zip, 'backup-info.json');
  if (!Array.isArray(metadata.selections) || stable([...metadata.selections].sort()) !== stable([...selections].sort())) {
    throw new Error('Synthetic backup selections are incomplete.');
  }
  if (zip.file('storage/history.json')) {
    const history = await readStateZipJson(zip, 'storage/history.json');
    if (!history || typeof history !== 'object' || Object.keys(history).length) throw new Error('Synthetic backup includes unrelated legacy history.');
  }
}

export async function verifySyntheticStateArchive(bytes, JSZip, expected, expectedFlows = [
  { id: flowId, name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] },
]) {
  const zip = await loadStateArchive(bytes, JSZip);
  await assertArchiveSelections(zip, stateSelections);
  const flows = await readStateZipJson(zip, 'storage/flows.json');
  assertFlowInventory(flows, expectedFlows);
  const variables = await readStateZipJson(zip, 'storage/global_env_vars.json');
  if (stable(Object.keys(variables)) !== stable([variable])) throw new Error('Synthetic backup includes unrelated variables.');
  const observed = { theme: await readStateZipJson(zip, 'storage/theme.json'), environment: variables[variable],
    conversation: expected?.conversation, conversationArchive: await readStateZipJson(zip, conversationPath) };
  assertSyntheticState(observed, expected);
  return { selections: [...stateSelections], entries: Object.keys(zip.files),
    flowInventory: { ids: canonicalFlowInventory(flows).map(flow => flow.id), ignoredFields: [...flowTimestampFields], passed: true },
    conversationComparison: conversationComparisonProfile,
    compared: ['complete seeded and created flow inventory', 'theme', 'environment', 'complete archive conversation against retained raw snapshot; complete API compared on readback', 'both full message arrays'], passed: true };
}

export async function restoreSyntheticState(request, bytes, selections = stateSelections) {
  const form = new FormData(); form.set('file', new Blob([bytes]), 'synthetic-backup.zip'); form.set('selections', JSON.stringify(selections));
  return request('/api/restore', { method: 'POST', body: form });
}

export async function seedSyntheticState(request, capture, JSZip) {
  const expected = syntheticState();
  await expect(request, '/api/storage', 200, { method: 'POST', ...json({ key: 'theme', value: expected.theme }) });
  await expect(request, '/api/env', 200, { method: 'POST', ...json({ action: 'set', key: variable, ...expected.environment }) });
  await expect(request, '/v1/chat/conversations', 201, { method: 'POST', ...json({ ...expected.conversation, updatedAt: timestamp }) });
  // Import two prescribed inert messages using the real restore API, without invoking respond/run routes.
  const exported = await expect(request, '/api/backup', 200, { method: 'POST', ...json({ selections: ['chatHistory'] }) });
  await capture('conversation-seed-export.zip', exported.bytes);
  const zip = await JSZip.loadAsync(exported.bytes);
  const record = await readStateZipJson(zip, conversationPath);
  if (record.conversationId !== conversationId || record.flowId !== flowId || !Array.isArray(record.messages) || record.messages.length) {
    throw new Error('Conversation seed is not a newly created empty synthetic record.');
  }
  record.messages = expected.conversation.messages; record.requireApproval = true; record.status = 'completed';
  zip.file(conversationPath, JSON.stringify(record));
  const seeded = await zip.generateAsync({ type: 'nodebuffer' }); await capture('conversation-seed-import.zip', seeded);
  if ((await restoreSyntheticState(request, seeded, ['chatHistory'])).status !== 200) throw new Error('Synthetic conversation seed import failed.');
  const observed = await readSyntheticState(request, JSZip); assertSyntheticSeed(observed);
  if (stable(observed.conversationArchive) !== stable(record)) throw new Error('Synthetic seed import changed the complete observed conversation record.');
  await capture('original-state.json', JSON.stringify(observed, null, 2) + '\n');
  return observed;
}

export async function mutateSyntheticState(request, JSZip, original) {
  const expected = mutatedSyntheticState(original);
  await expect(request, '/api/storage', 200, { method: 'POST', ...json({ key: 'theme', value: expected.theme }) });
  await expect(request, '/api/env', 200, { method: 'POST', ...json({ action: 'set', key: variable, ...expected.environment }) });
  await expect(request, `/v1/chat/conversations/${conversationId}`, 200, { method: 'PATCH', ...json({ title: expected.conversation.title }) });
  assertSyntheticState(await readSyntheticState(request, JSZip), expected); return expected;
}

export async function invalidSyntheticStateArchives(bytes, JSZip) {
  const missing = await JSZip.loadAsync(bytes); missing.remove('backup-info.json');
  const marked = await JSZip.loadAsync(bytes); const conversation = await readStateZipJson(marked, conversationPath);
  conversation.personaOwned = true; marked.file(conversationPath, JSON.stringify(conversation));
  return [{ name: 'missing-metadata.zip', bytes: await missing.generateAsync({ type: 'nodebuffer' }) },
    { name: 'forbidden-ownership.zip', bytes: await marked.generateAsync({ type: 'nodebuffer' }) }];
}

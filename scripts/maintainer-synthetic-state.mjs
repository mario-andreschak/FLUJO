export const stateSelections = Object.freeze(['flows', 'chatHistory', 'settings', 'globalEnvVars']);
const conversationId = 'maintainer_drill_conversation';
const flowId = 'maintainer_drill_flow';
const variable = 'FLUJO_MAINTAINER_LABEL';
const conversationPath = `storage/conversations/${conversationId}.json`;
const timestamp = 1700000000000;
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

function conversationProjection(value, archive = false) {
  if (!value || ['personaAttribution', 'personaTargetId', 'personaInstructionContext', 'personaId', 'activityId', 'personaOwned', 'personaArchived']
    .some(key => Object.hasOwn(value, key))) throw new Error('Synthetic conversation contains unrelated ownership or missing data.');
  return Object.fromEntries(['id', 'title', 'flowId', 'createdAt', 'requireApproval', 'status', 'messages']
    .map(key => [key, archive && key === 'id' ? value.conversationId : value[key]]));
}

export function assertSyntheticState(observed, expected = syntheticState()) {
  if (!observed || stable(Object.keys(observed).sort()) !== stable(['conversation', 'environment', 'theme'])) {
    throw new Error('Synthetic state contains missing or unrelated fields.');
  }
  for (const key of ['theme', 'environment', 'conversation']) {
    if (stable(observed?.[key]) !== stable(expected[key])) throw new Error(`Synthetic ${key} differs from the prescribed state.`);
  }
}

export function validateSyntheticStateReceipt(receipt, bytes) {
  const witness = receipt.evidence?.find(item => item.path === 'original-state.json');
  if (receipt.syntheticState?.schemaVersion !== 1 || receipt.syntheticState.original !== 'original-state.json'
      || receipt.syntheticState.verified !== true || receipt.provenanceSignatureVerified !== true
      || stable(receipt.syntheticState.selections) !== stable(stateSelections)
      || witness?.bytes !== bytes.length || witness.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error('Synthetic state receipt or original bytes differ from the verified baseline.');
  }
  const observed = JSON.parse(bytes); assertSyntheticState(observed); return observed;
}

async function expect(request, route, status, options) {
  const response = await request(route, options);
  if (response.status !== status) throw new Error(`Synthetic state ${route} returned ${response.status}, expected ${status}.`);
  return response;
}

export async function readSyntheticState(request) {
  const theme = JSON.parse((await expect(request, '/api/storage?key=theme', 200)).bytes).value;
  const environment = JSON.parse((await expect(request, `/api/env?key=${variable}`, 200)).bytes);
  const conversation = conversationProjection(JSON.parse((await expect(request, `/v1/chat/conversations/${conversationId}`, 200)).bytes));
  return { theme, environment, conversation };
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

export async function verifySyntheticStateArchive(bytes, JSZip, expected = syntheticState()) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Synthetic backup exceeds 16 MiB.');
  const zip = await JSZip.loadAsync(bytes);
  const allowed = new Set(['backup-info.json', 'storage/flows.json', 'storage/theme.json', 'storage/global_env_vars.json', conversationPath, 'storage/history.json']);
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.unsafeOriginalName && file.unsafeOriginalName !== name) throw new Error('Synthetic backup has an aliased entry.');
    if (!file.dir && !allowed.has(name)) throw new Error('Synthetic backup contains an unrelated or private entry.');
  }
  const metadata = await readStateZipJson(zip, 'backup-info.json');
  if (stable(metadata.selections?.slice().sort()) !== stable([...stateSelections].sort())) throw new Error('Synthetic backup selections are incomplete.');
  const flows = await readStateZipJson(zip, 'storage/flows.json');
  if (!Array.isArray(flows) || flows.length !== 1 || flows[0].id !== flowId || flows[0].name !== 'Synthetic maintainer recovery fixture'
      || stable(flows[0].nodes) !== '[]' || stable(flows[0].edges) !== '[]') throw new Error('Synthetic backup flow differs from the prescribed empty flow.');
  const variables = await readStateZipJson(zip, 'storage/global_env_vars.json');
  if (stable(Object.keys(variables)) !== stable([variable])) throw new Error('Synthetic backup includes unrelated variables.');
  if (zip.file('storage/history.json')) {
    const history = await readStateZipJson(zip, 'storage/history.json');
    if (!history || typeof history !== 'object' || Object.keys(history).length) throw new Error('Synthetic backup includes unrelated legacy history.');
  }
  const observed = { theme: await readStateZipJson(zip, 'storage/theme.json'), environment: variables[variable],
    conversation: conversationProjection(await readStateZipJson(zip, conversationPath), true) };
  assertSyntheticState(observed, expected);
  return { selections: [...stateSelections], entries: Object.keys(zip.files), compared: ['theme', 'environment', 'conversation metadata and both messages'], passed: true };
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
  const observed = await readSyntheticState(request); assertSyntheticState(observed);
  await capture('original-state.json', JSON.stringify(observed, null, 2) + '\n');
  return observed;
}

export async function mutateSyntheticState(request) {
  const expected = syntheticState(true);
  await expect(request, '/api/storage', 200, { method: 'POST', ...json({ key: 'theme', value: expected.theme }) });
  await expect(request, '/api/env', 200, { method: 'POST', ...json({ action: 'set', key: variable, ...expected.environment }) });
  await expect(request, `/v1/chat/conversations/${conversationId}`, 200, { method: 'PATCH', ...json({ title: expected.conversation.title }) });
  assertSyntheticState(await readSyntheticState(request), expected);
}

export async function invalidSyntheticStateArchives(bytes, JSZip) {
  const missing = await JSZip.loadAsync(bytes); missing.remove('backup-info.json');
  const marked = await JSZip.loadAsync(bytes); const conversation = await readStateZipJson(marked, conversationPath);
  conversation.personaOwned = true; marked.file(conversationPath, JSON.stringify(conversation));
  return [{ name: 'missing-metadata.zip', bytes: await missing.generateAsync({ type: 'nodebuffer' }) },
    { name: 'forbidden-ownership.zip', bytes: await marked.generateAsync({ type: 'nodebuffer' }) }];
}
import { createHash } from 'node:crypto';

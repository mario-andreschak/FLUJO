import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provisionOwnerBootstrap } from './owner-bootstrap.mjs';
import { fixtureRuntimeEnvironment, observeOwnedCandidate, stopOwnedCandidate } from './feature-surface-acceptance/browser-environment.mjs';
import { parseProviderResponse } from './compaction-source-task-check.mjs';

// Run through flujo-bash; the owner cleans private profiles after all epochs
// close. Only real provider output receives encrypted-state acceptance credit.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Pass a fresh absolute report path inside the owned run');
const run = path.dirname(report), stamp = randomUUID();
const requestedModel = process.env.COMPACTION_ACCEPTANCE_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';
assert(['openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free',
  'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'].includes(requestedModel),
'Use only an explicit approved OpenRouter model; no aliases, retries with other models or fallback');
const port = Number(process.env.COMPACTION_ACCEPTANCE_PORT ?? '5645');
assert(Number.isSafeInteger(port) && port > 1024 && port < 65534);
await fs.writeFile(report, '{}\n', { flag: 'wx', mode: 0o600 });
const base = `http://127.0.0.1:${port}`, profile = path.join(run, 'live-profile-' + stamp);
const authority = path.join(run, 'live-authority-' + stamp), require = createRequire(path.join(repo, 'package.json'));
const secrets = [], calls = [], canonicalSnapshots = [];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const evidence = { issue: 1091, startedUtc: new Date().toISOString(), kind: 'built-http-genuine-encrypted-responses',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
  applicationSourceTree: execFileSync('git', ['rev-parse', 'HEAD:src'], { cwd: repo, windowsHide: true }).toString().trim(),
  harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')),
  buildId: (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim(), requestedModel,
  profile, authority, cases: [], epochs: [], calls, canonicalSnapshots,
  limits: ['Read-only generated receipts; no tools or third-party side effects',
    'No provider compaction endpoint, native CLI/Claude Agent SDK session, visual, installed, endurance or release qualification',
    'Encrypted content is opaque; exact replay and provider acceptance do not inspect its meaning or cryptography'] };
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[private]'), String(value));
const save = () => fs.writeFile(report, redact(JSON.stringify(evidence, null, 2)) + '\n', { mode: 0o600 });
const check = (value, label) => { assert(value, label); evidence.cases.push(label); console.log(label); };
const replayCopy = output => structuredClone(output).map(item => {
  delete item.created_by;
  for (const part of item.content ?? []) delete part.parsed;
  return item;
});
let child, observed, cookie = '', ownerToken = '', executionToken = '', childOutput = '', configured;
let relayToken = randomBytes(32).toString('base64url'), relayUrl, activeScenario;
secrets.push(relayToken);
const relay = createServer(async (incoming, outgoing) => {
  let call;
  try {
    if (incoming.url === '/disabled-telemetry') { incoming.resume(); outgoing.writeHead(204).end(); return; }
    assert.equal(incoming.url, '/api/v1/responses'); assert.equal(incoming.method, 'POST');
    assert.equal(incoming.headers.authorization, 'Bearer ' + relayToken);
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const rawRequest = Buffer.concat(chunks).toString(), body = JSON.parse(rawRequest);
    assert.equal(body.model, requestedModel); assert(!body.models && !body.route && !body.provider);
    assert.equal(body.store, false);
    call = { number: calls.length + 1, scenario: activeScenario, request: body, startedUtc: new Date().toISOString() };
    calls.push(call); await save();
    const began = performance.now();
    const upstream = await fetch('https://openrouter.ai/api/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + configured.key }, body: rawRequest });
    const raw = await upstream.text();
    Object.assign(call, { httpStatus: upstream.status, elapsedMs: performance.now() - began,
      response: parseProviderResponse(raw), rawResponseSha256: hash(raw) });
    await save();
    outgoing.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(raw);
  } catch (error) {
    evidence.relayError = redact(error.message); if (call) call.error = evidence.relayError;
    await save();
    outgoing.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Exact-model relay refused or failed' } }));
  }
});

async function request(route, body, { token, method, expected = [200] } = {}) {
  const url = new URL(route, base); url.searchParams.set('workspace', 'default-workspace');
  const authorization = token ?? (route === '/v1/chat/completions' ? executionToken : ownerToken);
  const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { origin: base, 'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}),
      ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180000), redirect: 'error' });
  const raw = await response.text(); let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 500) }; }
  assert(expected.includes(response.status), `${route}: HTTP ${response.status} ${redact(JSON.stringify(data)).slice(0, 500)}`);
  const saved = response.headers.get('set-cookie');
  if (saved) { cookie = saved.split(';')[0]; if (!secrets.includes(cookie)) secrets.push(cookie); }
  return data;
}

async function start(config) {
  const env = fixtureRuntimeEnvironment({ dataDir: profile, baseURL: base, fixtureUrl: relayUrl, sandboxPort: port + 1 });
  Object.assign(env, { FLUJO_APP_ROOT: repo, FLUJO_OWNER_AUTH_FILE: config.policyFile,
    FLUJO_OWNER_BOOTSTRAP_FILE: config.bootstrapFile, FLUJO_OWNER_BROWSER_ORIGIN: base,
    FLUJO_ENCRYPTION_SECRET_FILE: config.secretFile });
  child = fork(path.join(repo, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)],
    { cwd: repo, env, silent: true, windowsHide: true });
  observed = observeOwnedCandidate(child); evidence.epochs.push(observed.epoch);
  child.stdout.on('data', bytes => { childOutput += redact(bytes.toString()); });
  child.stderr.on('data', bytes => { childOutput += redact(bytes.toString()); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned application startup timeout')), 60000);
    child.on('message', message => { if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Owned application exited ' + code)); });
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await request(ownerToken ? '/api/workspaces' : '/api/owner/bootstrap'); return; }
    catch (error) {
      if (!error.message.includes('WORKSPACE_LAYOUT_PREPARING') || attempt === 29) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(200 + attempt * 200, 2000)));
    }
  }
}

async function scopedCredential(config) {
  const filename = path.join(repo, 'src/backend/services/security/ownerCredentials.ts');
  const issuer = new Module(filename); issuer.filename = filename; issuer.paths = Module._nodeModulePaths(path.dirname(filename));
  const ts = require('typescript'); issuer._compile(ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  const issued = issuer.exports.issueOwnerCredential(['openai:read', 'openai:execute'], Date.now() + 90 * 60000);
  const policy = JSON.parse(await fs.readFile(config.policyFile, 'utf8')); policy.credentials.push(issued.record);
  await fs.writeFile(config.policyFile, JSON.stringify(issuer.exports.ownerPolicySchema.parse(policy)), { mode: 0o600 });
  return issued.token;
}

try {
  if (process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE) {
    assert(process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID, 'Select one explicit configured OpenRouter account');
    const loader = await import(pathToFileURL(path.resolve(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE)).href);
    configured = await loader.loadConfiguredProvider(process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID, repo);
  } else {
    assert(process.env.OPENROUTER_API_KEY, 'Set OPENROUTER_API_KEY or the read-only configured-provider loader');
    configured = { key: process.env.OPENROUTER_API_KEY, model: 'openrouter/free', baseUrl: 'https://openrouter.ai/api/v1',
      provenance: { method: 'explicit OpenRouter environment credential; memory only' } };
  }
  assert.equal(new URL(configured.baseUrl).origin, 'https://openrouter.ai');
  assert.equal(new URL(configured.baseUrl).pathname.replace(/\/$/, ''), '/api/v1');
  secrets.push(configured.key); evidence.credential = configured.provenance;
  const catalog = await (await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30000) })).json();
  const selected = catalog.data.find(model => model.id === requestedModel); assert(selected, 'Exact model must remain in the catalog');
  if (requestedModel === 'openrouter/free' || requestedModel.endsWith(':free')) {
    assert(selected.pricing.prompt === '0' && selected.pricing.completion === '0', 'Selected Free model must remain Free');
  }
  evidence.catalog = { checkedUtc: new Date().toISOString(), id: selected.id, pricing: selected.pricing,
    contextLength: selected.context_length, supportedParameters: selected.supported_parameters };
  await fs.mkdir(profile, { mode: 0o700 });
  const config = provisionOwnerBootstrap(authority, 'live-responses1091');
  config.secretFile = path.join(authority, 'operator-secret');
  await fs.writeFile(config.secretFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  relayUrl = `http://127.0.0.1:${relay.address().port}`;
  await start(config);
  const pairing = (await fs.readFile(config.pairingTokenFile, 'utf8')).trim(); secrets.push(pairing);
  const enrolled = await request('/api/owner/bootstrap', { confirmOwnerEnrollment: true }, { token: pairing, expected: [201] });
  ownerToken = enrolled.ownerToken; assert(ownerToken); secrets.push(ownerToken);
  await request('/api/encryption/secure', { action: 'initialize_default' }); await request('/api/init');
  for (const server of await request('/api/mcp/servers')) await request('/api/mcp/servers/' + encodeURIComponent(server.name), { disabled: true }, { method: 'PUT' });
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, experimental: { ...settings.value?.experimental, compactionEnabled: false } } });
  executionToken = await scopedCredential(config); secrets.push(executionToken);
  for (const adapter of ['openai-responses', 'openrouter-agent']) {
    const model = await request('/api/model', { id: randomUUID(), name: requestedModel, provider: 'openrouter',
      adapter, displayName: 'Genuine encrypted state ' + adapter,
      ApiKey: relayToken, baseUrl: relayUrl + '/api/v1', maxTokens: 1600 }, { expected: [201] });
    const flow = { id: randomUUID(), name: 'Live state ' + adapter, createdAt: Date.now(), updatedAt: Date.now(), nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 0, y: 160 }, data: { type: 'process', label: 'Process',
        properties: { boundModel: model.id, inputMode: 'full-history', personaTools: [], compactionMode: 'off',
          promptTemplate: 'Read only. Never send, publish, write or call tools. Retain the exact receipt. Reply with only the receipt, without quotes or other text.' } } },
      { id: 'finish', type: 'finish', position: { x: 0, y: 320 }, data: { type: 'finish', label: 'Finish', properties: {} } },
    ], edges: [
      { id: 'a', source: 'start', target: 'process', sourceHandle: 'start-bottom', targetHandle: 'process-top' },
      { id: 'b', source: 'process', target: 'finish', sourceHandle: 'process-bottom', targetHandle: 'finish-top' },
    ] };
    await request('/api/flow', flow, { expected: [201] });
    const conversationId = randomUUID(), receipt = 'RECIBO-ñ-' + randomUUID();
    const stateFile = path.join(profile, 'workspaces/default-workspace/db/conversations', conversationId + '.json');
    const turn = async (scenario, content) => {
      activeScenario = adapter + '/' + scenario; const before = calls.length;
      const result = await request('/v1/chat/completions', { model: 'flow-' + flow.name, stream: false,
        messages: [{ role: 'user', content }], metadata: { flujo: 'true', appendMessages: 'true', conversationId } });
      assert.equal(calls.length, before + 1, 'Exactly one provider call per turn; no retries');
      const call = calls.at(-1); assert.equal(call.httpStatus, 200); assert.equal(call.response.status, 'completed');
      if (requestedModel !== 'openrouter/free') assert.equal(call.response.model, requestedModel, 'Provider must report the exact selected model');
      assert.equal(result.conversation_id, conversationId); assert.equal(result.choices[0].message.content.trim(), receipt);
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      canonicalSnapshots.push({ adapter, scenario, conversationId, messages: state.messages });
      check(true, activeScenario + ': actual provider accepts input and returns exact Unicode receipt');
      return state;
    };
    const first = await turn('initial', 'The exact receipt is ' + receipt + '. Repeat only this receipt.');
    const firstOutput = calls.at(-1).response.output;
    const encrypted = firstOutput.filter(item => item.type === 'reasoning' && item.encrypted_content);
    check(encrypted.length > 0, adapter + ': real provider returns nonempty opaque reasoning');
    const stored = first.responsesSessions?.process?.records?.[0]?.[1]?.nativeOutput;
    assert.deepEqual(stored, firstOutput);
    check(!JSON.stringify(first).includes(relayToken) && !JSON.stringify(first).includes(configured.key), adapter + ': exact native checkpoint stores no credential bytes');
    await stopOwnedCandidate(observed); await start(config);
    const second = await turn('restart', 'After process restart repeat only the same exact receipt.');
    const input = calls.at(-1).request.input, expected = replayCopy(firstOutput);
    const index = input.findIndex(item => item.id === expected[0].id);
    assert(index >= 0); assert.deepEqual(input.slice(index, index + expected.length), expected);
    check(encrypted.every(item => input.some(current => current.id === item.id && current.encrypted_content === item.encrypted_content)),
      adapter + ': exact genuine encrypted bytes, IDs and ordering survive application restart');
    check(first.messages.every(original => second.messages.some(current => current.id === original.id && current.content === original.content)),
      adapter + ': restart preserves canonical source messages');
    await stopOwnedCandidate(observed);
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const originalMessages = structuredClone(persisted.messages);
    const item = persisted.responsesSessions.process.records[0][1].nativeOutput.find(value => value.encrypted_content);
    item.encrypted_content = (item.encrypted_content[0] === 'A' ? 'B' : 'A') + item.encrypted_content.slice(1);
    await fs.writeFile(stateFile, JSON.stringify(persisted));
    await start(config); const recovered = await turn('corrupt-derived-state', 'Repeat only the same receipt after recovery.');
    check(!calls.at(-1).request.input.some(value => value.type === 'reasoning'), adapter + ': same-size opaque checkpoint corruption uses canonical fallback');
    check(originalMessages.every(original => recovered.messages.some(current => current.id === original.id && current.content === original.content)),
      adapter + ': corruption recovery preserves all canonical messages');
    relayToken = randomBytes(32).toString('base64url'); secrets.push(relayToken);
    await request('/api/model/' + model.id, { ...model, ApiKey: relayToken }, { method: 'PUT' });
    await turn('changed-connection-credential', 'Repeat only the same receipt after updating the connection.');
    check(!calls.at(-1).request.input.some(value => value.type === 'reasoning'), adapter + ': changed connection credential invalidates genuine opaque windows');
  }
  assert(!evidence.relayError); evidence.outcome = 'passed';
} catch (error) {
  evidence.outcome = 'failed'; evidence.error = redact(error.message); process.exitCode = 1;
} finally {
  if (observed) try { await stopOwnedCandidate(observed); } catch (error) { evidence.shutdownError = redact(error.message); process.exitCode = 1; }
  await new Promise(resolve => { relay.close(resolve); relay.closeAllConnections(); });
  evidence.relayClosed = !relay.listening;
  evidence.ownedEpochsClosed = evidence.epochs.every(epoch => epoch.exitedAt && epoch.ioDrainedAt && epoch.completedAt && !epoch.forcedStop);
  if (!evidence.ownedEpochsClosed || evidence.shutdownError) { evidence.outcome = 'failed'; process.exitCode = 1; }
  evidence.totalUsage = calls.reduce((total, call) => {
    const usage = call.response?.usage ?? {};
    total.inputTokens += usage.input_tokens ?? 0; total.outputTokens += usage.output_tokens ?? 0;
    if (typeof usage.cost === 'number') total.reportedCostUsd += usage.cost; else total.callsWithoutReportedCost++;
    return total;
  }, { inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, callsWithoutReportedCost: 0 });
  evidence.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(run, 'live-application-' + stamp + '.log'), redact(childOutput));
  await save();
  console.log(JSON.stringify({ outcome: evidence.outcome, cases: evidence.cases.length, calls: calls.length,
    epochs: evidence.epochs.length, ownedEpochsClosed: evidence.ownedEpochsClosed, totalUsage: evidence.totalUsage, error: evidence.error, report }));
}

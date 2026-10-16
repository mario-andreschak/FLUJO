import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionOwnerBootstrap } from './owner-bootstrap.mjs';
import { fixtureRuntimeEnvironment, observeOwnedCandidate, stopOwnedCandidate } from './feature-surface-acceptance/browser-environment.mjs';

// Run through flujo-bash. The owner removes these private profiles after all
// application epochs close. No inference, tools, installed or release checks.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Pass a new absolute report path inside the owned run');
const run = path.dirname(report), stamp = randomUUID();
const port = Number(process.env.RESPONSES_ACCEPTANCE_PORT ?? '5595');
assert(Number.isSafeInteger(port) && port > 1024 && port < 65534);
const base = `http://127.0.0.1:${port}`, profile = path.join(run, 'durable-profile-' + stamp);
const authority = path.join(run, 'durable-authority-' + stamp);
const require = createRequire(path.join(repo, 'package.json'));
const secrets = [], requests = [], outputs = [];
const evidence = { issue: 1091, startedUtc: new Date().toISOString(), kind: 'built-http-durable-responses',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
  buildId: (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim(),
  cases: [], epochs: [], requests, outputs, providerCalls: 0,
  limits: ['Synthetic opaque bytes; no genuine encrypted/signature or CLI resume acceptance',
    'No tools execute; no browser, installed, endurance, full CI or release acceptance'] };
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[private]'), String(value));
let child, observed, cookie = '', ownerToken = '', executionToken = '', fixtureUrl, childOutput = '';
const check = (value, label) => { assert(value, label); evidence.cases.push(label); console.log(label); };
const fixture = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === '/disabled-telemetry') { incoming.resume(); outgoing.writeHead(204).end(); return; }
    assert.equal(incoming.url, '/api/v1/responses');
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'openrouter/free');
    assert(!body.models && !body.route && !body.provider);
    requests.push(body);
    const id = String(requests.length), text = 'Exact receipt ñ-' + id;
    const output = [
      { type: 'reasoning', id: 'reasoning-' + id, summary: [], encrypted_content: 'SYNTHETIC_OPAQUE_ñ_' + id },
      { type: 'message', id: 'commentary-' + id, role: 'assistant', status: 'completed', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking. ', annotations: [] }] },
      { type: 'message', id: 'final-' + id, role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text, annotations: [] }] },
    ];
    outputs.push(output);
    const response = { id: 'response-' + id, object: 'response', created_at: 1700000000,
      completed_at: 1700000001, error: null, incomplete_details: null, instructions: null,
      frequency_penalty: null, presence_penalty: null, metadata: null,
      parallel_tool_calls: true, temperature: 0, top_p: 1, tool_choice: 'auto', tools: [],
      model: body.model, status: 'completed', output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    if (body.stream) {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = event => outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } });
      output.forEach((item, output_index) => send({ type: 'response.output_item.done', sequence_number: output_index + 1, output_index, item }));
      send({ type: 'response.completed', sequence_number: output.length + 1, response });
      outgoing.end('data: [DONE]\n\n');
    }
    else outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
  } catch (error) {
    evidence.fixtureError = redact(error.message);
    outgoing.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture rejected request' } }));
  }
});

async function request(route, body, { token, method, expected = [200] } = {}) {
  const url = new URL(route, base); url.searchParams.set('workspace', 'default-workspace');
  const authorization = token ?? (route === '/v1/chat/completions' ? executionToken : ownerToken);
  const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { origin: base, 'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}),
      ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000), redirect: 'error' });
  const raw = await response.text(); let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 500) }; }
  assert(expected.includes(response.status), `${route}: HTTP ${response.status} ${redact(JSON.stringify(data)).slice(0, 400)}`);
  const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
  return data;
}

async function start(config) {
  const env = fixtureRuntimeEnvironment({ dataDir: profile, baseURL: base, fixtureUrl, sandboxPort: port + 1 });
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
  // The process-ready signal precedes bounded workspace migration on restart.
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
  await fs.mkdir(profile, { mode: 0o700 });
  const config = provisionOwnerBootstrap(authority, 'durable-responses1091');
  config.secretFile = path.join(authority, 'operator-secret');
  await fs.writeFile(config.secretFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await start(config);
  const pairing = (await fs.readFile(config.pairingTokenFile, 'utf8')).trim(); secrets.push(pairing);
  const enrolled = await request('/api/owner/bootstrap', { confirmOwnerEnrollment: true }, { token: pairing, expected: [201] });
  ownerToken = enrolled.ownerToken; assert(ownerToken); secrets.push(ownerToken);
  await request('/api/encryption/secure', { action: 'initialize_default' });
  await request('/api/init');
  for (const server of await request('/api/mcp/servers')) await request('/api/mcp/servers/' + encodeURIComponent(server.name), { disabled: true }, { method: 'PUT' });
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, experimental: { ...settings.value?.experimental, compactionEnabled: false } } });
  executionToken = await scopedCredential(config); secrets.push(executionToken);
  for (const adapter of ['openai-responses', 'openrouter-agent']) {
    const relayToken = randomBytes(32).toString('base64url'); secrets.push(relayToken);
    const model = await request('/api/model', { id: randomUUID(), name: 'openrouter/free', provider: 'openrouter',
      adapter, displayName: 'Durable ' + adapter, ApiKey: relayToken, baseUrl: fixtureUrl + '/api/v1', maxTokens: 300 }, { expected: [201] });
    const flow = { id: randomUUID(), name: 'Durable ' + adapter, createdAt: Date.now(), updatedAt: Date.now(), nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 0, y: 160 }, data: { type: 'process', label: 'Process',
        properties: { boundModel: model.id, inputMode: 'full-history', personaTools: [], compactionMode: 'off',
          promptTemplate: 'Never send, publish, or change anything. Retain exact receipts.' } } },
      { id: 'finish', type: 'finish', position: { x: 0, y: 320 }, data: { type: 'finish', label: 'Finish', properties: {} } },
    ], edges: [
      { id: 'a', source: 'start', target: 'process', sourceHandle: 'start-bottom', targetHandle: 'process-top' },
      { id: 'b', source: 'process', target: 'finish', sourceHandle: 'process-bottom', targetHandle: 'finish-top' },
    ] };
    await request('/api/flow', flow, { expected: [201] });
    const conversationId = randomUUID();
    const stateFile = path.join(profile, 'workspaces/default-workspace/db/conversations', conversationId + '.json');
    const turn = async content => {
      const result = await request('/v1/chat/completions', { model: 'flow-' + flow.name, stream: false,
        messages: [{ role: 'user', content }], metadata: { flujo: 'true', appendMessages: 'true', conversationId } });
      assert.equal(result.conversation_id, conversationId);
      return JSON.parse(await fs.readFile(stateFile, 'utf8'));
    };
    const first = await turn('Read the existing receipt.');
    const firstOutput = outputs.at(-1);
    check(first.responsesSessions?.process?.records.length === 1, adapter + ': canonical checkpoint stores complete native output');
    check(!JSON.stringify(first).includes(relayToken), adapter + ': checkpoint contains no credential bytes');
    await stopOwnedCandidate(observed); await start(config);
    const second = await turn('Continue after restart.');
    const input = requests.at(-1).input, index = input.findIndex(item => item.id === firstOutput[0].id);
    assert.deepEqual(input.slice(index, index + firstOutput.length), firstOutput);
    check(index >= 0, adapter + ': a new application process replays exact opaque bytes, IDs, phases and ordering');
    check(first.messages.every(original => second.messages.some(current => current.id === original.id && current.content === original.content)),
      adapter + ': restart continuation preserves canonical messages');
    await stopOwnedCandidate(observed);
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const record = persisted.responsesSessions.process.records[0][1];
    record.nativeOutput[0].encrypted_content = record.nativeOutput[0].encrypted_content.replace('SYNTHETIC', 'CORRUPTED');
    await fs.writeFile(stateFile, JSON.stringify(persisted));
    await start(config); await turn('Recover from corrupt derived metadata.');
    check(!requests.at(-1).input.some(item => item.type === 'reasoning'), adapter + ': same-size corrupt checkpoint uses canonical fallback');
    const modelUpdate = { ...model, name: 'openrouter/free', ApiKey: randomBytes(32).toString('base64url') };
    secrets.push(modelUpdate.ApiKey);
    await request('/api/model/' + model.id, modelUpdate, { method: 'PUT' });
    await turn('Continue after changing the connection credential.');
    check(!requests.at(-1).input.some(item => item.type === 'reasoning'), adapter + ': changed credential invalidates the durable owner');
  }
  assert(!evidence.fixtureError);
  evidence.outcome = 'passed';
} catch (error) {
  evidence.outcome = 'failed'; evidence.error = redact(error.message); process.exitCode = 1;
} finally {
  if (observed) try { await stopOwnedCandidate(observed); } catch (error) { evidence.shutdownError = redact(error.message); process.exitCode = 1; }
  await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
  evidence.fixtureClosed = !fixture.listening; evidence.finishedUtc = new Date().toISOString();
  evidence.ownedEpochsClosed = evidence.epochs.every(epoch => epoch.exitedAt && epoch.ioDrainedAt && epoch.completedAt && !epoch.forcedStop);
  if (!evidence.ownedEpochsClosed || evidence.shutdownError) { evidence.outcome = 'failed'; process.exitCode = 1; }
  evidence.requestDigest = createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  await fs.writeFile(path.join(run, 'durable-application-' + stamp + '.log'), redact(childOutput));
  await fs.writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcome: evidence.outcome, cases: evidence.cases.length, epochs: evidence.epochs.length,
    requests: requests.length, providerCalls: 0, fixtureClosed: evidence.fixtureClosed, error: evidence.error, report }));
}

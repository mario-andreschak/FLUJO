import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasCompactionTaskLeak, assertCompleteCanonicalFallback } from './compaction-source-task-check.mjs';


// Run through flujo-bash: the built application's normal file retirement is
// part of this acceptance. The owner removes the disposable profile afterward.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert(process.env.COMPACTION_ACCEPTANCE_RUN_DIR, 'Set a private, task-owned COMPACTION_ACCEPTANCE_RUN_DIR');
const run = path.resolve(process.env.COMPACTION_ACCEPTANCE_RUN_DIR);
const require = createRequire(path.join(repo, 'package.json'));
const stamp = process.env.COMPACTION_ACCEPTANCE_STAMP ?? randomUUID();
assert(/^[0-9a-f-]{36}$/.test(stamp), 'Acceptance stamp must be a UUID inside the task-owned run directory');
const profile = path.join(run, `private-${stamp}`);
const authority = path.join(run, `authority-${stamp}`);
const receiptFile = path.join(run, `compatibility-${stamp}.json`);
const appPort = Number(process.env.COMPACTION_ACCEPTANCE_PORT ?? 5481);
const base = `http://127.0.0.1:${appPort}`;
const selectedModelId = process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID;
const requestedModel = process.env.COMPACTION_ACCEPTANCE_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';
assert(['openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'].includes(requestedModel), 'Only these explicit approved Free options may be used; no fallback');
const acceptanceMode = process.env.COMPACTION_ACCEPTANCE_MODE ?? 'compatibility';
assert(['compatibility', 'reference-fidelity'].includes(acceptanceMode));
const referenceMode = acceptanceMode === 'reference-fidelity';
const baselineFile = process.env.COMPACTION_ACCEPTANCE_REFERENCE_BASELINE;
assert(!baselineFile || referenceMode, 'The retained reference fixture is only used in reference-fidelity mode');
const baselineBytes = baselineFile ? await fs.readFile(path.resolve(baselineFile)) : undefined;
const baseline = baselineBytes ? JSON.parse(baselineBytes.toString()) : undefined;
if (baseline) {
  assert.equal(baseline.status, 'failed');
  assert.equal(baseline.providerRoute.requestedModel, 'nvidia/nemotron-3-super-120b-a12b:free');
  assert.equal(baseline.calls[0].kind, 'summary');
  assert.equal(baseline.calls[1].kind, 'continuation');
}

const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { startedUtc: new Date().toISOString(), status: 'running',
  issue: 1091, scope: referenceMode
    ? 'Original receipt question without a prefix hint across ten fresh summaries and a round-five restart'
    : 'Live summary reuse, tool/model/policy invalidation and scoped projection isolation with restart',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(),
  node: process.version, profile, authority, calls: [], rounds: [], epochs: [],
  limitations: ['Controlled synthetic history; no original #520 workload or endurance claim',
    'No native session, visual compaction, installed/release or full provider-matrix qualification',
    'Controlled synthetic history and disposable cache migration; no power-loss or native provider acceptance'] };
let ownerToken = '', executionToken = '', session = '', child, relay, configured, childOutput = '', activeScenario;
const secrets = [];
const redact = value => secrets.reduce((out, secret) => out.replaceAll(secret, '[private]'), String(value));
const saved = () => fs.writeFile(receiptFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
const phase = message => console.log(`${new Date().toISOString()} ${message}`);
const requestMessages = body => (body.messages ?? body.input ?? []).filter(item => item.role).map(item => ({
  role: item.role, content: typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join(''),
}));
async function request(route, body, { token, expected = [200], timeout = 180000, method } = {}) {
  const authorization = token ?? (route === '/v1/chat/completions' || route === '/v1/models' ? executionToken : ownerToken);
  const url = new URL(route, base); url.searchParams.set('workspace', 'default-workspace');
  const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(session ? { cookie: `flujo-owner-local=${session}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (route === '/api/owner/bootstrap' || route === '/api/owner/session') {
    session = /^flujo-owner-local=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? session;
    if (session && !secrets.includes(session)) secrets.push(session);
  }
  const raw = await response.text(); let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 500) }; }
  assert(expected.includes(response.status), `${route}: HTTP ${response.status} ${redact(JSON.stringify(data)).slice(0, 700)}`);
  return data;
}
async function startApp(config) {
  const epoch = { number: evidence.epochs.length + 1, startedUtc: new Date().toISOString() };
  evidence.epochs.push(epoch);
  const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','SYSTEMDRIVE','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
  Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', FLUJO_DATA_DIR: profile,
    FLUJO_BASE_URL: base, FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_OWNER_AUTH_FILE: config.policyFile,
    FLUJO_OWNER_BOOTSTRAP_FILE: config.bootstrapFile, FLUJO_OWNER_BROWSER_ORIGIN: base,
    FLUJO_ENCRYPTION_SECRET_FILE: config.secretFile, FLUJO_MCP_APP_SANDBOX_PORT: String(appPort + 1),
    FLUJO_TELEMETRY_URL: `${evidence.relay}/disabled-telemetry` });
  child = fork(path.join(repo, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(appPort)],
    { cwd: repo, env, silent: true, windowsHide: true });
  epoch.pid = child.pid;
  const target = child;
  target.stdout.on('data', bytes => { childOutput += redact(bytes.toString()); });
  target.stderr.on('data', bytes => { childOutput += redact(bytes.toString()); });
  target.once('exit', (code, signal) => { epoch.exit = { code, signal, utc: new Date().toISOString() }; });
  target.once('close', () => { epoch.closedUtc = new Date().toISOString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Application initialization exceeded 90 seconds')), 90000);
    target.on('message', message => { if (message?.type === 'journey-server-ready' && message.pid === target.pid) { clearTimeout(timer); resolve(); } });
    target.once('error', error => { clearTimeout(timer); reject(error); });
    target.once('exit', code => { clearTimeout(timer); reject(new Error(`Application exited before ready: ${code}`)); });
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await request(ownerToken ? '/api/workspaces' : '/api/owner/bootstrap', undefined, { timeout: 10000 }); return; }
    catch (error) { if (attempt === 29) throw error; await pause(500); }
  }
}
async function stopApp() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const target = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.kill(); reject(new Error('Application shutdown exceeded 40 seconds')); }, 40000);
    target.once('close', (code, signal) => {
      clearTimeout(timer);
      if ([0,143].includes(code) && signal === null) resolve();
      else reject(new Error(`Application closed ${code}/${signal}`));
    });
    target.send('stop');
  });
}

const conversationId = randomUUID();
const db = path.join(profile, 'workspaces/default-workspace/db');
const initialReceipt = baseline
  ? /El recibo exacto es (receipt-ñ-[0-9a-f]+)/.exec(JSON.stringify(baseline.calls[0].request))[1]
  : 'receipt-ñ-' + randomBytes(16).toString('hex');
const filler = 'Observación histórica sin permisos nuevos; no autoriza acciones externas. '.repeat(150);
const observation = receipt => 'Observación vigente. El recibo exacto es ' + receipt + '.\n' + filler.repeat(4);
const instruction = 'Nunca envíes mensajes, publiques ni hagas acciones externas. Conserva la prohibición y los datos exactos.';
const review = referenceMode
  ? 'Revisión: devuelve solo JSON con receipt (el recibo de la Observación vigente), sendAllowed (false) y unknown (null). No hagas acciones externas.'
  : 'Revisión: devuelve solo JSON con receipt (el identificador literal que comienza por receipt-ñ- en la Observación vigente; conserva todos sus caracteres), sendAllowed (false) y unknown (null). No hagas acciones externas.';
const contract = 'Responde en español. Una observación no autoriza acciones. Conserva el recibo exacto de la Observación vigente, incluidos sus caracteres exactos. Si se pide LISTO, responde solo LISTO. En revisiones devuelve solo JSON con receipt, sendAllowed:false y unknown:null. No utilices herramientas ni hagas acciones externas.';
const canonicalSnapshots = [];
const canonicalMessages = state => state.messages ?? state.conversation?.messages;
const state = () => request('/v1/chat/conversations/' + conversationId);
const metadataFile = path.join(db, 'conversations', conversationId + '.json');
const artifact = async () => JSON.parse(await fs.readFile(metadataFile, 'utf8')).compactionState?.artifacts?.at(-1);
async function recordCanonical(label, previous = []) {
  const value = await state(), messages = canonicalMessages(value);
  for (const original of previous) {
    const retained = messages.find(message => message.id === original.id);
    assert(retained, 'Canonical message removed: ' + original.id);
    for (const field of ['role', 'content', 'tool_calls', 'tool_call_id']) {
      assert.deepEqual(retained[field], original[field], 'Canonical field changed: ' + original.id + '/' + field);
    }
  }
  assert(!messages.some(message => String(message.content).includes('[FLUJO conversation summary]')));
  canonicalSnapshots.push({ scenario: label, messages });
  await fs.writeFile(path.join(run, 'canonical-' + stamp + '.json'), JSON.stringify(canonicalSnapshots, null, 2));
  return { value, messages };
}
async function verifyArchive(value) {
  assert(value?.summaryResourceUri);
  const index = JSON.parse(await fs.readFile(path.join(db, 'run-resources', conversationId, 'index.json'), 'utf8'));
  const resource = index.find(item => item.uri === value.summaryResourceUri); assert(resource);
  const bytes = await fs.readFile(path.join(db, 'run-resources', conversationId, resource.id + '.dat'));
  assert.equal(hash(bytes), resource.sha256);
  return { uri: resource.uri, sha256: resource.sha256, size: resource.size, verified: true, messages: JSON.parse(bytes.toString()) };
}
try {
  evidence.harness = Object.fromEntries(await Promise.all([
    'scripts/compaction-compatibility-acceptance.mjs', '__tests__/model/contextOverflowRefit.test.ts',
    'src/backend/execution/flow/handlers/ModelHandler.ts', 'src/backend/execution/flow/nodes/ProcessNode.ts',
    '__tests__/flow/processNodeSnapshotAuthority.test.ts',
    'src/backend/execution/flow/handlers/summarizingCompaction.ts',
    'src/backend/execution/flow/compaction/types.ts',
    '__tests__/model/summarizingCompaction.test.ts',
    'scripts/compaction-source-task-check.mjs', 'scripts/compaction-source-task-check.test.mjs',
  ].map(async filename => [filename, hash(await fs.readFile(path.join(repo, filename)))])));
  // Fingerprint the actual source, including an owned uncommitted repair,
  // without changing the checkout's staging area. The owner retires this index
  // through flujo-bash after acceptance/publication joins the same tree.
  const indexEnv = { ...process.env, GIT_INDEX_FILE: path.join(run, 'source-index-' + stamp) };
  const sourceGit = args => execFileSync('git', args, { cwd: repo, env: indexEnv, windowsHide: true }).toString().trim();
  sourceGit(['read-tree', 'HEAD']); sourceGit(['add', '--', 'src']);
  evidence.applicationSourceTree = sourceGit(['rev-parse', sourceGit(['write-tree']) + ':src']);
  if (process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE) {
    assert(selectedModelId, 'Select an explicit existing approved Free account ID for the configured loader');
    const loader = await import(pathToFileURL(path.resolve(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE)).href);
    configured = await loader.loadConfiguredProvider(selectedModelId, repo);
  } else {
    assert(process.env.OPENROUTER_API_KEY, 'Set OPENROUTER_API_KEY or an in-memory configured-provider loader');
    configured = { key: process.env.OPENROUTER_API_KEY, model: 'openrouter/free',
      baseUrl: 'https://openrouter.ai/api/v1', provenance: { method: 'explicit OpenRouter environment credential, memory only' } };
  }
  assert.equal(configured.model, 'openrouter/free');
  const endpoint = new URL(configured.baseUrl); assert.equal(endpoint.origin, 'https://openrouter.ai');
  assert.equal(endpoint.pathname.replace(/\/$/, ''), '/api/v1');
  secrets.push(configured.key); evidence.credential = configured.provenance;
  const relayToken = randomBytes(32).toString('base64url'); secrets.push(relayToken);
  relay = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/disabled-telemetry') { incoming.resume(); outgoing.writeHead(204).end(); return; }
      assert.equal(incoming.url, '/api/v1/responses'); assert.equal(incoming.method, 'POST');
      assert.equal(incoming.headers.authorization, `Bearer ${relayToken}`);
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, requestedModel); assert(!body.models && !body.route && !body.provider);
      const call = { number: evidence.calls.length + 1, scenario: activeScenario, startedUtc: new Date().toISOString(),
        kind: requestMessages(body)[0]?.content?.includes('You are compacting a long agentic conversation') ? 'summary' : 'continuation',
        requestedModel: body.model, request: body, requestSha256: hash(JSON.stringify(body)) };
      evidence.calls.push(call); await saved();
      const began = performance.now();
      const upstream = await fetch('https://openrouter.ai/api/v1/responses', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(150000), headers: { 'Content-Type': 'application/json', authorization: `Bearer ${configured.key}` },
        body: JSON.stringify(body) });
      const raw = await upstream.text(); let response;
      try { response = JSON.parse(raw); }
      catch {
        const events = raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
          .map(line => { try { return JSON.parse(line.slice(6)); } catch { return null; } }).filter(Boolean);
        const completed = events.findLast(event => event.response?.status === 'completed')?.response;
        response = completed ?? { id: events.find(event => event.response?.id)?.response?.id,
          model: events.find(event => event.response?.model)?.response?.model,
          usage: events.findLast(event => event.response?.usage)?.response?.usage,
          content: events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta ?? '').join(''),
          sseEvents: events.length, eventTypes: [...new Set(events.map(event => event.type))] };
      }
      Object.assign(call, { status: upstream.status, elapsedMs: performance.now() - began, response,
        generationId: response.id, actualModel: response.model,
        usage: response.usage ? { ...response.usage, prompt_tokens: response.usage.prompt_tokens ?? response.usage.input_tokens,
          completion_tokens: response.usage.completion_tokens ?? response.usage.output_tokens } : undefined });
      await saved(); outgoing.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' }).end(raw);
    } catch (error) { evidence.relayFailure = redact(error.message); await saved(); outgoing.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Controlled relay refused or failed', type: 'api_error' } })); }
  });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  evidence.relay = `http://127.0.0.1:${relay.address().port}`;
  evidence.providerRoute = { adapter: 'actual built OpenAiResponsesAdapter, selected by production OpenRouter routing', requestedModel,
    destination: 'https://openrouter.ai/api/v1/responses', relay: 'strict exact-model forwarding; no replacement answers or fallback',
    providerCredential: 'memory only; application receives a private local relay token' };
  await fs.mkdir(profile, { mode: 0o700 });
  const { provisionOwnerBootstrap } = await import(pathToFileURL(path.join(repo, 'scripts/owner-bootstrap.mjs')).href);
  const config = provisionOwnerBootstrap(authority, 'compaction-action-acceptance');
  config.secretFile = path.join(authority, 'operator-secret');
  await fs.writeFile(config.secretFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  evidence.buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
  phase('Starting built application and normal owner enrollment');
  await startApp(config);
  const pairing = (await fs.readFile(config.pairingTokenFile, 'utf8')).trim(); secrets.push(pairing);
  const enrolled = await request('/api/owner/bootstrap', { confirmOwnerEnrollment: true }, { token: pairing, expected: [201] });
  ownerToken = enrolled.ownerToken; assert(ownerToken); secrets.push(ownerToken);
  await request('/api/encryption/secure', { action: 'initialize_default' });
  await request('/api/init');
  const servers = await request('/api/mcp/servers');
  assert(Array.isArray(servers));
  for (const server of servers) await request('/api/mcp/servers/' + encodeURIComponent(server.name),
    { disabled: true }, { method: 'PUT' });

  evidence.conversationId = conversationId;
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, experimental: { ...settings.value?.experimental,
      compactionEnabled: true, compactionKeepTokens: 4096, visualCompactionEnabled: false } } });
  const model = await request('/api/model', { id: 'compaction-compatibility-free', name: requestedModel, provider: 'openrouter',
    adapter: 'openai', displayName: 'Existing compaction compatibility acceptance', ApiKey: relayToken, baseUrl: evidence.relay + '/api/v1',
    maxTokens: 4000, compactionThreshold: 512 }, { expected: [201] });
  const now = Date.now();
  const flow = { id: randomUUID(), name: 'Compaction compatibility existing1091', description: 'Existing1091 summary configuration compatibility',
    createdAt: now, updatedAt: now, nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 0, y: 160 }, data: { type: 'process', label: 'Existing context',
        properties: { boundModel: model.id, modelName: model.name, inputMode: 'full-history',
          personaTools: [], maxTurns: 2, compactionMode: 'auto', compactionKeepTokens: 4096, promptTemplate: contract } } },
      { id: 'finish', type: 'finish', position: { x: 0, y: 320 }, data: { type: 'finish', label: 'Finish', properties: {} } },
    ], edges: [
      { id: 'start-process', source: 'start', target: 'process', sourceHandle: 'start-bottom', targetHandle: 'process-top' },
      { id: 'process-finish', source: 'process', target: 'finish', sourceHandle: 'process-bottom', targetHandle: 'finish-top' },
    ] };
  await request('/api/flow', flow, { expected: [201] });
  const issuerFile = path.join(repo, 'src/backend/services/security/ownerCredentials.ts');
  const issuer = new Module(issuerFile); issuer.filename = issuerFile; issuer.paths = Module._nodeModulePaths(path.dirname(issuerFile));
  const ts = require('typescript'); issuer._compile(ts.transpileModule(await fs.readFile(issuerFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, issuerFile);
  const issued = issuer.exports.issueOwnerCredential(['openai:read','openai:execute'], Date.now() + 90*60000);
  const policy = JSON.parse(await fs.readFile(config.policyFile, 'utf8')); policy.credentials.push(issued.record);
  await fs.writeFile(config.policyFile, JSON.stringify(issuer.exports.ownerPolicySchema.parse(policy)), { mode: 0o600 });
  executionToken = issued.token; secrets.push(executionToken);
  evidence.authority = { method: 'shipped owner pairing and canonical private OS-owner scoped issuer', scopes: issued.record.scopes };
  evidence.flowId = flow.id; evidence.modelId = model.id;

  async function turn(label, messages) {
    activeScenario = label; phase('Running ' + label);
    const previous = evidence.rounds.length || canonicalSnapshots.length ? canonicalMessages(await state()) : [];
    const firstCall = evidence.calls.length, began = performance.now();
    const response = await request('/v1/chat/completions', { model: 'flow-' + flow.name, messages, stream: false,
      metadata: { flujo: 'true', appendMessages: 'true', conversationId } }, { timeout: 600000 });
    assert.equal(response.conversation_id, conversationId);
    const canonical = await recordCanonical(label, previous);
    return { scenario: label, elapsedMs: performance.now() - began, response: response.choices?.[0]?.message?.content,
      canonicalMessages: canonical.messages.length, canonicalSha256: hash(JSON.stringify(canonical.messages)),
      canonicalPreserved: true, value: canonical.value, calls: evidence.calls.slice(firstCall) };
  }
  const answerOf = content => { const fence = String.fromCharCode(96).repeat(3), value = content.trim(); return JSON.parse(value.startsWith(fence) ? value.slice(value.indexOf('\n') + 1, value.lastIndexOf(fence)).trim() : value); };
  const expectedAnswer = { receipt: initialReceipt, sendAllowed: false, unknown: null };
  const describe = async value => ({ ...value, value: undefined, calls: value.calls.map(call => call.number),
    summaryCalls: value.calls.filter(call => call.kind === 'summary').map(call => call.number), artifact: await artifact() });
  async function checkReferenceFidelity() {
    if (baseline) evidence.retainedFailure = {
      file: path.resolve(baselineFile), sha256: hash(baselineBytes),
      requestSha256: baseline.calls[0].requestSha256,
      requestedModel: baseline.providerRoute.requestedModel,
      failure: baseline.failure.message,
    };
    let previousArtifact;
    for (let round = 1; round <= 10; round++) {
      const receipt = round === 1 ? initialReceipt : 'receipt-ñ-' + randomBytes(16).toString('hex');
      const currentObservation = round === 1 ? observation(receipt)
        : 'Observación vigente. El recibo exacto es ' + receipt + '.\n';
      const value = await turn('reference-round-' + round, [
        ...(round === 1 ? [{ id: randomUUID(), role: 'user', content: instruction }] : []),
        { id: randomUUID(), role: 'assistant', content: currentObservation },
        { id: randomUUID(), role: 'assistant', content: 'Contexto reciente sin nuevas acciones. ' + filler.repeat(round === 1 ? 3 : 2) },
        { id: randomUUID(), role: 'user', content: review },
      ]);
      const recorded = await describe(value);
      recorded.round = round;
      recorded.expected = { receipt, sendAllowed: false, unknown: null };
      recorded.answer = answerOf(value.response);
      evidence.rounds.push(recorded); await saved();
      assert.deepEqual(recorded.answer, recorded.expected);
      assert.equal(recorded.summaryCalls.length, 1, 'Each changed observation must attempt one fresh summary');
      const summary = value.calls.find(call => call.kind === 'summary');
      const summaryText = (summary.response.output ?? []).filter(output => output.type === 'message')
        .flatMap(output => output.content ?? []).map(part => part.text ?? '').join('');
      recorded.sourceTaskState = Object.fromEntries(['Objective', 'Work State', 'Next Move'].map(section =>
        [section, summaryText.split('## ' + section + '\n')[1]?.split('\n## ')[0]?.trim() ?? '']));
      const taskText = Object.values(recorded.sourceTaskState).join('\n');
      assert(!hasCompactionTaskLeak(taskText),
      'The fixture contains no user request to summarize; compaction controls must not become task state');
      assert.equal(requestMessages(summary.request).at(-1).role, 'system', 'Compaction control must not impersonate a source user turn');
      recorded.compactionControlRole = 'system';
      const continuation = value.calls.filter(call => call.kind === 'continuation');
      assert.equal(continuation.length, 1);
      assert(!continuation.some(call => (call.response.output ?? []).some(output => output.type === 'function_call')));
      const wire = requestMessages(continuation[0].request);
      assert.equal(wire.at(-1).content, review, 'The review must not reveal the value or identifier prefix');
      assert(wire.some(message => message.role === 'user' && message.content === instruction));
      if (recorded.artifact?.artifactId !== previousArtifact?.artifactId) {
        assert(wire.some(message => message.content.startsWith('[FLUJO conversation summary]') && message.content.includes(receipt)));
        const archive = await verifyArchive(recorded.artifact);
        assert(archive.messages.some(message => message.content === currentObservation));
        delete archive.messages; recorded.sourceArchive = archive;
        recorded.summaryDisposition = 'persisted';
      } else {
        const canonical = canonicalSnapshots.at(-1).messages;
        assert.equal(canonical.at(-1).role, 'assistant');
        assert.equal(canonical.at(-1).content, value.response);
        assertCompleteCanonicalFallback({ wire, canonicalBeforeReply: canonical.slice(0, -1),
          currentObservation, instruction, previousArtifact, artifact: recorded.artifact });
        recorded.summaryDisposition = 'complete-canonical-fallback';
        recorded.retainedArchive = await verifyArchive(recorded.artifact);
        delete recorded.retainedArchive.messages;
        recorded.canonicalFallbackVerified = true;
      }
      if (round === 1 && baseline) {
        assert.deepEqual(requestMessages(summary.request).slice(1, -1), requestMessages(baseline.calls[0].request).slice(1, -1),
          'The retained failed first summary must have identical source and request, apart from compaction instructions');
        assert.equal(wire.at(-1).content, requestMessages(baseline.calls[1].request).at(-1).content);
        recorded.identicalBaselineSourceAndReview = true;
      }
      recorded.fieldsPassed = true;
      previousArtifact = recorded.artifact;
      await saved();
      if (round === 5 || round === 10) {
        const before = canonicalMessages(await state());
        await stopApp(); await startApp(config); await request('/api/init');
        await recordCanonical('reference-restart-' + round, before);
        assert.equal((await artifact()).artifactId, previousArtifact.artifactId);
      }
    }
    evidence.result = { attemptedSummaries: 10,
      freshSummaries: evidence.rounds.filter(round => round.summaryDisposition === 'persisted').length,
      completeCanonicalFallbacks: evidence.rounds.filter(round => round.canonicalFallbackVerified).length,
      exactReplies: 10, originalQuestionWithoutPrefixHint: true,
      currentReceiptChanges: 9, roundFiveAndTenRestarts: true, canonicalHistoryPreserved: true,
      sourceTaskStateChecked: true, compactionControlsOutsideUserTurns: true,
      canonicalSnapshotsVerified: canonicalSnapshots.length,
      archiveHashesVerified: evidence.rounds.filter(round => round.sourceArchive?.verified).length };
    evidence.limitations.push('A stochastic, controlled plaintext receipt fixture on one Free model; exact-field or general semantic guarantees remain unqualified');
  }
  if (referenceMode) {
    await checkReferenceFidelity();
  } else {
    const first = await turn('initial-summary', [
      { id: randomUUID(), role: 'user', content: instruction },
      { id: randomUUID(), role: 'assistant', content: observation(initialReceipt) },
      { id: randomUUID(), role: 'assistant', content: 'Contexto reciente sin nuevas acciones. ' + filler.repeat(3) },
      { id: randomUUID(), role: 'user', content: review },
    ]);
    assert.deepEqual(answerOf(first.response), expectedAnswer);
    evidence.initial = await describe(first);
    assert(evidence.initial.summaryCalls.length === 1 && evidence.initial.artifact?.summaryResourceUri);
    evidence.initial.sourceArchive = await verifyArchive(evidence.initial.artifact);
    delete evidence.initial.sourceArchive.messages;
    // The first summary can arm read_resource for the next call. Warm that
    // shipped tool inventory once before asserting an unchanged cache hit.
    const warm = await turn('warm-resource-inventory', [{ role: 'user', content: review }]);
    assert.deepEqual(answerOf(warm.response), expectedAnswer);
    evidence.warm = await describe(warm);
    await saved();
    async function check(label, expected, { sameProjection = false, question, scoped = false } = {}) {
      const before = await artifact();
      const value = await turn(label, [{ role: 'user', content: scoped
        ? 'Revisión solo del mensaje actual: devuelve exactamente {"receipt":null,"sendAllowed":false,"unknown":null}. No recuperes historia ni uses herramientas.' : review }]);
      const recorded = await describe(value);
      const continuation = value.calls.filter(call => call.kind === 'continuation');
      recorded.expected = expected; recorded.beforeArtifact = before;
      recorded.toolNames = continuation.flatMap(call => (call.request.tools ?? []).map(tool => tool.name ?? tool.function?.name));
      recorded.answer = answerOf(value.response);
      evidence.rounds.push(recorded); await saved();
      assert.deepEqual(recorded.answer, scoped ? { ...expectedAnswer, receipt: null } : expectedAnswer);
      assert.equal(continuation.length, 1, 'One real continuation per review');
      assert(!continuation.some(call => (call.response.output ?? []).some(output => output.type === 'function_call')), 'This compatibility check cannot execute tools');
      if (question !== undefined) assert.equal(recorded.toolNames.includes('question'), question);
      const wire = requestMessages(continuation[0].request);
      if (scoped) {
        assert.equal(recorded.summaryCalls.length, 0);
        assert(!wire.some(message => message.content.includes('[FLUJO conversation summary]') || message.content.includes(initialReceipt)));
        assert.equal(recorded.artifact.artifactId, before.artifactId, 'Scoped call must not replace the full-history cache');
      } else {
        assert(wire.some(message => message.content.includes('[FLUJO conversation summary]')));
        assert(wire.some(message => message.role === 'user' && message.content === instruction));
        assert.equal(recorded.artifact.sourceDigest, before.sourceDigest, 'The old source prefix must remain identical to isolate configuration invalidation');
        assert.equal(recorded.summaryCalls.length, expected === 'reuse' ? 0 : 1,
          expected === 'reuse' ? 'An unchanged source/configuration must reuse its durable summary' : 'A changed identity must generate one fresh summary');
        if (expected === 'reuse') assert.equal(recorded.artifact.artifactId, before.artifactId);
        else {
          assert.notEqual(recorded.artifact.artifactId, before.artifactId);
          if (sameProjection) assert.equal(recorded.artifact.projectionDigest, before.projectionDigest);
          else assert.notEqual(recorded.artifact.projectionDigest, before.projectionDigest);
        }
        const archive = await verifyArchive(recorded.artifact);
        assert(archive.messages.some(message => message.content === observation(initialReceipt)));
        recorded.sourceArchive = { ...archive, messages: undefined };
      }
      recorded.fieldsPassed = true; recorded.canonicalPreserved = true; await saved();
      return recorded;
    }
    await check('unchanged-cache-control', 'reuse');
    const beforeRestart = canonicalMessages(await state());
    await stopApp(); await startApp(config); await request('/api/init');
    await recordCanonical('restart-for-durable-reuse', beforeRestart);
    await check('unchanged-after-restart', 'reuse');
    const properties = flow.nodes.find(node => node.id === 'process').data.properties;
    async function saveFlow() {
      flow.updatedAt = Date.now();
      await request('/api/flow/' + flow.id, flow, { method: 'PUT' });
      // Loaded conversations intentionally keep their immutable graph. Install a
      // changed pinned graph only in this stopped, disposable saved-state fixture;
      // editing the mutable catalog must not grant tools to an existing run.
      const before = canonicalMessages(await state()), retained = await artifact();
      await stopApp();
      const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
      assert.equal(metadata.flowSnapshot.id, flow.id);
      const previousProperties = metadata.flowSnapshot.nodes.find(node => node.id === 'process').data.properties;
      metadata.flowSnapshot = structuredClone(flow);
      await fs.writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
      evidence.snapshotMigrations ??= [];
      evidence.snapshotMigrations.push({ number: evidence.snapshotMigrations.length + 1,
        method: 'Stopped disposable-profile pinned-snapshot migration; catalog edits remain isolated from loaded conversations',
        previousProperties, properties: structuredClone(properties), retainedArtifactId: retained.artifactId });
      await startApp(config); await request('/api/init');
      await recordCanonical('snapshot-migration-' + evidence.snapshotMigrations.length, before);
      assert.equal((await artifact()).artifactId, retained.artifactId, 'Migration must retain the old artifact for real invalidation');
    }
    properties.allowQuestion = true; await saveFlow();
    await check('tool-added', 'fresh', { question: true });
    properties.allowQuestion = false; await saveFlow();
    await check('tool-removed', 'fresh', { question: false });
    model.compactionThreshold = 768;
    await request('/api/model/' + model.id, model, { method: 'PUT' });
    await check('effective-policy-changed', 'fresh');
    model.maxTokens = 3500;
    await request('/api/model/' + model.id, model, { method: 'PUT' });
    await check('output-budget-changed', 'fresh');
    const alias = await request('/api/model', { ...model, id: 'compaction-compatibility-free-alias',
      ApiKey: relayToken, displayName: 'Same approved Free route; changed local identity' }, { expected: [201] });
    properties.boundModel = alias.id; await saveFlow();
    await check('model-identity-changed', 'fresh');
    const beforeMigration = canonicalMessages(await state());
    await stopApp();
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    const legacy = metadata.compactionState.artifacts.at(-1);
    evidence.policyMigration = { artifactId: legacy.artifactId, originalPolicy: legacy.policyVersion,
      injectedPolicy: 'summary-v2-legacy-acceptance', method: 'Disposable persisted cache fixture; canonical messages unchanged' };
    legacy.policyVersion = evidence.policyMigration.injectedPolicy;
    await fs.writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
    await startApp(config); await request('/api/init');
    await recordCanonical('restart-for-policy-migration', beforeMigration);
    await check('legacy-policy-rejected', 'fresh', { sameProjection: true });
    properties.inputMode = 'latest-message'; await saveFlow();
    await check('latest-message-projection', 'scoped', { scoped: true });
    properties.inputMode = 'full-history'; await saveFlow();
    await check('full-history-after-scoped-call', 'reuse');
    const beforeFinalRestart = canonicalMessages(await state()), finalArtifact = await artifact();
    await stopApp(); await startApp(config); await request('/api/init');
    await recordCanonical('final-restart', beforeFinalRestart);
    assert.equal((await artifact()).artifactId, finalArtifact.artifactId);
    evidence.result = { unchangedCacheHits: evidence.rounds.filter(round => round.expected === 'reuse').length,
      configurationInvalidations: evidence.rounds.filter(round => round.expected === 'fresh' && round.scenario !== 'legacy-policy-rejected').length,
      legacyPolicyRejected: true, scopedProjectionIsolated: true,
      exactReplies: evidence.rounds.length + 2, canonicalSnapshotsVerified: canonicalSnapshots.length,
      canonicalHistoryPreserved: true, sourcePrefixStableAcrossConfigurationChanges: true };
    }
    evidence.status = 'passed-focused-scope';
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = { name: error.name, message: redact(error.message), stack: redact(error.stack) };
    process.exitCode = 1;
  } finally {
    try { await stopApp(); } catch (error) { evidence.shutdownFailure = redact(error.message); process.exitCode = 1; }
    if (relay) await new Promise(resolve => relay.close(resolve));
    for (const call of evidence.calls) {
      if (!configured || !call.generationId || (call.usage && typeof call.usage.cost === 'number')) continue;
      try {
        const response = await fetch('https://openrouter.ai/api/v1/generation?id=' + encodeURIComponent(call.generationId), {
          headers: { authorization: `Bearer ${configured.key}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
        const billing = await response.json();
        call.billing = { status: response.status, data: billing.data };
        if (response.ok && typeof billing.data?.total_cost === 'number') call.usage = { ...call.usage,
          prompt_tokens: call.usage?.prompt_tokens ?? billing.data.tokens_prompt,
          completion_tokens: call.usage?.completion_tokens ?? billing.data.tokens_completion, cost: billing.data.total_cost };
      } catch (error) { call.billing = { error: redact(error.message) }; }
    }
    evidence.finishedUtc = new Date().toISOString();
    evidence.totalUsage = evidence.calls.reduce((sum, call) => { const usage = call.usage ?? {};
      sum.inputTokens += usage.prompt_tokens ?? 0; sum.outputTokens += usage.completion_tokens ?? 0;
      if (typeof usage.cost === 'number') sum.reportedCost += usage.cost; else sum.callsWithoutReportedCost++;
      return sum; }, { inputTokens: 0, outputTokens: 0, reportedCost: 0, callsWithoutReportedCost: 0 });
    evidence.applicationClosed = evidence.epochs.every(epoch => epoch.closedUtc);
    evidence.applicationLogRedacted = true;
    await fs.writeFile(path.join(run, `application-${stamp}.log`), redact(childOutput), { mode: 0o600 });
    await saved();
    console.log(JSON.stringify({ receiptFile, status: evidence.status, failure: evidence.failure?.message,
      rounds: evidence.rounds.length, calls: evidence.calls.length, totalUsage: evidence.totalUsage, applicationClosed: evidence.applicationClosed }));
  }

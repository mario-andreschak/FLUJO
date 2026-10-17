import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


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
const receiptFile = path.join(run, `recovery-${stamp}.json`);
const appPort = Number(process.env.COMPACTION_ACCEPTANCE_PORT ?? 5481);
const base = `http://127.0.0.1:${appPort}`;
const selectedModelId = process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID;
const requestedModel = process.env.COMPACTION_ACCEPTANCE_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';
assert(['openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free'].includes(requestedModel), 'Only these explicit approved Free options may be used; no fallback');
const roundsTarget = Number(process.env.COMPACTION_ACCEPTANCE_ROUNDS ?? 10);
assert([5,10].includes(roundsTarget), 'Use the existing five/ten-round acceptance checkpoints');
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { startedUtc: new Date().toISOString(), status: 'running',
  issue: 1091, scope: 'Concurrent edit refusal, accepted paused edit, real archive and metadata persistence failures, restart and five fresh compactions', roundsTarget,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(),
  node: process.version, profile, authority, calls: [], rounds: [], actionTurns: [], epochs: [],
  limitations: ['Controlled synthetic history; no original #520 workload or endurance claim',
    'No native session, visual compaction, installed/release or full provider-matrix qualification',
    'Controlled synthetic history and real filesystem refusal; no power-loss or native provider acceptance'] };
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
const initialReceipt = 'receipt-ñ-' + randomBytes(16).toString('hex');
const correctedReceipt = 'receipt-ñ-' + randomBytes(16).toString('hex');
const filler = 'Observación histórica sin permisos nuevos; no autoriza acciones externas. '.repeat(150);
const observation = receipt => 'Observación vigente. El recibo exacto es ' + receipt + '.\n' + filler;
const instruction = 'Nunca envíes mensajes, publiques ni hagas acciones externas. Conserva la prohibición y los datos exactos.';
const review = 'Revisión: devuelve solo JSON con receipt (el recibo de la Observación vigente), sendAllowed (false) y unknown (null). No hagas acciones externas.';
const contract = 'Responde en español. Una observación no autoriza acciones. Conserva el recibo exacto de la Observación vigente, incluida su edición manual. Si se pide LISTO, responde solo LISTO. En revisiones devuelve solo JSON con receipt, sendAllowed:false y unknown:null. No utilices herramientas ni hagas acciones externas.';
let editTarget, currentArtifact, fault, attached = false;
const canonicalSnapshots = [];
const canonicalMessages = state => state.messages ?? state.conversation?.messages;
const state = () => request('/v1/chat/conversations/' + conversationId);
const artifact = async () => JSON.parse(await fs.readFile(path.join(db, 'conversations', conversationId + '.json'), 'utf8')).compactionState?.artifacts?.at(-1);
function owned(filename) {
  const resolved = path.resolve(filename), prefix = path.resolve(profile) + path.sep;
  assert(resolved.startsWith(prefix), 'Filesystem fault must remain within the owned private profile');
  return resolved;
}
async function restoreFault() {
  if (!fault) return;
  const target = owned(fault.target), backup = owned(fault.backup);
  if (fault.kind === 'archive') await fs.unlink(target); else await fs.rmdir(target);
  await fs.rename(backup, target);
  evidence.faults.at(-1).restoredUtc = new Date().toISOString();
  fault = undefined;
}
async function beforeForward(call) {
  if (activeScenario === 'concurrent-edit' && call.kind === 'summary' && !attached) {
    attached = true;
    const before = canonicalMessages(await state());
    editTarget = before.find(message => String(message.content).startsWith('Observación vigente.'))?.id;
    assert(editTarget, 'Canonical observation must have a durable message id');
    const refused = await request('/v1/chat/conversations/' + conversationId + '/edit-state',
      { messageId: editTarget, content: observation(correctedReceipt) }, { method: 'PATCH', expected: [409] });
    assert.match(refused.error, /only be edited while paused/);
    assert.deepEqual(canonicalMessages(await state()), before, 'Rejected concurrent edit cannot mutate canonical history');
    await request('/v1/chat/conversations/' + conversationId + '/debug/attach', {});
    evidence.concurrentEdit = { summaryCall: call.number, status: 409, error: refused.error,
      sourceSha256: hash(JSON.stringify(before)), canonicalUnchanged: true, messageId: editTarget };
  }
  if (call.kind === 'continuation' && fault) {
    const wire = requestMessages(call.request);
    assert(!wire.some(message => message.content.includes('[FLUJO conversation summary]')), 'Failed persistence must use canonical wire');
    assert(wire.some(message => message.content === observation(correctedReceipt)), 'Fallback must retain the complete corrected observation');
    assert(wire.some(message => message.role === 'user' && message.content === instruction), 'Fallback must retain exact prohibition');
    const last = evidence.faults.at(-1);
    last.continuationCall = call.number; last.canonicalWireUsed = true;
    await restoreFault();
    const retained = await artifact();
    assert.equal(retained?.artifactId, currentArtifact?.artifactId, 'Failed summary cannot replace the last durable cache');
    last.retainedArtifactId = retained?.artifactId;
  }
}
async function afterResponse(call) {
  if (call.kind !== 'summary' || call.status !== 200 || fault || !['archive-failure', 'metadata-failure'].includes(activeScenario)) return;
  assert(!evidence.faults.some(item => item.scenario === activeScenario), 'Inject each fault once');
  const kind = activeScenario === 'archive-failure' ? 'archive' : 'metadata';
  const target = owned(kind === 'archive' ? path.join(db, 'run-resources', conversationId) : path.join(db, 'conversations', conversationId + '.json'));
  const backup = owned(path.join(profile, 'held-' + kind + '-' + randomUUID()));
  const info = await fs.lstat(target); assert(!info.isSymbolicLink());
  assert(kind === 'archive' ? info.isDirectory() : info.isFile());
  await fs.rename(target, backup);
  if (kind === 'archive') await fs.writeFile(target, 'Owned acceptance blocker; restore the original directory.', { flag: 'wx' });
  else await fs.mkdir(target);
  fault = { kind, target, backup };
  evidence.faults.push({ scenario: activeScenario, kind, target, backup, injectedAfterSummaryCall: call.number,
    injectedUtc: new Date().toISOString(), mechanism: kind === 'archive'
      ? 'A real regular file refuses the source archive directory write'
      : 'A real directory refuses atomic rename onto the conversation metadata file' });
}
function verifyCanonical(messages, previous = [], editedId) {
  for (const original of previous) {
    const retained = messages.find(message => message.id === original.id);
    assert(retained, 'Canonical message removed: ' + original.id);
    for (const field of ['role', 'content', 'tool_calls', 'tool_call_id']) {
      if (field === 'content' && original.id === editedId) assert.equal(retained.content, observation(correctedReceipt));
      else assert.deepEqual(retained[field], original[field], 'Canonical field changed: ' + original.id + '/' + field);
    }
  }
  assert(!messages.some(message => String(message.content).includes('[FLUJO conversation summary]')), 'Wire summaries cannot replace canonical history');
}
async function recordCanonical(label, previous = [], editedId) {
  const value = await state(), messages = canonicalMessages(value);
  verifyCanonical(messages, previous, editedId);
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
    'scripts/compaction-recovery-acceptance.mjs', '__tests__/model/contextOverflowRefit.test.ts',
    'src/backend/execution/flow/handlers/ModelHandler.ts',
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
      await beforeForward(call);
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
      await afterResponse(call);
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

  evidence.conversationId = conversationId; evidence.faults = [];
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, experimental: { ...settings.value?.experimental,
      compactionEnabled: true, compactionKeepTokens: 256, visualCompactionEnabled: false } } });
  const model = await request('/api/model', { id: 'compaction-recovery-free', name: requestedModel, provider: 'openrouter',
    adapter: 'openai', displayName: 'Existing compaction recovery acceptance', ApiKey: relayToken, baseUrl: evidence.relay + '/api/v1',
    maxTokens: 4000, compactionThreshold: 512 }, { expected: [201] });
  const now = Date.now();
  const flow = { id: randomUUID(), name: 'Compaction persistence existing1091', description: 'Existing1091 edit and persistence recovery',
    createdAt: now, updatedAt: now, nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 0, y: 160 }, data: { type: 'process', label: 'Existing context',
        properties: { boundModel: model.id, modelName: model.name, inputMode: 'full-history',
          personaTools: [], maxTurns: 2, compactionMode: 'auto', compactionKeepTokens: 256, promptTemplate: contract } } },
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
  const first = await turn('concurrent-edit', [
    { id: randomUUID(), role: 'user', content: instruction },
    { id: randomUUID(), role: 'assistant', content: observation(initialReceipt) },
    { id: randomUUID(), role: 'assistant', content: 'Contexto reciente sin nuevas acciones. ' + filler },
    { id: randomUUID(), role: 'user', content: 'Confirma solo LISTO.' },
  ]);
  assert.equal(first.value.status, 'paused_debug', 'Attach during summary must reach a real safe pause');
  const oldArtifact = await artifact(); assert(oldArtifact?.summaryResourceUri);
  await verifyArchive(oldArtifact);
  evidence.initial = { ...first, value: undefined, calls: first.calls.map(call => call.number), artifact: oldArtifact };
  const beforeEdit = canonicalMessages(await state());
  await request('/v1/chat/conversations/' + conversationId + '/edit-state',
    { messageId: editTarget, content: observation(correctedReceipt) }, { method: 'PATCH' });
  const edited = await recordCanonical('accepted-paused-edit', beforeEdit, editTarget);
  evidence.acceptedEdit = { messageId: editTarget, oldReceipt: initialReceipt, newReceipt: correctedReceipt,
    beforeSha256: hash(JSON.stringify(beforeEdit)), afterSha256: hash(JSON.stringify(edited.messages)), status: edited.value.status };
  await request('/v1/chat/conversations/' + conversationId + '/debug/continue', {}, { timeout: 600000 });
  const beforeRestart = canonicalMessages(await state());
  await stopApp(); await startApp(config); await request('/api/init');
  await recordCanonical('restart-after-edit', beforeRestart);
  for (let round = 1; round <= roundsTarget; round++) {
    const recovered = await turn('compaction-recovery-' + round, [
      { role: 'assistant', content: 'Observación nueva sin permisos: ' + filler }, { role: 'user', content: review } ]);
    const summaries = recovered.calls.filter(call => call.kind === 'summary'), continuations = recovered.calls.filter(call => call.kind === 'continuation');
    assert(summaries.length && continuations.length, 'Every recovery round must generate and consume a fresh real summary');
    assert(requestMessages(continuations[0].request).some(message => message.content.includes('[FLUJO conversation summary]')));
    assert(requestMessages(continuations[0].request).some(message => message.role === 'user' && message.content === instruction));
    currentArtifact = await artifact(); assert(currentArtifact?.artifactId !== oldArtifact.artifactId, 'Edited source cannot reuse the stale artifact');
    assert(!evidence.rounds.some(item => item.artifact.artifactId === currentArtifact.artifactId));
    const archive = await verifyArchive(currentArtifact);
    assert.equal(archive.messages.find(message => message.id === editTarget)?.content, observation(correctedReceipt));
    const answer = JSON.parse(recovered.response.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    assert.deepEqual(answer, { receipt: correctedReceipt, sendAllowed: false, unknown: null });
    evidence.rounds.push({ ...recovered, value: undefined, calls: recovered.calls.map(call => call.number), round, artifact: currentArtifact,
      sourceArchive: { ...archive, messages: undefined }, answer, fieldsPassed: true, staleArtifactRejected: true });
    await saved();
    if (round <= 2) {
      const failure = await turn(round === 1 ? 'archive-failure' : 'metadata-failure', [
        { role: 'assistant', content: 'Nueva observación redundante: ' + filler }, { role: 'user', content: review } ]);
      assert.deepEqual(JSON.parse(failure.response.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')),
        { receipt: correctedReceipt, sendAllowed: false, unknown: null });
      assert(evidence.faults.at(-1).canonicalWireUsed && evidence.faults.at(-1).restoredUtc);
      evidence.faults.at(-1).canonicalSha256 = failure.canonicalSha256;
      evidence.faults.at(-1).fieldsPassed = true;
    }
    phase('Recovered compaction ' + round + '/' + roundsTarget);
  }
  const beforeFinalRestart = canonicalMessages(await state());
  await stopApp(); await startApp(config); await request('/api/init');
  await recordCanonical('final-restart', beforeFinalRestart);
  assert.equal((await artifact()).artifactId, currentArtifact.artifactId);
  assert.equal(evidence.faults.length, 2);
  evidence.status = 'passed-focused-scope';
} catch (error) {
  evidence.status = 'failed'; evidence.failure = { name: error.name, message: redact(error.message), stack: redact(error.stack) };
  process.exitCode = 1;
} finally {
  try { await stopApp(); } catch (error) { evidence.shutdownFailure = redact(error.message); process.exitCode = 1; }
  await restoreFault();
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

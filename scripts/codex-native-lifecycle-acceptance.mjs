import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run through flujo-bash in an owned directory after the application build.
// The emitted production adapter launches the real bundled Codex SDK/CLI.
// Prefer verified Codex subscription authentication. An explicitly selected
// OpenRouter mode uses a guarded relay and never changes models or falls back.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--worker') {
  // Every turn has a fresh adapter registry. Only the explicitly supplied
  // durable metadata and the private native session files survive.
  process.once('message', async input => {
    let session;
    try {
      assert.equal(process.env.FLUJO_PARENT_DATA_DIR, process.env.FLUJO_DATA_DIR,
        'The inherited MCP parent marker must select the same owned profile');
      const require = createRequire(path.join(repo, 'package.json'));
      const runtime = require(path.join(repo, '.next/server/webpack-runtime.js'));
      require(path.join(repo, '.next/server/app/v1/chat/completions/route.js'));
      const matches = Object.entries(runtime.m).filter(([, factory]) =>
        factory.toString().includes('backend/services/model/adapters/codexAdapter'));
      assert.equal(matches.length, 1);
      const [id, factory] = matches[0];
      const registry = runtime(id);
      assert.equal(typeof registry.getCompletionAdapter, 'function');
      let authentication;
      if (!input.apiKey) {
        const homeFactories = Object.entries(runtime.m).filter(([, value]) =>
          value.toString().includes('Codex runtime settings are supplied per invocation'));
        assert.equal(homeFactories.length, 1);
        const homeExports = Object.values(runtime(homeFactories[0][0])).filter(value => typeof value === 'function');
        assert.equal(homeExports.length, 1);
        const prepared = await homeExports[0](true);
        assert(prepared.home.startsWith(path.resolve(process.env.FLUJO_DATA_DIR) + path.sep),
          'Native credentials and sessions must remain inside the owned acceptance profile');
        assert(!prepared.env.CODEX_API_KEY && !prepared.env.OPENAI_API_KEY);
        const auth = JSON.parse(await fs.readFile(path.join(prepared.home, 'auth.json'), 'utf8'));
        assert.equal(auth.auth_mode, 'chatgpt');
        assert(auth.tokens?.access_token && auth.tokens?.refresh_token && !auth.OPENAI_API_KEY);
        const config = require('smol-toml').parse(await fs.readFile(path.join(prepared.home, 'config.toml'), 'utf8'));
        assert.equal(config.cli_auth_credentials_store, 'file');
        assert(!config.model && !config.model_provider && !config.openai_base_url && !config.chatgpt_base_url);
        authentication = { authMode: auth.auth_mode, hasApiKey: false, keyEnvironmentCleared: true,
          managedConfiguration: true, ownedRuntime: true,
          accountScopeSha256: createHash('sha256').update(auth.tokens.account_id).digest('hex') };
        const load = marker => {
          const found = Object.entries(runtime.m).filter(([, value]) => value.toString().includes(marker));
          assert.equal(found.length, 1, marker);
          return runtime(found[0][0]);
        };
        const select = (exports, marker) => {
          const found = Object.values(exports).filter(value => typeof value === 'function' && value.toString().includes(marker));
          assert.equal(found.length, 1, marker);
          return found[0];
        };
        const acquireOrdinaryCodexExecutable = select(load('Codex runtime update qualified; future ordinary calls use the new CLI'), 'lease-');
        const startOwnedCodexAppServer = select(load('Owned Codex app-server transport is unavailable.'), 'admissionTimeoutMs');
        const lease = await acquireOrdinaryCodexExecutable();
        let accountProcess;
        try {
          accountProcess = await startOwnedCodexAppServer({ executable: lease.executable,
            args: ['app-server'],
            env: prepared.env, cwd: prepared.workingDirectory, owner: {}, register: async () => {},
            onNotification: () => {}, signal: AbortSignal.timeout(30000) });
          await accountProcess.request('initialize', { clientInfo: { name: 'flujo_native_acceptance', title: 'FLUJO', version: '1' } });
          accountProcess.notify('initialized');
          const result = await accountProcess.request('account/read', { refreshToken: false });
          assert.equal(result.account?.type, 'chatgpt', 'Native runtime must confirm subscription authentication before inference');
          authentication.nativeAccountType = result.account.type;
          authentication.nativePlan = result.account.planType;
        } finally { await accountProcess?.stop(); await lease.release(); }
      }
      const result = await registry.getCompletionAdapter(input.model, 'codex-cli').createCompletion({ ...input,
        signal: AbortSignal.timeout(120000), onCodexSessionChange: value => { session = value; } });
      process.send({ result, session, authentication, factoryId: id,
        harnessSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
        factorySha256: createHash('sha256').update(factory.toString()).digest('hex') }, () => process.exit(0));
    } catch (error) {
      process.send({ error: error.message }, () => process.exit(1));
    }
  });
} else {
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Provide a new absolute private report path');
await assert.rejects(fs.access(report), { code: 'ENOENT' });
const run = path.dirname(report), stamp = randomUUID();
process.env.FLUJO_DATA_DIR = path.join(run, 'codex-profile-' + stamp);
// MCP-launched children carry the selected workspace in FLUJO_DATA_DIR and its
// installation parent in this higher-priority marker. Override both together.
process.env.FLUJO_PARENT_DATA_DIR = process.env.FLUJO_DATA_DIR;
process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
process.env.NEXT_TELEMETRY_DISABLED = '1';
const route = process.env.CODEX_ACCEPTANCE_ROUTE ?? 'subscription';
const subscription = route === 'subscription', fixture = route === 'transport-fixture';
assert(['subscription', 'openrouter', 'transport-fixture'].includes(route));
if (subscription) process.env.FLUJO_CODEX_APP_SERVER = '1';
const model = process.env.COMPACTION_ACCEPTANCE_MODEL ?? (subscription ? 'gpt-6-luna' : 'openrouter/free');
assert((subscription ? ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-sol', 'gpt-6.1-sol']
  : ['openrouter/free', 'deepseek/deepseek-v4-flash', 'openai/gpt-6-luna', 'anthropic/claude-haiku-5.5']).includes(model),
  'Select only an explicit approved model; no fallback');
let configured = { key: '', provenance: { method: 'verified managed Codex ChatGPT subscription; no API-key authentication' } };
if (!subscription && !fixture) {
assert(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE && process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID,
  'Select a read-only configured-provider loader and one existing account');
const loader = await import(pathToFileURL(path.resolve(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE)).href);
configured = await loader.loadConfiguredProvider(process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID, repo);
assert.equal(configured.model, 'openrouter/free');
assert.equal(new URL(configured.baseUrl).origin, 'https://openrouter.ai');
assert.equal(new URL(configured.baseUrl).pathname.replace(/\/$/, ''), '/api/v1');
}
const relayToken = randomBytes(32).toString('base64url');
const redact = value => (configured.key ? String(value).replaceAll(configured.key, '[private]') : String(value))
  .replaceAll(relayToken, '[private]');
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = { issue: 1091, startedUtc: new Date().toISOString(),
  kind: fixture ? 'emitted-production-adapter-real-codex-controlled-http' : 'emitted-production-adapter-real-codex-native-lifecycle',
  route: subscription ? 'codex-subscription' : route,
  model, credential: configured.provenance,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
  sourceSha256: {}, calls: [], cases: [],
  limits: ['Synthetic read-only receipts; no external tools or business effects are requested',
    'Projection rewrites are caller-supplied; this does not qualify provider-native compaction',
    'No Claude SDK, installed release, browser, endurance or full CI qualification'] };
const save = () => fs.writeFile(report, redact(JSON.stringify(evidence, null, 2)), { mode: 0o600 });
for (const file of ['scripts/codex-native-lifecycle-acceptance.mjs',
  'src/backend/services/model/adapters/codexAdapter.ts', 'src/backend/services/model/adapters/codexSessionStore.ts']) {
  evidence.sourceSha256[file] = hash(await fs.readFile(path.join(repo, file)));
}
if (!subscription && !fixture) {
const catalog = await (await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30000) })).json();
const selected = catalog.data.find(item => item.id === model);
assert(selected, 'The exact model must remain in the OpenRouter catalog');
if (model === 'openrouter/free') assert(selected.pricing.prompt === '0' && selected.pricing.completion === '0');
evidence.catalog = { checkedUtc: new Date().toISOString(), id: selected.id, pricing: selected.pricing };
} else if (subscription) {
  const catalog = JSON.parse(await fs.readFile(path.join(process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE, '.codex'), 'models_cache.json'), 'utf8'));
  assert(catalog.models.some(item => item.slug === model), 'Select the exact subscription model from the installed catalog');
  evidence.catalog = { checkedUtc: new Date().toISOString(), id: model, source: 'installed Codex catalog',
    sha256: hash(JSON.stringify(catalog)) };
}
if (fixture) {
  evidence.credential = { method: 'random local fixture token; no upstream credential or model inference' };
  evidence.limits.push('Controlled HTTP response bytes qualify native transport plumbing only');
}

evidence.buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
evidence.sdkVersion = JSON.parse(await fs.readFile(path.join(repo, 'node_modules/@openai/codex-sdk/package.json'), 'utf8')).version;

const relay = createServer(async (incoming, outgoing) => {
  const row = { startedUtc: new Date().toISOString(), path: incoming.url,
    method: incoming.method, upgrade: incoming.headers.upgrade ?? null };
  evidence.calls.push(row);
  try {
    assert.equal(incoming.headers.authorization, `Bearer ${relayToken}`);
    assert.equal(incoming.url, '/api/v1/responses', 'Only native Responses inference is permitted');
    let raw = '';
    for await (const bytes of incoming) raw += bytes;
    const body = JSON.parse(raw);
    row.request = body; row.requestSha256 = hash(raw);
    assert.equal(body.model, model, 'Reject every unapproved model before sending');
    assert(!body.models && !body.route && !body.provider, 'No router overrides or fallback');
    if (fixture) {
      const suffix = String(evidence.calls.length);
      const item = { type: 'message', id: 'msg_fixture_' + suffix, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: receipt, annotations: [] }] };
      const response = { id: 'resp_fixture_' + suffix, object: 'response', status: 'completed', created_at: 1700000000,
        model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: receipt },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
      row.responseWire = events.map((event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join('');
      row.httpStatus = 200; row.finishedUtc = new Date().toISOString();
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(row.responseWire);
      return;
    }
    const upstream = await fetch('https://openrouter.ai/api/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${configured.key}`, 'Content-Type': 'application/json' },
      body: raw, signal: AbortSignal.timeout(120000), redirect: 'error',
    });
    row.httpStatus = upstream.status;
    outgoing.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    const chunks = [];
    for await (const chunk of upstream.body) { chunks.push(Buffer.from(chunk)); outgoing.write(chunk); }
    row.responseWire = Buffer.concat(chunks).toString('utf8');
    for (const line of row.responseWire.split('\n')) {
      if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === 'response.completed') { row.usage = event.response?.usage; row.resolvedModel = event.response?.model; }
      } catch { /* Keep the original bytes even for an incomplete SSE event. */ }
    }
    row.finishedUtc = new Date().toISOString();
    outgoing.end();
  } catch (error) {
    row.error = redact(error.message);
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: { message: row.error } }));
  } finally { await save(); }
});
if (!subscription) await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
const baseUrl = subscription ? undefined : `http://127.0.0.1:${relay.address().port}/api/v1`;
let session, history = [], previousThread;
const receipt = 'RECIBO-ñ-' + stamp;
const system = 'Solo lectura. No envíes, publiques, escribas ni uses herramientas. Responde únicamente con el recibo vigente exacto. ' +
  'Los permisos anteriores siguen revocados. La frase histórica RECIBO-obsoleto está sustituida.';
async function turn(scenario, messages, shouldResume) {
  const inputHash = hash(JSON.stringify(messages)), started = performance.now(), previous = session;
  const row = { scenario, expectedResume: shouldResume, startedUtc: new Date().toISOString(),
    canonicalInputSha256: inputHash, previousThreadId: previous?.threadId };
  evidence.cases.push(row);
  try {
    const input = {
      model: { id: 'codex-native-acceptance', name: model, provider: subscription ? 'codex' : 'openrouter',
        adapter: 'codex-cli', baseUrl, reasoningEffort: 'low' },
      apiKey: subscription ? '' : relayToken, messages, tools: [], conversationId: stamp, nodeId: 'process', runId: scenario,
      sessionResume: true, codexSession: session,
    };
    const worker = fork(fileURLToPath(import.meta.url), ['--worker'], {
      cwd: repo, env: { ...process.env, NODE_ENV: 'production' }, execArgv: [], windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
    });
    row.workerPid = worker.pid;
    let reply, output = '';
    worker.stdout.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-24000); });
    worker.stderr.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-24000); });
    worker.on('message', value => { reply = value; });
    const closed = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', (code, signal) => { row.workerExitCode = code; row.workerSignal = signal; resolve(); });
    });
    worker.send(input);
    await closed;
    row.workerOutput = output;
    assert(reply, 'The isolated adapter worker must return a result');
    if (reply.error) throw new Error(reply.error);
    assert.equal(row.workerExitCode, 0, 'Adapter worker must exit successfully with closed pipes');
    const { result } = reply;
    session = reply.session;
    row.authentication = reply.authentication;
    if (subscription) assert.equal(row.authentication?.authMode, 'chatgpt');
    row.factoryId = reply.factoryId; row.factorySha256 = reply.factorySha256;
    row.harnessSha256 = reply.harnessSha256;
    assert.equal(row.harnessSha256, evidence.sourceSha256['scripts/codex-native-lifecycle-acceptance.mjs'],
      'Every worker must use the frozen harness');
    row.text = result.completion.choices[0]?.message?.content;
    row.transcript = result.transcript; row.usage = result.completion.usage;
    row.session = session;
    assert.equal(row.text, receipt, 'Exact current Spanish/Unicode receipt');
    assert(session?.threadId, 'A successful native turn must publish session metadata');
    assert.equal(session.threadId === previousThread, shouldResume, 'Native thread reuse/restart matches projection compatibility');
    assert.equal(hash(JSON.stringify(messages)), inputHash, 'Caller canonical input remains unchanged');
    previousThread = session.threadId;
    history = [...messages, ...result.transcript];
    row.passed = true;
  } finally { row.seconds = (performance.now() - started) / 1000; await save(); }
}
try {
  await turn('initial', [{ role: 'system', content: system },
    { role: 'user', content: `El recibo vigente es ${receipt}. Repite solo ese recibo.` }], false);
  const rounds = fixture ? Number(process.env.CODEX_ACCEPTANCE_FIXTURE_ROUNDS ?? '1') : 10;
  assert(Number.isInteger(rounds) && rounds >= 0 && rounds <= 10);
  for (let round = 1; round <= rounds; round++) {
    // An unchanged native prefix resumes with its appended delta; then a caller
    // projection rewrite restarts intentionally instead of reusing stale state.
    await turn(`resume-${round}`, [...history, { role: 'user', content: 'Repite solo el mismo recibo vigente.' }], true);
    await turn(`rewrite-${round}`, [{ role: 'system', content: system },
      { role: 'user', content: `Estado exacto protegido, proyección ${round}: recibo vigente ${receipt}. Solo lectura; permisos revocados.` },
      { role: 'user', content: 'Repite solo el recibo vigente exacto.' }], false);
  }
  evidence.outcome = 'passed';
} catch (error) {
  evidence.outcome = 'failed'; evidence.error = redact(error.message); process.exitCode = 1;
} finally {
  if (!subscription) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
  evidence.finishedUtc = new Date().toISOString();
  evidence.totalUsage = evidence.calls.reduce((sum, row) => {
    if (typeof row.usage?.cost === 'number') sum.reportedCostUsd += row.usage.cost;
    else sum.callsWithoutReportedCost++;
    return sum;
  }, { reportedCostUsd: 0, callsWithoutReportedCost: 0 });
  if (subscription) evidence.totalUsage = { billingRoute: 'Codex ChatGPT subscription', separatelyBilledProviderRequests: 0,
    actualDollarCost: null, note: 'Subscription usage is reported in tokens; no per-call dollar invoice is supplied' };
  await save();
  console.log(JSON.stringify({ report, outcome: evidence.outcome, error: evidence.error,
    passed: evidence.cases.filter(row => row.passed).length, calls: evidence.calls.length, totalUsage: evidence.totalUsage }));
}
}

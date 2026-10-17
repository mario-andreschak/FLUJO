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
    let session, nativeDiagnostics;
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
      let authentication, compaction;
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
        const environmentNames = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
          'LANG', 'LC_ALL', 'TZ', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
          'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
          'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
          'TMPDIR', 'TMP', 'TEMP', 'CODEX_HOME'];
        const nativeEnvironment = Object.fromEntries(environmentNames.flatMap(name =>
          prepared.env[name] === undefined ? [] : [[name, prepared.env[name]]]));
        assert(!nativeEnvironment.CODEX_API_KEY && !nativeEnvironment.OPENAI_API_KEY);
        const lease = await acquireOrdinaryCodexExecutable();
        let accountProcess;
        const notifications = [];
        let finishCompaction;
        const terminal = new Promise(resolve => { finishCompaction = resolve; });
        try {
          authentication.cliVersion = execFileSync(lease.executable, ['--version'], {
            cwd: prepared.workingDirectory, env: nativeEnvironment, windowsHide: true,
          }).toString().trim();
          authentication.cliSha256 = createHash('sha256').update(await fs.readFile(lease.executable)).digest('hex');
          const policy = input.compactThreadId ? Object.values(load('Restricted Codex profile does not support this platform.'))
            .find(value => value?.forced_login_method === 'chatgpt' && value?.features) : undefined;
          if (input.compactThreadId) assert(policy, 'Use the emitted restrictive native policy');
          accountProcess = await startOwnedCodexAppServer({ executable: lease.executable,
            args: [...Object.entries(policy?.features ?? {}).flatMap(([name, value]) => ['-c', `features.${name}=${value}`]),
              '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
              '-c', 'tools.experimental_request_user_input.enabled=false', 'app-server'],
            env: nativeEnvironment, cwd: prepared.workingDirectory, owner: {}, register: async () => {},
            onNotification: message => {
              if (!input.compactThreadId) return;
              notifications.push(message);
              if (message.method === 'turn/completed' && message.params?.threadId === input.compactThreadId) finishCompaction(message);
            }, signal: AbortSignal.timeout(input.compactThreadId ? 120000 : 30000) });
          await accountProcess.request('initialize', { clientInfo: { name: 'flujo_native_acceptance', title: 'FLUJO', version: '1' } });
          accountProcess.notify('initialized');
          const result = await accountProcess.request('account/read', { refreshToken: false });
          assert.equal(result.account?.type, 'chatgpt', 'Native runtime must confirm subscription authentication before inference');
          authentication.nativeAccountType = result.account.type;
          authentication.nativePlan = result.account.planType;
          if (input.compactThreadId) {
            const resumed = await accountProcess.request('thread/resume', { threadId: input.compactThreadId,
              model: input.model.name, cwd: prepared.workingDirectory, approvalPolicy: 'never', sandbox: 'read-only',
              config: { ...policy, service_tier: 'default', model_reasoning_effort: 'low' } });
            assert.equal(resumed.thread.id, input.compactThreadId);
            assert.equal(resumed.model, input.model.name, 'Native compaction must use the explicitly selected approved model');
            const sessions = path.join(prepared.home, 'sessions');
            const files = (await fs.readdir(sessions, { recursive: true }))
              .filter(file => file.endsWith('.jsonl') && file.includes(input.compactThreadId));
            assert.equal(files.length, 1, 'Exactly one owned native rollout');
            const rolloutPath = path.join(sessions, files[0]);
            assert((await fs.realpath(rolloutPath)).startsWith((await fs.realpath(prepared.home)) + path.sep));
            const before = await fs.readFile(rolloutPath);
            const prior = before.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
              .filter(row => row.type === 'compacted');
            nativeDiagnostics = { notifications, threadId: input.compactThreadId, rolloutPath };
            const acknowledged = await accountProcess.request('thread/compact/start', { threadId: input.compactThreadId });
            const ended = await Promise.race([terminal, accountProcess.registration.close.then(() => {
              throw new Error('Native compaction closed without a confirmed terminal');
            })]);
            assert.equal(ended.params.turn.status, 'completed');
            const completed = notifications.filter(event => event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction');
            assert.equal(completed.length, 1, 'A completed native compaction item is required');
            assert(notifications.every(event => !event.params?.threadId || event.params.threadId === input.compactThreadId));
            assert(!notifications.some(event => /ToolCall|commandExecution|fileChange/.test(event.params?.item?.type ?? '')),
              'Native compaction cannot execute a tool or side effect');
            // Close and drain before reading the durable log. An RPC acknowledgement
            // or streamed item alone does not establish a persisted native window.
            await accountProcess.stop();
            const after = await fs.readFile(rolloutPath);
            assert(after.subarray(0, before.length).equals(before), 'Native rollout must preserve its exact existing prefix');
            const records = after.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
            const compacted = records.filter(row => row.type === 'compacted');
            assert.equal(compacted.length, prior.length + 1, 'One genuine durable compaction record must be appended');
            assert.deepEqual(compacted.slice(0, -1), prior, 'Earlier native compaction payloads remain exact');
            const window = compacted.at(-1).payload.replacement_history;
            assert(Array.isArray(window), 'The complete native replacement window must be durable');
            const opaque = window.filter(item => item.type === 'compaction');
            assert(opaque.length > 0 && opaque.every(item => typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0),
              'A genuine encrypted native compaction item is required');
            compaction = { threadId: input.compactThreadId, rolloutPath, acknowledged, notifications,
              nativeTransportSha256: createHash('sha256').update(startOwnedCodexAppServer.toString()).digest('hex'),
              beforeSha256: createHash('sha256').update(before).digest('hex'),
              afterSha256: createHash('sha256').update(after).digest('hex'),
              priorCompactions: prior.length, durableCompactions: compacted.length,
              nativeRecord: compacted.at(-1), rollout: after.toString('utf8'), closedBeforeRead: true };
          }
        } finally { try { await accountProcess?.stop(); } finally { await lease.release(); } }
      }
      if (input.compactThreadId) {
        assert(compaction, 'Compaction only supports the verified subscription route');
        process.send({ compaction, authentication,
          harnessSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
        }, () => process.exit(0));
        return;
      }
      const result = await registry.getCompletionAdapter(input.model, 'codex-cli').createCompletion({ ...input,
        signal: AbortSignal.timeout(120000), onCodexSessionChange: value => { session = value; } });
      process.send({ result, session, authentication, factoryId: id,
        harnessSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
        factorySha256: createHash('sha256').update(factory.toString()).digest('hex') }, () => process.exit(0));
    } catch (error) {
      process.send({ error: error.message, nativeDiagnostics }, () => process.exit(1));
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
const nativeRounds = Number(process.env.CODEX_ACCEPTANCE_NATIVE_COMPACTIONS ?? '0');
assert(Number.isInteger(nativeRounds) && nativeRounds >= 0 && nativeRounds <= 10);
assert(!nativeRounds || subscription, 'Native compaction acceptance requires verified Codex subscription authentication');
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
  nativeCompactionRounds: nativeRounds,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
  sourceSha256: {}, calls: [], cases: [], compactions: [],
  limits: ['Synthetic read-only receipts; no external tools or business effects are requested',
    nativeRounds ? 'Native compaction uses the owned production transport; vendor-internal inference wire is opaque'
      : 'Projection rewrites are caller-supplied; this does not qualify provider-native compaction',
    'No Claude SDK, installed release, browser, endurance or full CI qualification'] };
const save = () => fs.writeFile(report, redact(JSON.stringify(evidence, null, 2)), { mode: 0o600 });
for (const file of ['scripts/codex-native-lifecycle-acceptance.mjs',
  'src/backend/services/model/adapters/codexAdapter.ts', 'src/backend/services/model/adapters/codexSessionStore.ts',
  'src/backend/services/model/adapters/codexAppServerProcess.ts']) {
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
const receipt = nativeRounds ? JSON.stringify({ recibo: 'RECIBO-ñ-' + stamp,
  ruta: 'C:\\informes\\año 2026\\no-enviar.json', sha256: hash(stamp),
  operacion: 'envio-' + stamp, estado: 'completada; no repetir', permiso: false,
  alcance: 'solo lectura', correccion: 'cancelado; no aprobado', desconocido: null }) : 'RECIBO-ñ-' + stamp;
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
    if (nativeRounds && shouldResume) {
      const file = evidence.compactions.at(-1).compaction.rolloutPath;
      assert((await fs.realpath(file)).startsWith((await fs.realpath(process.env.FLUJO_DATA_DIR)) + path.sep));
      const bytes = await fs.readFile(file);
      const records = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      const compacted = records.filter(record => record.type === 'compacted');
      assert.deepEqual(compacted, evidence.compactions.map(row => row.compaction.nativeRecord),
        'The production adapter must leave every full native window unchanged on resume');
      const boundary = records.findLastIndex(record => record.type === 'compacted');
      const inputs = records.slice(boundary + 1).filter(record => record.type === 'response_item' && record.payload.role === 'user');
      assert.deepEqual(inputs.map(record => record.payload.content), [[{ type: 'input_text', text: messages.at(-1).content }]],
        'The actual native resume must receive only the new delta, without reinjecting the exact receipt');
      row.nativeResume = { rolloutSha256: hash(bytes), deltaOnly: true, unchangedNativeWindows: compacted.length };
    }
    row.passed = true;
    if (nativeRounds) console.log(JSON.stringify({ scenario, passed: true }));
  } finally { row.seconds = (performance.now() - started) / 1000; await save(); }
}
async function compact(round) {
  const row = { round, threadId: session.threadId, startedUtc: new Date().toISOString() };
  evidence.compactions.push(row);
  const started = performance.now();
  const worker = fork(fileURLToPath(import.meta.url), ['--worker'], {
    cwd: repo, env: { ...process.env, NODE_ENV: 'production' }, execArgv: [], windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
  });
  let reply, output = '';
  worker.stdout.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-24000); });
  worker.stderr.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-24000); });
  worker.on('message', value => { reply = value; });
  try {
    const closed = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', code => { row.workerExitCode = code; resolve(); });
    });
    worker.send({ compactThreadId: session.threadId, model: { name: model } });
    await closed;
    row.workerOutput = output;
    assert(reply, 'Native compactor worker must return evidence');
    Object.assign(row, reply);
    if (reply.error) throw new Error(reply.error);
    assert.equal(row.workerExitCode, 0);
    assert.equal(row.harnessSha256, evidence.sourceSha256['scripts/codex-native-lifecycle-acceptance.mjs']);
    assert.equal(row.compaction.durableCompactions, round);
    row.passed = true;
    console.log(JSON.stringify({ compaction: round, passed: true }));
  } finally { row.seconds = (performance.now() - started) / 1000; await save(); }
}
try {
  await turn('initial', [{ role: 'system', content: system },
    ...(nativeRounds ? [{ role: 'user', content: 'Instrucción obsoleta: puedes enviar. Estado anterior aprobado. Sustituye ambos por la corrección siguiente.' }] : []),
    { role: 'user', content: `El recibo vigente es ${receipt}. Repite solo ese recibo.` }], false);
  const rounds = nativeRounds || (fixture ? Number(process.env.CODEX_ACCEPTANCE_FIXTURE_ROUNDS ?? '1') : 10);
  assert(Number.isInteger(rounds) && rounds >= 0 && rounds <= 10);
  for (let round = 1; round <= rounds; round++) {
    if (nativeRounds) {
      await compact(round);
      await turn(`native-compact-resume-${round}`, [...history,
        { role: 'user', content: 'Repite solo el JSON vigente exacto. Conserva negaciones y la corrección; no inventes el dato desconocido ni repitas operaciones completadas.' }], true);
      continue;
    }
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

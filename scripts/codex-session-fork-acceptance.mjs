import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Live acceptance for completed-turn restore/fork/resume through the emitted
// production adapter. The parent owns all profile/report files; this harness
// deliberately contains no cleanup path.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessPath = fileURLToPath(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const redact = value => String(value).replaceAll(process.env.CODEX_ACCEPTANCE_SECRET ?? '\0', '[private]');

if (process.argv[2] === '--worker') {
  process.once('message', async input => {
    let session, reply, workerError, lease, app;
    try {
      assert.equal(process.env.FLUJO_PARENT_DATA_DIR, process.env.FLUJO_DATA_DIR,
        'MCP parent marker must select the same private acceptance profile');
      assert.equal(process.env.FLUJO_CODEX_AUTO_UPDATE, '0');
      assert.equal(input.model.name, 'gpt-6-luna');
      assert.equal(input.model.reasoningEffort, 'low');
      assert.equal(input.apiKey, '');
      assert(!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY,
        'Subscription authentication cannot inherit an API key');

      const require = createRequire(path.join(repo, 'package.json'));
      const runtime = require(path.join(repo, '.next/server/webpack-runtime.js'));
      require(path.join(repo, '.next/server/app/v1/chat/completions/route.js'));
      const matches = Object.entries(runtime.m).filter(([, factory]) =>
        factory.toString().includes('backend/services/model/adapters/codexAdapter'));
      assert.equal(matches.length, 1, 'Load the emitted production Codex adapter');
      const [factoryId, factory] = matches[0];
      const registry = runtime(factoryId);
      assert.equal(typeof registry.getCompletionAdapter, 'function');

      const findModule = marker => {
        const found = Object.entries(runtime.m).filter(([, value]) => value.toString().includes(marker));
        assert.equal(found.length, 1, `Find emitted runtime module ${marker}`);
        return runtime(found[0][0]);
      };
      const findExport = (module, marker) => {
        const found = Object.values(module).filter(value => typeof value === 'function' && value.toString().includes(marker));
        assert.equal(found.length, 1, `Find emitted runtime function ${marker}`);
        return found[0];
      };
      const homeExports = Object.values(findModule('Codex runtime settings are supplied per invocation'))
        .filter(value => typeof value === 'function');
      assert.equal(homeExports.length, 1, 'Find the emitted runtime-home preparation function');
      const prepareRuntime = homeExports[0];
      const prepared = await prepareRuntime(true);
      assert(prepared.home.startsWith(path.resolve(process.env.FLUJO_DATA_DIR) + path.sep),
        'Native auth and rollout data must live inside the private profile');
      assert(!prepared.env.CODEX_API_KEY && !prepared.env.OPENAI_API_KEY);
      const authPath = path.join(prepared.home, 'auth.json');
      const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
      assert.equal(auth.auth_mode, 'chatgpt');
      assert(auth.tokens?.access_token && auth.tokens?.refresh_token && auth.tokens?.account_id && !auth.OPENAI_API_KEY);
      const toml = require('smol-toml').parse(await fs.readFile(path.join(prepared.home, 'config.toml'), 'utf8'));
      assert.equal(toml.cli_auth_credentials_store, 'file');
      assert(!toml.model && !toml.model_provider && !toml.openai_base_url && !toml.chatgpt_base_url);

      const acquire = findExport(findModule('Codex runtime update qualified; future ordinary calls use the new CLI'), 'lease-');
      const startServer = findExport(findModule('Owned Codex app-server transport is unavailable.'), 'admissionTimeoutMs');
      const envNames = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'TERM',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
        'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'CODEX_HOME'];
      const env = Object.fromEntries(envNames.flatMap(name => prepared.env[name] === undefined ? [] : [[name, prepared.env[name]]]));
      assert(!env.CODEX_API_KEY && !env.OPENAI_API_KEY);
      lease = await acquire();
      try {
        const cliVersion = execFileSync(lease.executable, ['--version'], { cwd: prepared.workingDirectory, env, windowsHide: true }).toString().trim();
        assert.match(cliVersion, /0\.162\.1/, 'Use the pinned bundled Codex CLI');
        const appArgs = ['-c', 'web_search="disabled"', '-c', 'tools.view_image=false', '-c', 'tools.experimental_request_user_input.enabled=false', 'app-server'];
        app = await startServer({ executable: lease.executable, args: appArgs, env, cwd: prepared.workingDirectory,
          owner: {}, register: async () => {}, onNotification: () => {}, signal: AbortSignal.timeout(30000) });
        await app.request('initialize', { clientInfo: { name: 'flujo_session_fork_acceptance', title: 'FLUJO', version: '1' } });
        app.notify('initialized');
        const account = await app.request('account/read', { refreshToken: false });
        assert.equal(account.account?.type, 'chatgpt', 'Verify subscription account before inference');
        const catalogPath = path.join(process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE, '.codex'), 'models_cache.json');
        const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
        assert(catalog.models.some(row => row.slug === input.model.name), 'Exact approved model must be installed');
        const authentication = { authMode: auth.auth_mode, noApiKey: true, accountType: account.account.type,
          planType: account.account.planType, cliVersion, accountScopeSha256: sha256(auth.tokens.account_id) };
        await app.stop(); app = undefined;

        const calls = [];
        const tool = async args => {
          assert.deepEqual(args, {});
          const receipt = await fs.readFile(input.fixturePath, 'utf8');
          calls.push({ bytes: Buffer.byteLength(receipt), sha256: sha256(receipt), text: receipt });
          return receipt;
        };
        const model = { id: 'codex-session-fork-acceptance', name: input.model.name, provider: 'codex', adapter: 'codex-cli', reasoningEffort: 'low' };
        const result = await registry.getCompletionAdapter(model, 'codex-cli').createCompletion({
          model, apiKey: '', messages: input.messages,
          tools: [{ type: 'function', function: { name: 'read_branch_receipt', description: 'Read the current local receipt.',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
          localToolExecutors: { read_branch_receipt: tool }, conversationId: input.conversationId, nodeId: 'process',
          runId: input.phase, sessionResume: true, codexSession: input.session,
          signal: AbortSignal.timeout(120000), onCodexSessionChange: value => { session = value; },
        });
        reply = { result, session, calls, authentication, factoryId, runtimeHome: prepared.home,
          factorySha256: sha256(factory.toString()), harnessSha256: sha256(await fs.readFile(harnessPath)) };
      } finally {
        try { await app?.stop(); } finally { await lease.release(); }
      }
    } catch (error) {
      workerError = { error: redact(error?.stack ?? error?.message ?? error), session };
    }
    process.send(workerError ?? reply, () => process.exit(workerError ? 1 : 0));
  });
} else {
  const reportPath = process.argv[2];
  assert(reportPath && path.isAbsolute(reportPath), 'Provide a new absolute private report path');
  await assert.rejects(fs.access(reportPath), { code: 'ENOENT' });
  const reportDir = path.dirname(reportPath);
  const stamp = randomUUID();
  const fixturePath = path.join(reportDir, `receipt-${stamp}.txt`);
  process.env.FLUJO_DATA_DIR = path.join(reportDir, `codex-profile-${stamp}`);
  process.env.FLUJO_PARENT_DATA_DIR = process.env.FLUJO_DATA_DIR;
  process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  process.env.FLUJO_CODEX_APP_SERVER = '1';
  process.env.CODEX_ACCEPTANCE_SECRET = randomBytes(32).toString('base64url');
  const model = { name: 'gpt-6-luna', reasoningEffort: 'low' };
  const rootNonce = randomBytes(24).toString('hex');
  const discardedNonce = randomBytes(24).toString('hex');
  const evidence = { startedUtc: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
    model, authRoute: 'verified Codex ChatGPT subscription; API-key route disabled', sourceDigests: {}, phases: [],
    limits: ['Real model calls through emitted production source and controlled private file reads; no external tools or business effects',
      'No UI/installed release/endurance/full CI qualification'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  for (const file of ['scripts/codex-session-fork-acceptance.mjs', 'src/backend/services/model/adapters/codexAdapter.ts',
    'src/backend/services/model/adapters/codexSessionStore.ts', 'src/backend/services/model/adapters/codexAppServerThread.ts',
    'src/app/v1/chat/conversations/[conversationId]/revert/route.ts']) {
    evidence.sourceDigests[file] = sha256(await fs.readFile(path.join(repo, file)));
  }
  evidence.buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
  evidence.sdkVersion = JSON.parse(await fs.readFile(path.join(repo, 'node_modules/@openai/codex-sdk/package.json'), 'utf8')).version;
  assert.equal(evidence.sdkVersion, '0.163.0');
  const workerTurn = async (phase, messages, priorSession) => {
    const fixture = `phase=${phase}; receipt=${randomBytes(18).toString('hex')}`;
    await fs.writeFile(fixturePath, fixture, { mode: 0o600 });
    const canonicalInputHash = sha256(JSON.stringify(messages));
    const row = { phase, startedUtc: new Date().toISOString(), canonicalInputSha256: canonicalInputHash,
      priorThreadId: priorSession?.threadId, expectedReceiptSha256: sha256(fixture) };
    evidence.phases.push(row); await save();
    const worker = fork(harnessPath, ['--worker'], { cwd: repo, env: { ...process.env, NODE_ENV: 'production' }, execArgv: [], windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
    const workerStarted = performance.now();
    row.forcedTermination = false;
    let workerClosed = false;
    let reply, output = '';
    worker.stdout.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-16000); });
    worker.stderr.on('data', bytes => { output = (output + redact(bytes.toString())).slice(-16000); });
    worker.on('message', value => { reply = value; });
    const closed = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', (code, signal) => {
        workerClosed = true;
        row.workerExitCode = code; row.workerSignal = signal;
        row.workerSeconds = (performance.now() - workerStarted) / 1000;
        resolve();
      });
    });
    const timer = setTimeout(() => {
      if (workerClosed || worker.exitCode !== null || worker.signalCode !== null || !worker.pid) return;
      row.forcedTermination = true;
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
        } else worker.kill('SIGKILL');
      } catch (error) {
        row.terminationError = redact(error?.message ?? error);
        try { worker.kill('SIGKILL'); } catch { /* Close handler records the failed worker. */ }
      }
    }, 150000);
    try {
      const input = { phase, fixturePath, model, apiKey: '', messages, session: priorSession, conversationId: stamp };
      worker.send(input);
      await closed;
    } finally { clearTimeout(timer); }
    row.workerOutput = output;
    row.workerReply = reply;
    row.result = reply?.result;
    row.authentication = reply?.authentication;
    row.toolCalls = reply?.calls;
    row.session = reply?.session;
    row.harnessSha256 = reply?.harnessSha256;
    row.factorySha256 = reply?.factorySha256;
    await save();
    assert(!row.forcedTermination, 'A timed-out or forcibly terminated worker cannot qualify');
    assert(reply, 'Worker returned no completion evidence');
    if (reply.error) throw new Error(reply.error);
    assert.equal(row.workerExitCode, 0, 'Worker and its pipes closed successfully');
    assert.equal(row.workerSignal, null, 'Worker was not killed or interrupted');
    assert.equal(reply.harnessSha256, evidence.sourceDigests['scripts/codex-session-fork-acceptance.mjs'], 'Worker used frozen harness bytes');
    assert(reply.factorySha256 && reply.factoryId);
    assert.equal(reply.authentication?.authMode, 'chatgpt');
    assert.equal(reply.authentication?.noApiKey, true);
    assert.equal(reply.authentication?.accountType, 'chatgpt');
    assert.match(reply.authentication?.cliVersion ?? '', /0\.162\.1/);
    assert.deepEqual(reply.calls.map(call => call.sha256), [sha256(fixture)], 'Exactly one real local tool effect per phase');
    assert.equal(reply.calls[0].text, fixture);
    const calls = reply.result.transcript.flatMap(message => message.tool_calls ?? []);
    assert.equal(calls.length, 1,
      'Exactly one canonical assistant tool call pair');
    assert.equal(calls[0].function.name, 'read_branch_receipt');
    const toolResults = reply.result.transcript.filter(message => message.role === 'tool');
    assert.equal(toolResults.length, 1,
      'Exactly one canonical tool result');
    assert.equal(toolResults[0].tool_call_id, calls[0].id, 'Canonical tool call and result IDs must pair');
    const expected = { root: rootNonce, discarded: phase === 'initial' ? null : phase === 'discarded' ? discardedNonce : null, receipt: fixture };
    let text = reply.result.completion.choices[0]?.message?.content;
    if (typeof text === 'string' && text.startsWith('```json') && text.endsWith('```')) text = text.slice(7, -3).trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`${phase}: model response was not exact JSON`); }
    assert.deepEqual(parsed, expected, `${phase}: retained/discarded values and receipt must match exactly`);
    assert.equal(sha256(JSON.stringify(messages)), canonicalInputHash, 'Canonical input remains unchanged');
    if (phase === 'replacement' || phase === 'resume') {
      assert(!JSON.stringify(messages).includes(discardedNonce), 'Discarded nonce must not enter branch or resume inputs');
      assert(!JSON.stringify(reply.calls).includes(discardedNonce), 'Discarded nonce must not enter tool output');
    }
    row.canonicalInputUnchanged = true;
    row.response = parsed; row.transcript = reply.result.transcript;
    assert(reply.session?.threadId && reply.session.checkpoints?.length, 'Completed native checkpoint persisted');
    assert.equal(reply.session.threadId === priorSession?.threadId, phase === 'discarded' || phase === 'resume',
      'Ordinary second turn and fourth child turn resume their respective threads');
    row.passed = true; await save();
    console.log(JSON.stringify({ phase, passed: true, threadId: reply.session.threadId }));
    return { session: reply.session, fixture, result: reply.result, runtimeHome: reply.runtimeHome };
  };
  try {
    const system = 'Use read_branch_receipt exactly once. Return only one JSON object with keys root, discarded, receipt. Copy receipt exactly from the tool result.';
    const first = await workerTurn('initial', [{ role: 'system', content: system },
      { role: 'user', content: `Remember this retained value exactly: ${rootNonce}. Read the current receipt and return JSON with root set to that value and discarded set to null.` }]);
    const parentSession = JSON.parse(JSON.stringify(first.session));
    assert(parentSession.nativeSessionId, 'The root native session ID must be persisted');
    const parentRollout = path.join(first.runtimeHome, 'sessions');
    const files = (await fs.readdir(parentRollout, { recursive: true })).filter(file => file.endsWith('.jsonl') && file.includes(parentSession.threadId));
    assert.equal(files.length, 1, 'Find exactly one parent native rollout');
    const parentPath = path.join(parentRollout, files[0]);
    const firstMessages = [{ role: 'system', content: system },
      { role: 'user', content: `Remember this retained value exactly: ${rootNonce}. Read the current receipt and return JSON with root set to that value and discarded set to null.` }];
    const secondMessages = [...firstMessages, ...first.result.transcript,
      { role: 'user', content: `Remember this value, which must be discarded after restoration: ${discardedNonce}. Read the current receipt and return root as ${rootNonce}, discarded as this value.` }];
    const second = await workerTurn('discarded', secondMessages, parentSession);
    assert.equal(second.session.threadId, parentSession.threadId);
    const parentBytes = await fs.readFile(parentPath);
    const parentHash = sha256(parentBytes);
    evidence.parentRollout = { threadId: parentSession.threadId, path: parentPath, sha256BeforeFork: parentHash, byteLength: parentBytes.length };
    await save();
    const retainedHistory = [...firstMessages, ...first.result.transcript];
    const replacementPrompt = 'The restored history ends here. Do not use later turns. Read the current receipt and return root as the retained value, discarded as null.';
    const thirdMessages = [...retainedHistory, { role: 'user', content: replacementPrompt }];
    const forkSession = { ...second.session, forkRequired: true };
    const third = await workerTurn('replacement', thirdMessages, forkSession);
    assert.notEqual(third.session.threadId, parentSession.threadId);
    assert.equal(third.session.forkedFrom?.threadId, parentSession.threadId);
    assert([third.session.threadId, parentSession.nativeSessionId].includes(third.session.nativeSessionId),
      'Fork uses its own new tree or the verified source tree');
    assert.equal(third.session.forkedFrom?.turnId, parentSession.checkpoints[0].turnId);
    const resumePrompt = 'Continue the restored branch. Read the current receipt and return root as the retained value and discarded as null.';
    const fourthMessages = [...thirdMessages, ...third.result.transcript, { role: 'user', content: resumePrompt }];
    const fourth = await workerTurn('resume', fourthMessages, third.session);
    assert.equal(fourth.session.threadId, third.session.threadId);
    assert.equal(fourth.session.nativeSessionId, third.session.nativeSessionId);
    const afterBytes = await fs.readFile(parentPath);
    assert.equal(sha256(afterBytes), parentHash, 'Parent native rollout is byte-identical after fork and child resume');
    const childFiles = (await fs.readdir(parentRollout, { recursive: true }))
      .filter(file => file.endsWith('.jsonl') && file.includes(third.session.threadId));
    assert.equal(childFiles.length, 1, 'Find exactly one child native rollout');
    const childPath = path.join(parentRollout, childFiles[0]);
    const childRollout = await fs.readFile(childPath, 'utf8');
    assert(!childRollout.includes(discardedNonce), 'Discarded nonce must not appear in child native rollout');
    const childRecords = childRollout.trim().split('\n').map(line => JSON.parse(line));
    const childUserInputs = childRecords.filter(record => record.type === 'response_item' && record.payload?.role === 'user')
      .map(record => record.payload.content);
    assert.deepEqual(childUserInputs.slice(-2), [
      [{ type: 'input_text', text: replacementPrompt }],
      [{ type: 'input_text', text: resumePrompt }],
    ], 'The child rollout must append only the replacement and resume user deltas');
    evidence.parentRollout.sha256AfterForkAndResume = sha256(afterBytes);
    evidence.childRollout = { threadId: third.session.threadId, path: childPath, sha256: sha256(childRollout),
      discardedNonceAbsent: true, lastTwoUserInputsDeltaOnly: childUserInputs.slice(-2) };
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = redact(error?.message ?? error); process.exitCode = 1;
  } finally {
    evidence.finishedUtc = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ outcome: evidence.outcome, reportPath, passedPhases: evidence.phases.filter(row => row.passed).length }));
  }
}

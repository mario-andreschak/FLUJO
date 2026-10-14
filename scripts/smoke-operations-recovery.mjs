#!/usr/bin/env node
// Source-built, disposable #570 integration. Never an installed-release qualification.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator, approveSmokeServer } from './smoke-bundled-operator.mjs';
import { checkHealth } from './healthcheck.mjs';
import { boundedJson } from './worker-recovery-acceptance.mjs';
import { verifyBuildEvidence } from './operations-acceptance/build-evidence.mjs';

const args = process.argv.slice(2);
assert.ok([4, 6].includes(args.length) && args[0] === '--report' && path.isAbsolute(args[1]) && args[2] === '--build-evidence'
  && (args.length === 4 || args[4] === '--fail-at' && ['enable-response', 'expired-owner-deadline'].includes(args[5])),
  'Usage: node scripts/smoke-operations-recovery.mjs --report <new-absolute-report> --build-evidence <absolute-build-receipt> [--fail-at enable-response|expired-owner-deadline]');
const failAt = args[5];
const reportPath = path.resolve(args[1]);
const application = fileURLToPath(new URL('../', import.meta.url));
const buildId = (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim();
const buildEvidence = await verifyBuildEvidence(application, args[3]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: application, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'package.json', 'package-lock.json', 'next.config.mjs'],
  { cwd: application, encoding: 'utf8' }), '', 'Application inputs must match the recorded source revision.');
await assert.rejects(fs.access(reportPath), { code: 'ENOENT' });
const operator = await createSmokeOperator();
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const workspace = 'default-workspace';
const password = randomBytes(32).toString('base64url');
const providerKey = randomBytes(32).toString('base64url');
const answer = 'operations-acceptance-response';
const serverName = 'bash';
const effectDirectory = path.join(root, 'data/workspaces/default-workspace/userdata/operations-effect-fixture');
const observations = [], exits = [], requests = [];
let replans = 0;
let child, closed, base, mode = 'success', marker, serverLog = '', outcome = 'failed', fixtureActive = false, fixtureHasConsent = false;
const startedAt = new Date().toISOString();
const injectedDeadline = new AbortController();
const budget = AbortSignal.any([AbortSignal.timeout(12 * 60 * 1000), injectedDeadline.signal]);
const limits = [
  'Source-built Windows/Linux profile only; no packed, installed, container or release acceptance.',
  'Owned loopback provider and synthetic disk effect; no cloud account, inference or billing acceptance.',
  'HTTP 408 is a provider-reported timeout; the five-hour SDK elapsed timeout is not exercised.',
  'Graceful owner restart only; worker epoch/catch-up, abrupt crash, disk full, migration and snapshot restore are separate criteria.',
  'Next child exits are observed; no detached-descendant or isolated-container removal claim.',
  'Operations history/approval indices are diagnostics and are checked against actual effect observations.',
  'Independent operator install/upgrade/restore and exact supported release profiles remain pre-flight.',
];
const provider = http.createServer(async (request, response) => {
  try {
    const parts = []; let bytes = 0;
    for await (const part of request) { bytes += part.length; assert.ok(bytes <= 256 * 1024); parts.push(part); }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.ok(requests.length < 100, 'Provider fixture request budget exceeded.');
    requests.push({ mode, stream: body.stream === true, at: new Date().toISOString() });
    const status = { timeout: 408, 'rate-limit': 429, 'bad-request': 400 }[mode];
    if (status) {
      response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0.01' });
      response.end(JSON.stringify({ error: { message: `Synthetic ${mode} failure (${status}).`, type: 'acceptance_failure' } }));
      return;
    }
    const hasResult = body.messages.some(message => message.role === 'tool');
    const lastResult = body.messages.findLast(message => message.role === 'tool');
    const stale = mode === 'approval' && marker === 'retained-approval' && typeof lastResult?.content === 'string'
      && lastResult.content.includes('Stale tool call:') && lastResult.content.includes('re-registered');
    const tool = body.tools?.find(value => /(?:^|_)run$/.test(value.function?.name ?? ''));
    if (mode === 'approval') assert.ok(tool || hasResult, 'The authored Flow did not advertise its actual fixture tool.');
    if (mode === 'approval' && hasResult && marker === 'retained-approval' && !stale) {
      assert.ok(typeof lastResult.content === 'string' && lastResult.content.includes('Synthetic effect recorded.'),
        `Fixture tool did not report completion: ${JSON.stringify(lastResult.content).slice(0, 1200)}`);
    }
    if (stale) { replans++; assert.equal(replans, 1, 'Fresh fixture proposal was also stale.'); assert.equal((await effectRows()).length, 0); }
    const toolCalls = mode === 'approval' && (!hasResult || stale)
      ? [{ id: `fixture-${marker}${stale ? '-fresh' : ''}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(effectArguments(marker)) } }]
      : undefined;
    const info = { id: `operations-${requests.length}`, model: body.model, created: Math.floor(Date.now() / 1000) };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: toolCalls ? { role: 'assistant', tool_calls: toolCalls.map(call => ({ index: 0, ...call })) } : { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...info, object: 'chat.completion', choices: [{ index: 0,
        message: toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: answer },
        finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch (error) {
    if (mode === 'approval') console.error(error.message);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic provider rejected the acceptance request.' } }));
  }
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() { const probe = http.createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve)); return port; }
async function api(endpoint, { body, method = body === undefined ? 'GET' : 'POST', status = 200, token = operator.token, timeout = 60000, cleanup = false } = {}) {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { method, redirect: 'error', signal: cleanup ? AbortSignal.timeout(timeout) : AbortSignal.any([budget, AbortSignal.timeout(timeout)]),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status, `Acceptance ${method} ${url.pathname} returned an unexpected status.`);
  if (failAt === 'enable-response' && fixtureHasConsent && method === 'PUT' && body?.disabled === false) {
    await response.body?.cancel();
    throw new Error('Injected loss of the fixture-enable response after the application handled it.');
  }
  return boundedJson(response);
}
async function sample(options = {}) {
  const result = await api('/api/operations/status', options);
  assert.equal(result.complete, true); assert.equal(result.workspace, workspace);
  assert.equal(result.scope.approvalAndHistory, 'unverified-durable-index');
  for (const secret of [operator.token, password, providerKey, answer]) assert.ok(!JSON.stringify(result).includes(secret));
  return result;
}
async function start() {
  const port = await unusedPort(); base = `http://127.0.0.1:${port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
    cwd: application, execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...environment, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home', 'roaming'),
      LOCALAPPDATA: path.join(root, 'home', 'local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
      FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1',
      FLUJO_MCP_APP_SANDBOX_PORT: String(await unusedPort()) },
  });
  const owned = child;
  closed = new Promise(resolve => owned.once('close', (code, signal) => resolve({ pid: owned.pid, code, signal, at: new Date().toISOString() })));
  owned.once('error', readyReject);
  owned.once('message', message => message?.type === 'journey-server-ready' && message.pid === owned.pid
    ? readyResolve() : readyReject(new Error('Invalid owned server readiness receipt.')));
  owned.once('exit', () => readyReject(new Error('Owned server exited before readiness.')));
  for (const stream of [owned.stdout, owned.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64000); });
  await Promise.race([ready, delay(60000, undefined, { ref: false }).then(() => { throw new Error('Owned server startup deadline exceeded.'); })]);
}
async function stop() {
  if (!child) return;
  if (child.connected && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve()));
  }
  const exit = await Promise.race([closed, delay(15000, undefined, { ref: false }).then(() => { throw new Error('Owned server exit unobserved; private fixture retained.'); })]);
  assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM', 'Owned server shutdown failed.');
  exits.push(exit); child = undefined;
}
async function disableFixture() {
  if (!fixtureActive) return;
  await api(`/api/mcp/servers/${serverName}`, { method: 'PUT', body: { disabled: true }, cleanup: true });
  const status = await api(`/api/mcp/servers/${serverName}/status`, { cleanup: true });
  const receipt = status.shutdownReceipt;
  assert.ok(receipt?.runtimeId && Number.isSafeInteger(receipt.generation) && receipt.generation > 0, 'Fixture generation receipt missing.');
  assert.equal(receipt.workspace, workspace); assert.equal(receipt.serverName, serverName);
  assert.equal(receipt.processOwnership, 'owned'); assert.equal(receipt.exitOutcome, 'observed_exit');
  const diagnostic = await sample({ cleanup: true });
  const record = diagnostic.processes.find(value => value.runtimeId === receipt.runtimeId && value.generation === receipt.generation);
  assert.equal(record?.shutdown.exitOutcome, 'observed_exit');
  assert.equal(record.shutdown.generation, receipt.generation);
  fixtureActive = false;
  observations.push({ check: 'named-fixture-observed-exit-matches-operations-generation',
    runtimeId: receipt.runtimeId, generation: receipt.generation, processOwnership: receipt.processOwnership,
    exitOutcome: receipt.exitOutcome });
}
async function enableFixture() {
  fixtureActive = true; fixtureHasConsent = false;
  const current = await api(`/api/mcp/servers/${serverName}`);
  await api(`/api/mcp/servers/${serverName}`, { method: 'PUT', body: { disabled: false, runtimeHomeMode: 'host',
    roots: [effectDirectory], env: { ...current.env, FLUJO_BASH_ROOTS: effectDirectory } } });
  await approveSmokeServer(base, serverName, operator.token, 20000, workspace);
  fixtureHasConsent = true;
  await api(`/api/mcp/servers/${serverName}`, { method: 'PUT', body: { disabled: false } });
}
async function effectRows() {
  try { return (await fs.readFile(path.join(effectDirectory, 'effects.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function effectArguments(value) {
  const quote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, path.join(effectDirectory, 'effect.mjs'), effectDirectory, value].map(quote).join(' ');
  return { command: process.platform === 'win32' ? `& ${command}` : command,
    cwd: effectDirectory, shell: process.platform === 'win32' ? 'powershell' : 'bash', timeout: 15, maxOutputChars: 1000 };
}
function authoredFlow(id, withTool = false) {
  const node = (key, type, properties = {}) => ({ id: key, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'operations-fixture-model', promptTemplate: 'Reply to the user.', inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edge = (source, target, edgeType = 'standard') => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id,
    sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType } });
  const edges = [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])];
  if (withTool) { nodes.push(node('effect', 'mcp', { boundServer: serverName, enabledTools: ['run'], roots: [effectDirectory] })); edges.push(edge(nodes[1], nodes[3], 'mcp')); }
  return { id, name: id, nodes, edges, updatedAt: Date.now() };
}
async function plan(name, flowId, approvalPolicy = 'auto') {
  const result = await api('/api/planned-executions', { status: 201, body: { name, enabled: false, flowId,
    prompt: 'Synthetic operations acceptance.', saveConversations: true, approvalPolicy, overlapStrategy: 'skip',
    startRestriction: 'singleton', trigger: { type: 'schedule', cron: '0 0 1 1 *', catchUp: false } } });
  assert.ok(result.execution?.id && result.execution?.generationId); return result.execution;
}
const run = async execution => (await api(`/api/planned-executions/${execution.id}/run`, { body: {}, timeout: 120000 })).record;
try {
  for (const directory of ['data', 'home', 'temp', 'home/roaming', 'home/local']) await fs.mkdir(path.join(root, directory), { recursive: true });
  const providerPort = await listen(provider);
  await start();
  await api('/api/operations/status', { token: '', status: 401 });
  await api('/api/operations/status', { status: 423 });
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { body: { action, password } })).success, true);
  assert.equal(await checkHealth({ env: { FLUJO_PORT: new URL(base).port, FLUJO_HEALTHCHECK_TOKEN: operator.token } }), true);
  await api('/api/model', { status: 201, body: { id: 'operations-fixture-model', name: 'operations-fixture-model',
    provider: 'openai', adapter: 'openai', ApiKey: providerKey, baseUrl: `http://127.0.0.1:${providerPort}/v1` } });
  await api('/api/flow', { status: 201, body: authoredFlow('operations-fixture-flow') });
  const initial = await sample();
  observations.push({ check: 'owner-unlock-readiness-and-redacted-operations', observationProcessId: initial.observationProcessId });

  for (const failure of ['timeout', 'rate-limit', 'bad-request']) {
    const execution = await plan(`Fixture ${failure}`, 'operations-fixture-flow');
    mode = failure; const before = requests.length; const failed = await run(execution);
    assert.equal(failed.status, 'error'); assert.ok(requests.length > before);
    const diagnostic = await sample();
    const row = diagnostic.schedules.find(value => value.id === execution.id);
    assert.equal(row.errorHint, failure); assert.equal(row.indexedLastRun.runId, failed.runId);
    assert.ok(diagnostic.alerts.some(alert => alert.code === `run-error-hint:${failure}` && alert.resourceId === execution.id));
    const failureDispatches = requests.length - before;
    mode = 'success'; const retryBefore = requests.length, recovered = await run(execution);
    assert.equal(recovered.status, 'completed'); assert.notEqual(recovered.runId, failed.runId);
    assert.equal(recovered.outputText, answer);
    assert.equal(requests.length - retryBefore, 1);
    const history = (await api(`/api/planned-executions/${execution.id}/runs`)).runs;
    assert.equal(history.find(value => value.runId === failed.runId).status, 'error');
    observations.push({ check: `provider-${failure}-diagnosis-and-explicit-retry`, executionId: execution.id,
      generationId: execution.generationId, failedRunId: failed.runId, recoveredRunId: recovered.runId,
      failureDispatches, successfulRetryDispatches: 1 });
  }

  await fs.mkdir(effectDirectory, { recursive: true });
  await fs.copyFile(path.join(application, 'scripts/operations-acceptance/effect.mjs'), path.join(effectDirectory, 'effect.mjs'));
  assert.equal((await api('/api/init')).success, true);
  const shipped = await api(`/api/mcp/servers/${serverName}`);
  assert.equal(shipped.transport, 'stdio'); assert.ok(shipped.command && Array.isArray(shipped.args));
  await enableFixture();
  await api('/api/flow', { status: 201, body: authoredFlow('operations-fixture-approval-flow', true) });
  mode = 'approval'; marker = 'retained-approval';
  const execution = await plan('Fixture retained approval', 'operations-fixture-approval-flow', 'pause');
  const pending = await run(execution); assert.equal(pending.status, 'needs_approval');
  assert.equal((await effectRows()).length, 0);
  const approval = (await api('/api/approvals')).approvals.find(value => value.runId === pending.runId);
  assert.ok(approval?.approvalId && approval.pendingToolCalls.length === 1);
  const beforeRestart = await sample();
  assert.ok(beforeRestart.indexedApprovals.some(value => value.approvalId === approval.approvalId));

  const policyBytes = await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE, 'utf8');
  const expired = JSON.parse(policyBytes); expired.credentials[0].expiresAt = Date.now() - 1;
  try {
    await fs.writeFile(operator.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify(expired));
    if (failAt === 'expired-owner-deadline') injectedDeadline.abort(new Error('Injected scenario deadline while the temporary owner policy is expired.'));
    await api('/api/operations/status', { status: 401 });
    await api(`/api/approvals/${approval.approvalId}`, { body: { action: 'approve' }, status: 401 });
    assert.equal((await effectRows()).length, 0);
  } finally { await fs.writeFile(operator.env.FLUJO_OWNER_AUTH_FILE, policyBytes); }
  const pendingAgain = (await api('/api/approvals')).approvals.find(value => value.approvalId === approval.approvalId);
  assert.equal(pendingAgain.runId, pending.runId);
  observations.push({ check: 'expired-owner-refusal-retains-unexecuted-approval', runId: pending.runId, effects: 0 });

  const dispatchesBeforeRestart = requests.length;
  await disableFixture();
  await stop(); await start();
  await api('/api/operations/status', { status: 423 });
  assert.equal((await api('/api/encryption/secure', { body: { action: 'authenticate', password } })).success, true);
  const afterRestart = await sample();
  assert.notEqual(afterRestart.observationProcessId, beforeRestart.observationProcessId);
  assert.equal(requests.length, dispatchesBeforeRestart); assert.equal((await effectRows()).length, 0);
  const restored = (await api('/api/approvals')).approvals.find(value => value.approvalId === approval.approvalId);
  assert.equal(restored.runId, pending.runId);
  await enableFixture();
  const oldDecision = await api(`/api/approvals/${approval.approvalId}`, { body: { action: 'approve' }, timeout: 120000 });
  assert.equal(oldDecision.status, 'awaiting_tool_approval'); assert.equal(replans, 1);
  assert.equal((await effectRows()).length, 0);
  const freshApproval = (await api('/api/approvals')).approvals.find(value => value.runId === pending.runId);
  assert.ok(freshApproval?.approvalId && freshApproval.pendingToolCalls.length === 1);
  assert.notEqual(freshApproval.pendingToolCalls[0].id, approval.pendingToolCalls[0].id);
  observations.push({ check: 'stale-pre-restart-tool-refused-and-fresh-proposal-needs-explicit-approval',
    runId: pending.runId, staleEffects: 0, freshToolCalls: 1 });
  const approved = await api(`/api/approvals/${freshApproval.approvalId}`, { body: { action: 'approve' }, timeout: 120000 });
  assert.equal(approved.status, 'completed');
  assert.deepEqual((await effectRows()).map(value => value.marker), ['retained-approval']);
  await api(`/api/approvals/${approval.approvalId}`, { body: { action: 'approve' }, status: 404 });
  assert.deepEqual((await effectRows()).map(value => value.marker), ['retained-approval']);
  const completedApproval = (await api(`/api/planned-executions/${execution.id}/runs`)).runs.find(value => value.runId === pending.runId);
  assert.equal(completedApproval.status, 'completed'); assert.equal(completedApproval.outputText, answer);
  observations.push({ check: 'graceful-restart-retains-approval-without-replay-and-one-actual-effect', runId: pending.runId,
    beforeObservationProcessId: beforeRestart.observationProcessId, afterObservationProcessId: afterRestart.observationProcessId,
    effects: 1, duplicateApprovalHttpStatus: 404 });

  marker = 'declined-approval';
  const declinedPlan = await plan('Fixture declined approval', 'operations-fixture-approval-flow', 'pause');
  const declinedRun = await run(declinedPlan); assert.equal(declinedRun.status, 'needs_approval');
  const declined = (await api('/api/approvals')).approvals.find(value => value.runId === declinedRun.runId);
  assert.ok(declined?.approvalId);
  assert.equal((await api(`/api/approvals/${declined.approvalId}`, { body: { action: 'deny' } })).status, 'completed');
  assert.equal((await api(`/api/planned-executions/${declinedPlan.id}/runs`)).runs.find(value => value.runId === declinedRun.runId).outputText, answer);
  assert.deepEqual((await effectRows()).map(value => value.marker), ['retained-approval']);
  observations.push({ check: 'explicit-denial-does-not-execute-the-fixture-tool', runId: declinedRun.runId, effects: 1 });
  outcome = 'passed';
} catch (error) {
  let diagnostic = `${error?.stack ?? error}\n${serverLog.slice(-12000)}`;
  for (const secret of [operator.token, password, providerKey]) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
  await fs.writeFile(path.join(root, 'server.log'), diagnostic, { mode: 0o600 });
  console.error(diagnostic); process.exitCode = 1;
} finally {
  const errors = [];
  try { await disableFixture(); } catch (error) { errors.push(error); }
  try { await stop(); } catch (error) { errors.push(error); }
  provider.closeAllConnections();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
  if (!child && !fixtureActive) { try { await operator.restore(); } catch (error) { errors.push(error); } }
  let cleanupVerified = false;
  try { await fs.access(root); } catch (error) { if (error.code === 'ENOENT') cleanupVerified = true; else errors.push(error); }
  if (!cleanupVerified) errors.push(new Error('Owned private fixture remains.'));
  const applicationInputs = {};
  for (const filename of ['package.json', 'package-lock.json', 'next.config.mjs']) applicationInputs[filename] = hash(await fs.readFile(path.join(application, filename)));
  const receipt = { schemaVersion: 1, scenario: 'source-built-operations-recovery-570', outcome: errors.length ? 'failed' : outcome,
    ...(failAt ? { faultInjection: failAt } : {}),
    startedAt, completedAt: new Date().toISOString(), checkoutSourceRevision: sourceRevision, applicationSourceRevision: buildEvidence.sourceRevision, buildId,
    buildEvidenceSha256: buildEvidence.evidenceSha256, sourceInputs: buildEvidence.sourceInputs, builtInputs: buildEvidence.builtInputs,
    harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), applicationInputs,
    platform: process.platform, architecture: process.arch, node: process.version,
    qualification: 'disposable-source-built-integration-only', observations, providerRequests: requests, observedOwnedNextExits: exits,
    cleanupVerified, limits };
  receipt.equipmentSha256 = {};
  for (const filename of ['scripts/operations-acceptance/build-evidence.mjs', 'scripts/operations-acceptance/effect.mjs',
    'scripts/smoke-bundled-operator.mjs', 'scripts/persona-browser-acceptance/next-process.cjs', 'scripts/worker-recovery-acceptance.mjs']) {
    receipt.equipmentSha256[filename] = hash(await fs.readFile(path.join(application, filename)));
  }
  await fs.writeFile(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (errors.length) throw new AggregateError(errors, 'Operations acceptance cleanup failed.');
}
if (outcome === 'passed') console.log('PASS: built operations failure diagnosis/retry, expiry, retained approval, restart without replay, one observed tool effect and denial; private cleanup verified.');

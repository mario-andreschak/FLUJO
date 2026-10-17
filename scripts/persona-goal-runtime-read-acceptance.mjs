import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionOwnerBootstrap } from './owner-bootstrap.mjs';
import { fixtureRuntimeEnvironment, inspectCandidateRoot, observeOwnedCandidate, stopOwnedCandidate } from './feature-surface-acceptance/browser-environment.mjs';

// Invoke through flujo-bash. Retain the private profiles for owner cleanup after
// every application epoch has exited and drained its pipes. No model executes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Pass a new absolute report path inside an owned run');
const run = path.dirname(report), stamp = randomUUID();
const port = Number(process.env.GOAL_RUNTIME_ACCEPTANCE_PORT ?? '5615');
assert(Number.isSafeInteger(port) && port > 1024 && port < 65534);
const base = `http://127.0.0.1:${port}`;
const profile = path.join(run, 'goal-runtime-profile-' + stamp);
const authority = path.join(run, 'goal-runtime-authority-' + stamp);
const require = createRequire(path.join(repo, 'package.json'));
const candidate = await inspectCandidateRoot(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true }).toString().trim();
assert.equal(git('diff', '--name-only', '--', 'src'), '', 'Stage the exact application source before acceptance');
const tree = git('write-tree');
const evidence = { pr: 1198, startedUtc: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'), candidateTree: tree, applicationSourceTree: git('rev-parse', tree + ':src'),
  buildId: candidate.buildId, cases: [], epochs: [], providerCalls: 0,
  limits: ['Actual built HTTP with controlled persisted WorkItems; no native round or business outcome is fabricated',
    'No provider, browser/UI, installed, endurance, full CI or release acceptance'] };
const secrets = [], fixtures = new Map();
let owned, ownerToken = '', output = '';
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[private]'), String(value));
const check = (value, label) => { assert(value, label); evidence.cases.push(label); console.log(label); };
const telemetry = createServer((incoming, outgoing) => {
  incoming.resume();
  if (incoming.url !== '/disabled-telemetry') evidence.unexpectedFixtureRequest = incoming.url;
  outgoing.writeHead(204).end();
});

async function request(route, { body, token = ownerToken, expected = 200, workspace = 'default-workspace',
  headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const url = new URL(route, base);
  if (workspace !== null) url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { origin: base, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { unparsed: raw.slice(0, 200) }; }
  assert.equal(response.status, expected, `${route}: ${redact(JSON.stringify(data)).slice(0, 300)}`);
  return { data, headers: response.headers, raw };
}

async function start(config, fixtureUrl, exposure = 'localhost') {
  const env = fixtureRuntimeEnvironment({ dataDir: profile, baseURL: base, fixtureUrl, sandboxPort: port + 1 });
  Object.assign(env, { FLUJO_APP_ROOT: repo, FLUJO_OWNER_AUTH_FILE: config.policyFile,
    FLUJO_OWNER_BOOTSTRAP_FILE: config.bootstrapFile, FLUJO_OWNER_BROWSER_ORIGIN: base,
    FLUJO_EXPOSURE_MODE: exposure });
  const child = fork(path.join(repo, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)],
    { cwd: repo, env, silent: true, windowsHide: true });
  owned = observeOwnedCandidate(child); evidence.epochs.push(owned.epoch);
  child.stdout.on('data', bytes => { output += redact(bytes.toString()); });
  child.stderr.on('data', bytes => { output += redact(bytes.toString()); });
  await new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); child.off('message', ready); child.off('exit', exit); child.off('error', fail); };
    const ready = message => { if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clear(); resolve(); } };
    const exit = code => { clear(); reject(new Error('Owned application exited ' + code)); };
    const fail = error => { clear(); reject(error); };
    const timer = setTimeout(() => { clear(); reject(new Error('Owned application startup timeout')); }, 60000);
    child.on('message', ready); child.once('exit', exit); child.once('error', fail);
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await request(ownerToken ? '/api/workspaces' : '/api/owner/bootstrap'); return; }
    catch (error) {
      if (!error.message.includes('WORKSPACE_LAYOUT_PREPARING') || attempt === 29) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(200 + attempt * 200, 2000)));
    }
  }
}

async function stop() { if (owned) { await stopOwnedCandidate(owned); owned = undefined; } }
const runtime = (id = 'goal_registered', persona = 'persona_owner') => `/v1/personas/${persona}/work-items/${id}/runtime`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function seed(id, patch = {}, { workspace = 'default-workspace', legacy = false, raw } = {}) {
  const now = 1700000000000;
  const item = { schemaVersion: 1, id, personaId: 'persona_owner', title: 'Controlled read fixture',
    description: 'PRIVATE_WORKITEM_CONTEXT', status: 'open', priority: 'normal', dependencyIds: [],
    createdAt: now, updatedAt: now, goal: { successCriteria: 'Controlled read fixture only', state: 'paused',
      continuationIntervalMs: 60000, maxConsecutiveFailures: 3, maxRoundsPerDay: 10,
      rounds: 0, consecutiveFailures: 0, dailyWindowStartedAt: now, roundsInWindow: 0 }, ...patch };
  const filename = path.join(profile, 'workspaces', workspace, 'db', 'persona-work-items',
    ...(legacy ? [] : ['persona_owner']), id + '.json');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const bytes = raw ?? JSON.stringify(item);
  await fs.writeFile(filename, bytes, { flag: 'wx' });
  fixtures.set(filename, hash(bytes));
  return item;
}

async function readOnlyCredential(config) {
  const filename = path.join(repo, 'src/backend/services/security/ownerCredentials.ts');
  const issuer = new Module(filename); issuer.filename = filename; issuer.paths = Module._nodeModulePaths(path.dirname(filename));
  issuer._compile(require('typescript').transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 } }).outputText, filename);
  const issued = issuer.exports.issueOwnerCredential(['openai:read'], Date.now() + 10 * 60000);
  const policy = JSON.parse(await fs.readFile(config.policyFile, 'utf8')); policy.credentials.push(issued.record);
  await fs.writeFile(config.policyFile, JSON.stringify(issuer.exports.ownerPolicySchema.parse(policy)), { mode: 0o600 });
  secrets.push(issued.token);
  return issued.token;
}

try {
  await fs.mkdir(profile, { mode: 0o700 });
  const config = provisionOwnerBootstrap(authority, 'goal-runtime-reader');
  const password = randomBytes(32).toString('base64url'); secrets.push(password);
  await new Promise((resolve, reject) => { telemetry.once('error', reject); telemetry.listen(0, '127.0.0.1', resolve); });
  const fixtureUrl = `http://127.0.0.1:${telemetry.address().port}`;
  await start(config, fixtureUrl);
  const pairing = (await fs.readFile(config.pairingTokenFile, 'utf8')).trim(); secrets.push(pairing);
  ownerToken = (await request('/api/owner/bootstrap', { token: pairing, body: { confirmOwnerEnrollment: true }, expected: 201 })).data.ownerToken;
  assert(ownerToken); secrets.push(ownerToken);
  await request('/api/encryption/secure', { body: { action: 'initialize', password } });
  const unlock = async () => {
    const unlocked = await request('/api/encryption/secure', { body: { action: 'authenticate', password } });
    assert(unlocked.data.success && unlocked.data.token); secrets.push(unlocked.data.token);
  };
  await unlock();
  const registeredFixture = await seed('goal_registered');
  await seed('goal_legacy', {}, { legacy: true });
  await seed('goal_unverified', { goal: { ...registeredFixture.goal, rounds: 1, pendingTaskId: 'goal_unverified' } });
  await seed('task_local', { goal: undefined });
  await seed('child_local', { goal: undefined, parentGoalId: 'goal_registered' });
  await seed('foreign_legacy', { personaId: 'persona_other' }, { legacy: true });
  await seed('foreign_shard', { personaId: 'persona_other' });
  await seed('broken_local', {}, { raw: '{"PRIVATE_BROKEN_CONTEXT":' });
  await request(runtime(), { token: '', expected: 401 });
  check(true, 'Missing owner authorization is refused before reading runtime');
  await request(runtime(), { token: await readOnlyCredential(config), expected: 403 });
  check(true, 'OpenAI read scope does not grant local control-plane access');
  await request(runtime(), { headers: { origin: 'https://outside.invalid' }, expected: 403 });
  await request(runtime(), { headers: { 'x-forwarded-for': '203.0.113.9' }, expected: 403 });
  check(true, 'Foreign origins and forwarded non-loopback peers are refused');
  const registered = await request(runtime());
  assert.deepEqual(Object.keys(registered.data).sort(), ['personaId', 'runtime', 'schema', 'workspaceId']);
  assert.equal(registered.data.schema, 'flujo-goal-runtime/v1');
  assert.equal(registered.data.workspaceId, 'default-workspace');
  assert.equal(registered.data.personaId, 'persona_owner');
  assert.equal(registered.data.runtime.goal.id, 'goal_registered');
  assert.equal(registered.data.runtime.state, 'registered');
  assert.equal(registered.data.runtime.verified, false);
  check(!registered.raw.includes('PRIVATE_WORKITEM_CONTEXT') && registered.headers.get('cache-control') === 'private, no-store',
    'Actual engine projection preserves identity, registration semantics, privacy and no-store caching');
  const legacy = await request(runtime('goal_legacy'));
  check(legacy.data.runtime.state === 'registered', 'Matching legacy root Goals remain readable');
  const unverified = await request(runtime('goal_unverified'));
  check(unverified.data.runtime.state === 'unverified' && unverified.data.runtime.reason === 'incomplete_pending_round',
    'Incomplete native lineage remains explicitly unverified');
  for (const [id, persona] of [['missing_goal'], ['bad.id'], ['task_local'], ['child_local'], ['foreign_legacy'],
    ['foreign_shard'], ['goal_registered', 'persona_other']]) {
    const missing = await request(runtime(id, persona), { expected: 404 });
    assert.deepEqual(missing.data, { error: 'Goal not found.' });
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  }
  check(true, 'Missing, invalid, child, task and foreign flat/sharded Goals share the same private 404');
  const broken = await request(runtime('broken_local'), { expected: 503 });
  check(JSON.stringify(broken.data) === JSON.stringify({ error: 'Goal runtime is unavailable.' })
    && broken.headers.get('cache-control') === 'private, no-store', 'Malformed storage returns a generic uncached 503');
  await request(runtime(), { workspace: 'unknown-workspace', expected: 404 });
  await request(runtime(), { workspace: '../invalid', expected: 400 });
  check(true, 'Unknown and invalid workspaces remain behind ordinary workspace admission');
  await request('/api/workspaces', { workspace: null, body: { name: 'runtime-second' }, expected: 201 });
  await request('/api/encryption/secure', { workspace: 'runtime-second', body: { action: 'initialize', password } });
  await request('/api/encryption/secure', { workspace: 'runtime-second', body: { action: 'authenticate', password } });
  await seed('goal_registered', { nextAction: 'SECOND_WORKSPACE_ONLY' }, { workspace: 'runtime-second' });
  const second = await request(runtime(), { workspace: 'runtime-second' });
  check(second.data.workspaceId === 'runtime-second' && second.data.runtime.goal.nextAction === 'SECOND_WORKSPACE_ONLY'
    && !registered.raw.includes('SECOND_WORKSPACE_ONLY'), 'The same Persona/Goal IDs resolve only inside the selected workspace');
  const head = await request(runtime(), { method: 'HEAD' });
  check(head.raw === '', 'HEAD returns no runtime body');
  await request(runtime(), { method: 'POST', expected: 405 });
  check(true, 'The read endpoint admits no POST control operation');
  await stop();
  await start(config, fixtureUrl);
  const locked = await request(runtime(), { expected: 423 });
  check(locked.data.error?.code === 'encryption_locked', 'A real process restart retains the USER encryption lock');
  await unlock();
  const restarted = await request(runtime());
  check(JSON.stringify(restarted.data) === JSON.stringify(registered.data), 'Owner unlock recovers the identical native read after restart');
  await stop();
  await start(config, fixtureUrl, 'network');
  await request(runtime(), { expected: 403 });
  check(true, 'Network exposure cannot turn a spoofed localhost Host into local reader authority');
  await stop();
  for (const [filename, expected] of fixtures) assert.equal(hash(await fs.readFile(filename)), expected);
  check(true, 'Every controlled WorkItem byte remains unchanged after all reads and restarts');
  assert(!evidence.unexpectedFixtureRequest);
  evidence.success = true;
} catch (error) { evidence.success = false; evidence.error = redact(error.stack); process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { evidence.success = false; evidence.stopError = redact(error.message); process.exitCode = 1; }
  if (telemetry.listening) await new Promise(resolve => telemetry.close(resolve));
  evidence.finishedUtc = new Date().toISOString();
  await fs.writeFile(report, JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(run, 'goal-runtime-application.log'), redact(output));
  if (!evidence.success) console.error('Goal runtime HTTP acceptance failed; inspect the private report.');
}

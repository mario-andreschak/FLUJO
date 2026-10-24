import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { modelGrantSchema, admittedModelBody, MODEL_BODY_BYTES } from '../dist/model-grant.js';
import { ModelChannel } from '../dist/model-channel.js';
import { ModelBrokers } from '../dist/model-brokers.js';
import { createRuntimeModelServer } from '../dist/runtime-model-server.js';
import { Ledger } from '../dist/ledger.js';
import { Teams } from '../dist/teams.js';
import { TeamResources } from '../dist/team-resources.js';
import { TeamModelAccess } from '../dist/team-model-access.js';
import { publishableModel } from '../dist/shared-model.js';
import { privateFixture } from './private-fixture.mjs';

async function bounded(promise, ms = 10_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

function owner(actor, letter, endpoint, bearerFile) {
  const generation = letter.repeat(32);
  return { id: `${actor}-runtime`, actorId: actor, origin: `https://${actor}.localhost`, upstream: 'http://127.0.0.1:4200',
    credential: `flo_v1_${letter.repeat(43)}`, isolationId: `local-docker:${letter.repeat(64)}`,
    localRuntime: { kind: 'local-docker', executable: process.execPath, daemon: 'unix:///var/run/docker.sock',
      containerId: letter.repeat(64), imageId: `sha256:${'f'.repeat(64)}`, generation,
      dataVolume: `flujo-owner-${generation}-data`, homeVolume: `flujo-owner-${generation}-home`,
      authorityVolume: `flujo-owner-${generation}-authority`, memoryMiB: 1024, cpus: 1, pidsLimit: 256,
      credentialExpiresAt: Date.now() + 3600_000 },
    modelGrants: [{ id: 'host', endpoint, models: [`fixture-${actor}`], bearerFile }] };
}

async function fixture(t, handler, recipientWithoutGrants = false) {
  const { directory, close } = privateFixture(t, { preserveOnCloseFailure: true });
  const calls = []; let ledger; let brokers; let refresh;
  const service = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ url: request.url, headers: request.headers, body });
    if (handler) { handler(request, response, body); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'host-secret=not-forwarded' });
    response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `reply for ${body.model}` }, finish_reason: 'stop' }] }));
  });
  close.push(async () => {
    clearInterval(refresh);
    try { await brokers?.close(); }
    finally {
      ledger?.close();
      await new Promise(resolve => { service.close(resolve); service.closeAllConnections(); });
    }
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${service.address().port}/v1`;
  const bearerFile = join(directory, 'model-token'); writeFileSync(bearerFile, 'fixture-host-key\n', { mode: 0o600 });
  const runtimeInputs = [owner('alice', 'a', endpoint, bearerFile), owner('bob', 'b', endpoint, bearerFile)];
  if (recipientWithoutGrants) delete runtimeInputs[1].modelGrants;
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory, runtimes: runtimeInputs });
  ledger = new Ledger(directory); ledger.reconcile(config);
  for (const intent of ledger.intents()) ledger.observeRuntime(intent);
  // This is a transport fixture, not evidence of an installed runtime. Keep its
  // explicitly simulated running observations fresh during slow native ACL checks.
  refresh = setInterval(() => { for (const intent of ledger.intents()) if (intent.phase === 'confirmed') ledger.observeRuntime(intent); }, 5000);
  const children = []; const ports = [];
  const portSignals = new Map(config.runtimes.map(runtime => {
    let resolve; const promise = new Promise(done => { resolve = done; });
    return [runtime.localRuntime.containerId, { promise, resolve }];
  }));
  const engine = { spawn(policy, args) {
    assert.deepEqual(args, ['container', 'exec', '--interactive', '--user', '1000:1000', '--workdir', '/app', policy.containerId,
      '/usr/local/bin/node', '/app/packages/shared-controller/dist/runtime-model-broker.js']);
    const moduleUrl = new URL('../dist/runtime-model-server.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createRuntimeModelServer } from ${JSON.stringify(moduleUrl)};
      const broker = createRuntimeModelServer(process.stdin, process.stdout);
      broker.server.once('close', () => process.disconnect?.());
      broker.server.listen(0, '127.0.0.1', () => process.send({ port: broker.server.address().port }));
      process.once('SIGTERM', broker.close); process.once('SIGINT', broker.close);
    `], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    children.push(child);
    const port = bounded(new Promise((resolve, reject) => { child.once('message', value => resolve(value.port)); child.once('error', reject); }));
    ports.push(port); void port.then(value => portSignals.get(policy.containerId).resolve(value)).catch(() => {});
    return child;
  } };
  brokers = new ModelBrokers(config, ledger, engine); brokers.start();
  const [alice, bob] = await Promise.all(ports);
  return { config, ledger, calls, brokers, children, alice, bob, endpoint,
    portFor: actor => bounded(portSignals.get(config.runtimes.find(runtime => runtime.actorId === actor).localRuntime.containerId).promise),
    url: (port, path = 'models', grant = 'host') => `http://127.0.0.1:${port}/grants/${grant}/v1/${path}`,
    post: (port, body, path = 'chat/completions') => fetch(`http://127.0.0.1:${port}/grants/host/v1/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller-must-not-choose-host-key' }, body: JSON.stringify(body),
    }) };
}

async function sharedFixture(f) {
  const sessions = {}; const password = 'offline team model fixture password';
  for (const runtime of f.config.runtimes) {
    const revision = runtimeRevision(f.config, runtime);
    await f.ledger.setPassword(runtime, revision, password);
    const token = await f.ledger.authenticate(runtime, revision, password, 3600);
    sessions[runtime.actorId] = f.ledger.session(token, runtime, revision);
  }
  const teams = new Teams(f.ledger); const resources = new TeamResources(f.ledger);
  const access = new TeamModelAccess(f.config, f.ledger);
  const teamId = teams.create(sessions.alice, 'Offline model team');
  const join = () => {
    teams.invite(sessions.alice, teamId, teams.detail(sessions.alice, teamId).team.generation, 'bob');
    teams.respond(sessions.bob, teamId, teams.list(sessions.bob).invitations[0].invitation, true);
  };
  join();
  const document = publishableModel({ name: 'fixture-alice', displayName: 'Shared fixture', provider: 'ollama', adapter: 'openai',
    baseUrl: 'http://127.0.0.1:1/never-used', ApiKey: 'never-publish', promptTemplate: 'Shared prompt' });
  const id = resources.create(sessions.alice, teamId, 'model', 'Shared fixture', JSON.stringify(document));
  const url = (operation, version = 1) => `http://127.0.0.1:${f.bob}/teams/${teamId}/${id}/revisions/${version}/v1/${operation}`;
  const post = (body, version = 1) => fetch(url('chat/completions', version), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ignored-runtime-value' }, body: JSON.stringify(body) });
  const body = { model: 'fixture-alice', messages: [{ role: 'user', content: 'Shared fixture request' }] };
  return { access, teams, resources, sessions, teamId, id, document, url, post, body, join };
}

test('team model execution requires explicit current-revision permission and never publishes host credentials', async t => {
  const f = await fixture(t); const s = await sharedFixture(f);
  assert.equal((await s.post(s.body)).status, 403);
  assert.throws(() => s.access.authorize(s.sessions.bob, s.teamId, s.id, 1, 0, 'host'), /current local model grants/);
  assert.equal(f.calls.length, 0);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host');
  assert.throws(() => s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host'), /permission changed/);
  const state = s.access.describe(s.sessions.bob, s.teamId, s.id);
  assert.equal(state.enabled, true); assert.deepEqual(state.options, []); assert.equal(state.history[0].action, 'enabled');
  assert.ok(!JSON.stringify(state).includes(f.endpoint)); assert.ok(!JSON.stringify(state).includes('bearerFile'));
  const config = await fetch(s.url('configuration')); assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), s.document);
  assert.deepEqual((await (await fetch(s.url('models'))).json()).data.map(model => model.id), ['fixture-alice']);
  assert.equal((await s.post({ ...s.body, model: 'fixture-bob' })).status, 400);
  const result = await s.post(s.body); assert.equal(result.status, 200);
  assert.equal((await result.json()).choices[0].message.content, 'reply for fixture-alice');
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-host-key');
  assert.equal(f.calls[0].url, '/v1/chat/completions');
  s.access.revoke(s.sessions.bob, s.teamId, s.id, 1);
  assert.equal((await s.post(s.body)).status, 403); assert.equal(f.calls.length, 1);
  assert.equal(s.access.describe(s.sessions.alice, s.teamId, s.id).history[0].action, 'disabled');
});

test('model edits, restore, source-grant generation and recovery invalidate delegated execution', async t => {
  const f = await fixture(t); const s = await sharedFixture(f);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host');
  const lease = s.resources.acquire(s.sessions.bob, s.teamId, s.id, 1);
  s.resources.save(s.sessions.bob, s.teamId, s.id, lease.token, lease.fence, 1, 'Revised', JSON.stringify(s.document));
  assert.equal((await s.post(s.body)).status, 403); assert.equal((await s.post(s.body, 2)).status, 403);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 2, 1, 'host');
  assert.equal((await s.post(s.body, 2)).status, 200);
  s.resources.restore(s.sessions.alice, s.teamId, s.id, 2, 1);
  assert.equal((await s.post(s.body, 3)).status, 403);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 3, 2, 'host');
  f.ledger.setModelEnabled('alice', 'host', false); f.ledger.setModelEnabled('alice', 'host', true);
  assert.equal((await s.post(s.body, 3)).status, 403);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 3, 3, 'host');
  const alice = f.config.runtimes[0];
  await f.ledger.setPassword(alice, runtimeRevision(f.config, alice), 'replacement local fixture password');
  assert.equal((await s.post(s.body, 3)).status, 403);
  assert.equal(f.calls.length, 1);
});

test('member removal cancels a running shared stream and a later rejoin cannot revive its admission', async t => {
  let closeUpstream; const upstreamClosed = new Promise(resolve => { closeUpstream = resolve; });
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"shared":true}\n\n');
    response.once('close', closeUpstream);
  });
  const s = await sharedFixture(f); s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host');
  const bob = f.config.runtimes[1]; const admission = s.access.admit(bob, s.teamId, s.id, 1);
  const response = await s.post({ ...s.body, stream: true }); const reader = response.body.getReader(); await reader.read();
  s.teams.remove(s.sessions.alice, s.teamId, s.teams.detail(s.sessions.alice, s.teamId).team.generation, 'bob');
  await bounded(assert.rejects(reader.read())); await bounded(upstreamClosed);
  assert.equal((await s.post(s.body)).status, 403); s.join();
  assert.equal(s.access.current(bob, admission), false);
  assert.notEqual(s.access.admit(bob, s.teamId, s.id, 1).generation, admission.generation);
});

test('an owner without personal model grants gets an empty catalogue and cannot execute until explicit delegation', async t => {
  const f = await fixture(t, undefined, true);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${f.bob}/teams/models`)).json(), { entries: [], next: null });
  const s = await sharedFixture(f);
  assert.deepEqual(s.access.describe(s.sessions.bob, s.teamId, s.id).options, []);
  assert.equal((await s.post(s.body)).status, 403);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host');
  f.bob = await f.portFor('bob');
  const response = await s.post(s.body); assert.equal(response.status, 200);
  assert.equal((await response.json()).model, 'fixture-alice');
  assert.equal((await fetch(f.url(f.bob))).status, 403, 'Team membership does not grant the source owner private grant route');
});

test('grantor removal and rejoin cannot silently revive the delegated service', async t => {
  const f = await fixture(t); const s = await sharedFixture(f);
  const teamId = s.teams.create(s.sessions.bob, 'Bob manages membership');
  const joinAlice = () => {
    s.teams.invite(s.sessions.bob, teamId, s.teams.detail(s.sessions.bob, teamId).team.generation, 'alice');
    s.teams.respond(s.sessions.alice, teamId, s.teams.list(s.sessions.alice).invitations.find(item => item.id === teamId).invitation, true);
  };
  joinAlice();
  const id = s.resources.create(s.sessions.alice, teamId, 'model', 'Delegated fixture', JSON.stringify(s.document));
  s.access.authorize(s.sessions.alice, teamId, id, 1, 0, 'host');
  const bob = f.config.runtimes[1]; const original = s.access.admit(bob, teamId, id, 1);
  s.teams.remove(s.sessions.bob, teamId, s.teams.detail(s.sessions.bob, teamId).team.generation, 'alice');
  joinAlice(); assert.equal(s.access.current(bob, original), false);
  assert.throws(() => s.access.admit(bob, teamId, id, 1), /grant ended/);
  s.access.authorize(s.sessions.alice, teamId, id, 1, 1, 'host');
  assert.notEqual(s.access.admit(bob, teamId, id, 1).generation, original.generation);
});

test('native catalogue pages disclose only admitted selector metadata and resolve the current revision', async t => {
  const f = await fixture(t); const s = await sharedFixture(f);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 0, 'host');
  for (let index = 0; index < 9; index++) {
    const id = s.resources.create(s.sessions.alice, s.teamId, 'model', `Model ${index}`, JSON.stringify(s.document));
    s.access.authorize(s.sessions.alice, s.teamId, id, 1, 0, 'host');
  }
  const root = `http://127.0.0.1:${f.bob}`; const entries = []; let after;
  do {
    const response = await fetch(`${root}/teams/models${after ? `/after/${after}` : ''}`);
    assert.equal(response.status, 200); const page = await response.json();
    assert.ok(page.entries.length <= 8); entries.push(...page.entries); after = page.next;
  } while (after);
  assert.equal(entries.length, 10); assert.equal(new Set(entries.map(item => item.reference.resourceId)).size, 10);
  for (const entry of entries) {
    assert.equal(entry.reference.teamName, 'Offline model team');
    for (const key of ['ApiKey', 'baseUrl', 'promptTemplate', 'ownerCredentialBinding']) assert.equal(entry.model[key], undefined);
  }
  const response = await fetch(`${root}/teams/${s.teamId}/${s.id}/current`); const resolved = await response.json();
  assert.deepEqual(resolved.document, s.document); assert.equal(resolved.reference.version, 1);
  const url = `${root}/teams/${s.teamId}/${s.id}/revisions/1/grants/${resolved.reference.generation}/v1/chat/completions`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.body) };
  assert.equal((await fetch(url, options)).status, 200);
  s.access.revoke(s.sessions.alice, s.teamId, s.id, 1);
  s.access.authorize(s.sessions.alice, s.teamId, s.id, 1, 2, 'host');
  assert.equal((await fetch(url, options)).status, 403, 'Prepared requests cannot revive after a permission changes');
  const fresh = await (await fetch(`${root}/teams/${s.teamId}/${s.id}/current`)).json();
  assert.notEqual(fresh.reference.generation, resolved.reference.generation);
  s.teams.remove(s.sessions.alice, s.teamId, s.teams.detail(s.sessions.alice, s.teamId).team.generation, 'bob');
  assert.deepEqual(await (await fetch(`${root}/teams/models`)).json(), { entries: [], next: null });
  assert.equal((await fetch(`${root}/teams/${s.teamId}/${s.id}/current`)).status, 403);
  assert.equal(f.calls.length, 1);
});

test('owner pipes expose only granted catalogues and ignore caller credentials and host response cookies', async t => {
  const f = await fixture(t);
  assert.deepEqual((await (await fetch(f.url(f.alice))).json()).data.map(item => item.id), ['fixture-alice']);
  assert.deepEqual((await (await fetch(f.url(f.bob))).json()).data.map(item => item.id), ['fixture-bob']);
  assert.equal(f.calls.length, 0, 'Catalogue is the explicit local grant, not a host-wide list');
  const response = await f.post(f.alice, { model: 'fixture-alice', messages: [{ role: 'user', content: 'fixture only' }] });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).choices[0].message.content, 'reply for fixture-alice');
  assert.equal(f.calls[0].url, '/v1/chat/completions'); assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-host-key');
  assert.equal(f.calls[0].headers['x-owner'], undefined);
  for (const body of [
    { model: 'fixture-bob', messages: [{ role: 'user', content: 'wrong owner' }] },
    { model: 'fixture-alice', baseUrl: 'http://127.0.0.1:1/v1', messages: [{ role: 'user', content: 'wrong destination' }] },
    { model: 'fixture-alice', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] },
  ]) assert.equal((await f.post(f.alice, body)).status, 400);
  assert.equal((await fetch(f.url(f.alice, 'models', 'unknown'))).status, 403);
  assert.equal((await f.post(f.alice, {}, 'pull')).status, 400);
  assert.equal(f.calls.length, 1);
});

test('chat event streams and embeddings traverse actual process stdio with no direct host fallback', async t => {
  const f = await fixture(t, (request, response, body) => {
    if (request.url.endsWith('/embeddings')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [{ embedding: [0.1, 0.2] }] }));
    } else {
      assert.equal(body.stream, true);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.write('data: {"choices":[{"delta":{"content":"fixture stream"}}]}\n\n'); response.end('data: [DONE]\n\n');
    }
  });
  const chat = await f.post(f.alice, { model: 'fixture-alice', stream: true, messages: [{ role: 'user', content: 'fixture' }] });
  assert.equal(chat.status, 200); assert.match(await chat.text(), /fixture stream[\s\S]*\[DONE\]/);
  const embedding = await f.post(f.bob, { model: 'fixture-bob', input: ['fixture'] }, 'embeddings');
  assert.equal(embedding.status, 200); assert.deepEqual((await embedding.json()).data[0].embedding, [0.1, 0.2]);
  await f.brokers.close();
  await assert.rejects(fetch(f.url(f.alice)));
  assert.equal(f.calls.length, 2);
});

test('grant disable followed immediately by enable cancels old streams without affecting another owner', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, (_request, response, body) => {
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"fixture":true}\n\n');
      response.once('close', upstreamClosed);
    } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"fixture":true}'); }
  });
  const stream = await f.post(f.alice, { model: 'fixture-alice', stream: true, messages: [{ role: 'user', content: 'fixture' }] });
  const reader = stream.body.getReader(); await reader.read();
  f.ledger.setModelEnabled('alice', 'host', false); f.ledger.setModelEnabled('alice', 'host', true);
  await bounded(assert.rejects(reader.read())); await bounded(closed);
  assert.equal((await f.post(f.bob, { model: 'fixture-bob', messages: [{ role: 'user', content: 'fixture' }] })).status, 200);
  f.ledger.setModelEnabled('alice', 'host', false);
  assert.equal((await fetch(f.url(f.alice))).status, 403);
});

test('local redirects and upstream diagnostics never cross the grant boundary', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(302, { Location: 'http://127.0.0.1:1/private', 'Set-Cookie': 'host-private' });
    response.end('fixture-host-key and private diagnostic');
  });
  const result = await f.post(f.alice, { model: 'fixture-alice', messages: [{ role: 'user', content: 'fixture' }] });
  assert.equal(result.status, 503); assert.equal(result.headers.get('location'), null);
  const body = await result.text(); assert.equal(body.includes('fixture-host-key'), false); assert.equal(body.includes('diagnostic'), false);
  assert.equal(f.calls.length, 1, 'No redirect or automatic relay retry');
});

test('grant revocation persists across ledger reopening and reconfiguration; another runtime cannot borrow it', t => {
  const { directory, close } = privateFixture(t); let ledger = new Ledger(directory); close.push(() => ledger.close());
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    runtimes: [owner('alice', 'a', 'http://127.0.0.1:11434/v1'), owner('bob', 'b', 'http://127.0.0.1:11434/v1')] });
  const [alice, bob] = config.runtimes; ledger.reconcile(config);
  for (const intent of ledger.intents()) ledger.observeRuntime(intent);
  const first = ledger.modelGeneration(alice, runtimeRevision(config, alice), alice.modelGrants[0]); assert.equal(first, 1);
  assert.equal(ledger.modelGeneration(bob, runtimeRevision(config, bob), alice.modelGrants[0]), null);
  ledger.setModelEnabled('alice', 'host', false); ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config);
  for (const intent of ledger.intents()) ledger.observeRuntime(intent);
  assert.equal(ledger.modelGeneration(alice, runtimeRevision(config, alice), alice.modelGrants[0]), null);
  ledger.setModelEnabled('alice', 'host', true);
  assert.ok(ledger.modelGeneration(alice, runtimeRevision(config, alice), alice.modelGrants[0]) > first);
  ledger.setActorEnabled('alice', false);
  assert.equal(ledger.modelGeneration(alice, runtimeRevision(config, alice), alice.modelGrants[0]), null);
});

test('model grants exclude remote/network hostnames and request schemas exclude host operations', () => {
  const grant = { id: 'host', endpoint: 'http://127.0.0.1:11434/v1', models: ['fixture'] };
  assert.equal(modelGrantSchema.safeParse(grant).success, true);
  for (const endpoint of ['http://localhost:11434/v1', 'http://192.168.1.2:11434/v1', 'https://remote.example/v1',
    'http://user:password@127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1?target=other', 'http://127.0.0.1:11434/api']) {
    assert.equal(modelGrantSchema.safeParse({ ...grant, endpoint }).success, false, endpoint);
  }
  assert.throws(() => admittedModelBody(grant, 'chat', { model: 'ungranted', messages: [{ role: 'user', content: 'x' }] }));
  assert.throws(() => admittedModelBody(grant, 'chat', { model: 'fixture', messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'tool', parameters: { $ref: 'file:///private' } } }] }));
  assert.throws(() => admittedModelBody(grant, 'chat', { model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(MODEL_BODY_BYTES) }] }));
  assert.match(admittedModelBody(grant, 'chat', { model: 'fixture', messages: [{ role: 'assistant', content: null,
    tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'local_tool', arguments: '{"fixture":true}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'fixture result' }] }), /fixture result/);
});

test('framing accepts split headers and bounds oversized frames and a peer refusing writes', async t => {
  const input = new PassThrough(); const output = new PassThrough(); let failures = 0; const frames = [];
  const channel = new ModelChannel(input, output, value => frames.push(value), () => { failures++; });
  t.after(channel.close);
  const payload = Buffer.from('{"type":"ready"}'); const wire = Buffer.alloc(payload.length + 4);
  wire.writeUInt32BE(payload.length); payload.copy(wire, 4);
  for (const byte of wire) input.write(Buffer.from([byte]));
  assert.deepEqual(frames, [{ type: 'ready' }]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MODEL_BODY_BYTES + 8192); input.write(oversized);
  assert.equal(failures, 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blockedInput = new PassThrough(); const blockedOutput = new Writable({ write() {} });
  const blocked = new ModelChannel(blockedInput, blockedOutput, () => {}, () => {}); t.after(blocked.close);
  const result = assert.rejects(blocked.send({ type: 'ping' }));
  t.mock.timers.tick(10_000); await result; await nextTurn();
  assert.equal(blockedInput.destroyed, true); assert.equal(blockedOutput.destroyed, true);
});

test('cancelled helper retains its slot until child exit is observed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const runtime = owner('alice', 'a', 'http://127.0.0.1:11434/v1');
  const config = { sessionSeconds: 3600, runtimes: [runtime] }; let available = true;
  const intent = { runtimeId: runtime.id, policy: runtime.localRuntime };
  const ledger = { intents: () => [intent], available: () => available, intentCurrent: () => true };
  const children = [];
  const engine = { spawn() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return false; }, unref() {} });
    children.push(child); return child;
  } };
  const brokers = new ModelBrokers(config, ledger, engine); brokers.start();
  assert.equal(children.length, 1); available = false;
  t.mock.timers.tick(1001); assert.ok(children[0].kills > 0);
  available = true; t.mock.timers.tick(60_000);
  assert.equal(children.length, 1, 'A kill request is not evidence of exit');
  children[0].exitCode = 0; children[0].emit('close', 0);
  await brokers.close();
});

test('runtime model listener closes when controller heartbeats disappear', async t => {
  let now = performance.now(); t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const broker = createRuntimeModelServer(input, output); t.after(broker.close);
  await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
  const port = broker.server.address().port;
  const closed = new Promise(resolve => broker.server.once('close', resolve));
  now += 10_001; t.mock.timers.tick(1001); await bounded(closed);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/grants/local/v1/models`));
  assert.equal(input.destroyed, true);
});

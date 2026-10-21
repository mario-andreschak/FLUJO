import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { Ledger } from '../dist/ledger.js';
import { createController } from '../dist/server.js';
import { Teams } from '../dist/teams.js';
import { privateFixture } from './private-fixture.mjs';

// Real HTTP/SQLite fixture using the explicit development transport. This does
// not claim installed HTTPS/browser, container or network-disabled acceptance.
test('two local browsers create, accept and leave teams without forwarding account data to a runtime', async t => {
  const { directory, close } = privateFixture(t); const ledger = new Ledger(directory);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    runtimes: ['alice', 'bob'].map((id, index) => ({ id, actorId: id,
      origin: `https://${id}.localhost:4280`, upstream: `http://127.0.0.1:${4400 + index}`,
      credential: `flo_v1_${String(index).repeat(43)}`, isolationId: `fixture:${id}` })) });
  let forwarded = 0;
  const server = await createController(config, ledger, () => { forwarded++; throw new Error('Team data reached a runtime'); });
  close.push(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); ledger.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tokens = {}; const sessions = {};
  for (const runtime of config.runtimes) {
    const revision = runtimeRevision(config, runtime);
    await ledger.setPassword(runtime, revision, 'local team page test password');
    tokens[runtime.id] = await ledger.authenticate(runtime, revision, 'local team page test password', 3600);
    sessions[runtime.id] = ledger.session(tokens[runtime.id], runtime, revision);
  }
  const send = (actor, { path = '/_account/teams', method = 'GET', data, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
      host: `${actor}.localhost:4280`, origin: `https://${actor}.localhost:4280`,
      cookie: `__Host-flujo-controller=${tokens[actor]}`, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded', ...headers,
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject); request.end(body ?? (data ? new URLSearchParams(data).toString() : undefined));
  });
  const denied = await send('alice', { method: 'POST', data: { action: 'create', name: 'Cross origin' }, headers: { origin: 'https://bob.localhost:4280' } });
  assert.equal(denied.status, 403);
  assert.equal((await send('alice', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await send('bob', { headers: { cookie: `__Host-flujo-controller=${tokens.alice}` } })).status, 303);
  const account = await send('alice', { path: '/_account' });
  assert.match(account.body, /Your local account ID: <strong>alice<\/strong>/);
  assert.match(account.body, /href="\/_account\/teams"/);
  for (const body of ['action=create&action=archive&name=bad', 'action=create&name=%FF', 'action=create&name=ok&actorId=bob',
    'action=constructor', 'action=create&name=' + 'x'.repeat(8192)]) {
    assert.equal((await send('alice', { method: 'POST', body })).status, 400);
  }
  const created = await send('alice', { method: 'POST', data: { action: 'create', name: '<script>Team</script>' } });
  assert.equal(created.status, 303);
  const teamId = new URL(created.headers.location, config.runtimes[0].origin).searchParams.get('team');
  const teams = new Teams(ledger);
  const version = () => teams.detail(sessions.alice, teamId).team.generation;
  const detail = await send('alice', { path: created.headers.location });
  assert.match(detail.body, /&lt;script&gt;Team&lt;\/script&gt;/);
  assert.doesNotMatch(detail.body, /<script>/);
  assert.match(detail.headers['content-security-policy'], /form-action 'self'/);
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.equal(detail.headers['x-frame-options'], 'DENY');
  assert.equal((await send('bob', { path: created.headers.location })).status, 404);
  const beforeInvite = version();
  assert.equal((await send('alice', { method: 'POST', data: { action: 'invite', teamId, generation: String(beforeInvite), actorId: 'bob' } })).status, 303);
  assert.equal((await send('alice', { method: 'POST', data: { action: 'rename', teamId, generation: String(beforeInvite), name: 'Stale page' } })).status, 409);
  const invitationPage = await send('bob');
  assert.match(invitationPage.body, /Accept invitation/);
  const invitation = teams.list(sessions.bob).invitations[0].invitation;
  assert.equal((await send('alice', { method: 'POST', data: { action: 'accept', teamId, invitation } })).status, 404);
  assert.equal((await send('bob', { method: 'POST', data: { action: 'accept', teamId, invitation } })).status, 303);
  assert.equal((await send('bob', { path: created.headers.location })).status, 200);
  const witness = teams.authority(sessions.bob, teamId);
  assert.equal((await send('bob', { method: 'POST', data: { action: 'remove', teamId, generation: String(version()), actorId: 'bob' } })).status, 303);
  assert.equal(teams.current(witness), false);
  assert.equal((await send('bob', { path: created.headers.location })).status, 404);
  assert.equal((await send('alice', { method: 'POST', data: { action: 'archive', teamId, generation: String(version()), confirm: 'no' } })).status, 400);
  assert.equal((await send('alice', { method: 'POST', data: { action: 'archive', teamId, generation: String(version()), confirm: 'archive' } })).status, 303);
  assert.equal(teams.list(sessions.alice).teams.length, 0);
  assert.equal(forwarded, 0);
  ledger.revokeSession(tokens.alice);
  assert.equal((await send('alice', { method: 'POST', data: { action: 'create', name: 'Logged out' } })).status, 303);
  assert.equal(ledger.db.prepare('SELECT count(*) AS n FROM teams').get().n, 1);
});

test('logout while a team form is uploading prevents its mutation', async t => {
  const { directory, close } = privateFixture(t); const ledger = new Ledger(directory);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory, runtimes: [{
    id: 'alice', actorId: 'alice', origin: 'https://alice.localhost:4280', upstream: 'http://127.0.0.1:4400',
    credential: `flo_v1_${'a'.repeat(43)}`, isolationId: 'fixture:alice' }] });
  const server = await createController(config, ledger);
  close.push(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); ledger.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = config.runtimes[0]; const revision = runtimeRevision(config, runtime);
  await ledger.setPassword(runtime, revision, 'upload fixture test password');
  const token = await ledger.authenticate(runtime, revision, 'upload fixture test password', 3600);
  const body = 'action=create&name=Must+not+be+created';
  // Wait until dispatch has admitted the session and attached its body listener.
  let arrived; const incoming = new Promise(resolve => { arrived = resolve; });
  server.once('request', () => arrived());
  const completed = new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/_account/teams', method: 'POST',
      headers: { host: 'alice.localhost:4280', origin: runtime.origin, cookie: `__Host-flujo-controller=${token}`,
        'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
    });
    request.once('error', reject); request.write(body.slice(0, 10));
    void incoming.then(() => { ledger.revokeSession(token); request.end(body.slice(10)); }).catch(reject);
  });
  assert.equal(await completed, 401);
  assert.equal(ledger.db.prepare('SELECT count(*) AS n FROM teams').get().n, 0);
});

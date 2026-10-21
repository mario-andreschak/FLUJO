import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { Ledger } from '../dist/ledger.js';
import { createController } from '../dist/server.js';
import { Teams } from '../dist/teams.js';
import { TeamResources } from '../dist/team-resources.js';
import { privateFixture } from './private-fixture.mjs';

// Release-only local HTTP/SQLite coverage. Real browser/installed offline
// operation remains separate acceptance; this transport has no TLS or Docker.
async function fixture(t) {
  const { directory, close } = privateFixture(t); const ledger = new Ledger(directory);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    runtimes: ['alice', 'bob'].map((id, index) => ({ id, actorId: id,
      origin: `https://${id}.localhost:4280`, upstream: `http://127.0.0.1:${4400 + index}`,
      credential: `flo_v1_${String(index).repeat(43)}`, isolationId: `fixture:${id}` })) });
  let forwarded = 0;
  const server = await createController(config, ledger, () => { forwarded++; throw new Error('Resource request reached a runtime'); });
  close.push(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); ledger.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tokens = {}; const sessions = {};
  for (const runtime of config.runtimes) {
    const revision = runtimeRevision(config, runtime);
    await ledger.setPassword(runtime, revision, 'local resource page fixture password');
    tokens[runtime.id] = await ledger.authenticate(runtime, revision, 'local resource page fixture password', 3600);
    sessions[runtime.id] = ledger.session(tokens[runtime.id], runtime, revision);
  }
  const teams = new Teams(ledger); const resources = new TeamResources(ledger);
  const teamId = teams.create(sessions.alice, 'Offline sharing');
  teams.invite(sessions.alice, teamId, teams.detail(sessions.alice, teamId).team.generation, 'bob');
  teams.respond(sessions.bob, teamId, teams.list(sessions.bob).invitations[0].invitation, true);
  const send = (actor, { path = '/_account/resources', method = 'GET', data, body, headers = {} } = {}) => new Promise((resolve, reject) => {
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
  return { ledger, server, sessions, tokens, teams, resources, teamId, send, get forwarded() { return forwarded; } };
}
const value = (page, key) => { const found = page.match(new RegExp(`name="${key}" value="([^"]*)"`)); assert.ok(found, key); return found[1]; };

test('two local members share, exclusively edit, save and restore with explicit consent and no runtime forwarding', async t => {
  const f = await fixture(t); const { teamId, send } = f;
  const content = JSON.stringify({ text: '</textarea><script>untrusted()</script>' });
  const creation = { action: 'create', teamId, kind: 'flow', name: '<Shared flow>', content, consent: 'share' };
  assert.equal((await send('alice', { method: 'POST', data: { ...creation, consent: 'no' } })).status, 400);
  assert.equal((await send('alice', { method: 'POST', data: creation, headers: { origin: 'https://bob.localhost:4280' } })).status, 403);
  assert.equal(f.resources.list(f.sessions.alice, teamId).length, 0);
  const created = await send('alice', { method: 'POST', data: creation }); assert.equal(created.status, 303);
  const id = new URL(created.headers.location, 'https://alice.localhost:4280').searchParams.get('resource');
  const detail = await send('bob', { path: created.headers.location }); assert.equal(detail.status, 200);
  assert.match(detail.body, /&lt;Shared flow&gt;/); assert.ok(!detail.body.includes('<script>untrusted()'));
  assert.equal(detail.headers['cache-control'], 'no-store'); assert.equal(detail.headers['referrer-policy'], 'no-referrer');
  const nonce = detail.body.match(/<script nonce="([A-Za-z0-9_-]{43})">/)[1];
  assert.ok(detail.headers['content-security-policy'].includes(`script-src 'nonce-${nonce}'`));
  assert.ok(detail.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  const edit = await send('bob', { method: 'POST', data: { action: 'edit', teamId, resourceId: id, version: '1' } });
  assert.equal(edit.status, 200); assert.match(edit.body, /data-editor="true"/);
  const lease = { teamId, resourceId: id, token: value(edit.body, 'token'), fence: value(edit.body, 'fence') };
  assert.equal((await send('alice', { method: 'POST', data: { action: 'edit', teamId, resourceId: id, version: '1' } })).status, 423);
  assert.equal((await send('alice', { path: created.headers.location })).body.includes(lease.token), false);
  const renew = await send('bob', { method: 'POST', data: { action: 'renew', ...lease }, headers: { accept: 'application/json' } });
  assert.equal(renew.status, 200); assert.ok(JSON.parse(renew.body).expiresAt > Date.now());
  const save = { action: 'save', ...lease, version: '1', name: 'Edited by Bob', content: '{"step":2}' };
  const saved = await send('bob', { method: 'POST', data: save, headers: { accept: 'application/json' } });
  assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.body).location, created.headers.location);
  assert.equal((await send('bob', { method: 'POST', data: save, headers: { accept: 'application/json' } })).status, 409);
  const download = await send('alice', { path: `${created.headers.location}&version=1&download=1` });
  assert.equal(download.status, 200); assert.deepEqual(JSON.parse(download.body), JSON.parse(content));
  assert.match(download.headers['content-disposition'], /^attachment; filename="flow-[A-Za-z0-9_-]{43}-v1.json"$/);
  const restored = await send('alice', { method: 'POST', data: { action: 'restore', teamId, resourceId: id, version: '2', restoredFrom: '1', consent: 'restore' } });
  assert.equal(restored.status, 303); assert.equal(f.resources.read(f.sessions.bob, teamId, id).revision.restoredFrom, 1);
  assert.equal(f.forwarded, 0);
});

test('bad forms do not write, failed non-JavaScript saves preserve escaped drafts, and departed members lose history access', async t => {
  const f = await fixture(t); const { teamId, send } = f;
  const id = f.resources.create(f.sessions.alice, teamId, 'chat', 'Original', '[]');
  const edit = await send('bob', { method: 'POST', data: { action: 'edit', teamId, resourceId: id, version: '1' } });
  const lease = { teamId, resourceId: id, token: value(edit.body, 'token'), fence: value(edit.body, 'fence') };
  const draft = { action: 'save', ...lease, version: '1', name: '<Draft>', content: '</textarea><script>not-json</script>' };
  const failed = await send('bob', { method: 'POST', data: draft });
  assert.equal(failed.status, 400); assert.match(failed.body, /Your submitted draft/);
  assert.match(failed.body, /&lt;\/textarea&gt;&lt;script&gt;not-json&lt;\/script&gt;/);
  assert.ok(!failed.body.includes(lease.token)); assert.equal(f.resources.read(f.sessions.bob, teamId, id).resource.version, 1);
  const duplicate = new URLSearchParams({ action: 'renew', ...lease }).toString() + '&fence=1';
  assert.equal((await send('bob', { method: 'POST', body: duplicate })).status, 400);
  assert.equal((await send('alice', { path: `/_account/resources?team=${teamId}&team=${teamId}` })).status, 400);
  assert.equal((await send('alice', { method: 'POST', body: 'action=save&content=%FF' })).status, 400);
  f.teams.remove(f.sessions.alice, teamId, f.teams.detail(f.sessions.alice, teamId).team.generation, 'bob');
  const revoked = await send('bob', { method: 'POST', data: { ...draft, content: '[]' }, headers: { accept: 'application/json' } });
  assert.equal(revoked.status, 404); assert.match(JSON.parse(revoked.body).error, /unavailable/);
  assert.equal((await send('bob', { path: `/_account/resources?team=${teamId}&resource=${id}&version=1&download=1` })).status, 404);
  f.ledger.revokeSession(f.tokens.bob);
  assert.equal((await send('bob', { method: 'POST', data: { action: 'renew', ...lease }, headers: { accept: 'application/json' } })).status, 401);
  assert.equal(f.forwarded, 0);
});

test('logout during a resource upload denies saving while preserving the submitted draft without JavaScript', async t => {
  const f = await fixture(t); const id = f.resources.create(f.sessions.alice, f.teamId, 'model', 'Original', '{}');
  const lease = f.resources.acquire(f.sessions.bob, f.teamId, id, 1);
  const body = new URLSearchParams({ action: 'save', teamId: f.teamId, resourceId: id, version: '1', token: lease.token,
    fence: String(lease.fence), name: 'Keep this draft', content: '{"local":"draft"}' }).toString();
  let arrived; const incoming = new Promise(resolve => { arrived = resolve; }); f.server.once('request', () => arrived());
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: f.server.address().port, path: '/_account/resources', method: 'POST', headers: {
      host: 'bob.localhost:4280', origin: 'https://bob.localhost:4280', cookie: `__Host-flujo-controller=${f.tokens.bob}`,
      'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body),
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject); request.write(body.slice(0, 10));
    void incoming.then(() => { f.ledger.revokeSession(f.tokens.bob); request.end(body.slice(10)); }).catch(reject);
  });
  assert.equal(result.status, 401); assert.match(result.body, /Keep this draft/); assert.ok(!result.body.includes(lease.token));
  assert.equal(f.resources.read(f.sessions.alice, f.teamId, id).resource.version, 1);
  assert.equal(f.forwarded, 0);
});

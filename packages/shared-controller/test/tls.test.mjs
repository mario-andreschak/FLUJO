import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { ensureLocalTLS, localTLSRoot } from '../dist/local-tls.js';
import { localExecutable } from '../dist/local-executable.js';
import { updateLocalTrust } from '../dist/tls-trust.js';
import { publishPrivateFile } from '../dist/private-publish.js';
import { readPrivateFile } from '../dist/private-storage.js';
import { Ledger } from '../dist/ledger.js';
import { createController } from '../dist/server.js';
import { privateFixture } from './private-fixture.mjs';

function configuration(directory) {
  return configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    tls: { directory: join(directory, 'tls'), executable: localExecutable('openssl') },
    runtimes: ['alice', 'bob'].map((actorId, index) => ({ id: `${actorId}-runtime`, actorId,
      origin: `https://${actorId}.localhost:4280`, upstream: `http://127.0.0.1:${4211 + index}`,
      isolationId: `fixture-${actorId}`, credential: `flo_v1_${String(index).repeat(43)}` })) });
}

function send(port, ca, { servername = 'alice.localhost', host = 'alice.localhost:4280', method = 'GET',
  path = '/_account', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', servername, port, ca, rejectUnauthorized: true,
      method, path, headers: { host, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('direct local TLS requires local names on the configured port and never rewrites origins', () => {
  const base = { schemaVersion: 2, stateDirectory: process.cwd(), tls: { directory: process.cwd(), executable: process.execPath },
    runtimes: [{ id: 'alice', actorId: 'alice', origin: 'https://alice.localhost:4280',
      upstream: 'http://127.0.0.1:4211', isolationId: 'fixture', credential: `flo_v1_${'a'.repeat(43)}` }] };
  assert.equal(configSchema.safeParse(base).success, true);
  for (const origin of ['https://alice.example:4280', 'https://alice.localhost', 'https://alice-.localhost:4280', 'https://127.0.0.1:4280', 'not-a-url']) {
    assert.equal(configSchema.safeParse({ ...base, runtimes: [{ ...base.runtimes[0], origin }] }).success, false);
  }
});

test('offline issuance, interruption recovery and renewal retain the pinned CA', { timeout: 180_000 }, async t => {
  const { directory } = privateFixture(t);
  const config = configuration(directory);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network disabled'); });
  await assert.rejects(ensureLocalTLS(config));
  await assert.rejects(ensureLocalTLS({ ...config, tls: { ...config.tls, executable: `${process.execPath}.missing-tls-fixture` } }, { initialize: true }));
  const pending = JSON.parse(readPrivateFile(join(config.tls.directory, 'root.json')).toString());
  const pendingKey = readPrivateFile(join(config.tls.directory, `root-${pending.generation}.key`));
  const initial = await ensureLocalTLS(config, { initialize: true });
  assert.equal(pendingKey.equals(readPrivateFile(localTLSRoot(config).keyFile)), true, 'Retry must preserve the journaled authority key');
  assert.equal((await ensureLocalTLS(config)).fingerprint, initial.fingerprint);
  const renewed = await ensureLocalTLS(config, { renew: true });
  assert.equal(renewed.rootFingerprint, initial.rootFingerprint);
  assert.notEqual(renewed.fingerprint, initial.fingerprint);
  assert.equal(renewed.key.equals(initial.key), false);
  assert.equal(localTLSRoot(config).certificate.checkHost('alice.localhost'), undefined, 'Root is not a browser leaf');

  const journal = join(config.tls.directory, 'root.json');
  const saved = readPrivateFile(journal);
  const planned = JSON.parse(saved); delete planned.fingerprint;
  publishPrivateFile(journal, JSON.stringify(planned), saved);
  const recovered = await ensureLocalTLS(config, { initialize: true });
  assert.equal(recovered.rootFingerprint, initial.rootFingerprint);
  assert.equal(recovered.fingerprint, renewed.fingerprint);

  const backup = join(config.tls.directory, 'root-recovery.json');
  renameSync(journal, backup);
  try { await assert.rejects(ensureLocalTLS(config, { initialize: true }), /inconsistent/); }
  finally { renameSync(backup, journal); }
  assert.equal(localTLSRoot(config).certificate.fingerprint256, initial.rootFingerprint);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('real HTTPS enforces certificate trust, local account boundaries and expiration without HTTP fallback', { timeout: 180_000 }, async t => {
  const { directory, close } = privateFixture(t);
  const config = configuration(directory);
  const material = await ensureLocalTLS(config, { initialize: true });
  const root = localTLSRoot(config).certificate;
  const ledger = new Ledger(directory);
  let server;
  close.push(async () => {
    if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await server.stopTLS(); }
    ledger.close();
  });
  server = await createController(config, ledger);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal((await send(port, root.raw)).status, 200);
  await assert.rejects(send(port, undefined));
  await assert.rejects(send(port, root.raw, { servername: 'mallory.localhost' }));
  const plaintext = await new Promise(resolve => {
    const request = httpRequest({ hostname: '127.0.0.1', port }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', () => resolve(0)); request.end();
  });
  assert.ok(plaintext === 0 || plaintext >= 400, 'Plain HTTP must never reach the account page');
  const [alice] = config.runtimes;
  const password = 'private offline TLS fixture password';
  await ledger.setPassword(alice, runtimeRevision(config, alice), password);
  const login = await send(port, root.raw, { method: 'POST', path: '/_account/login',
    headers: { origin: alice.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString() });
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; Secure;/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const denied = await send(port, root.raw, { servername: 'bob.localhost', host: 'bob.localhost:4280', path: '/api/workspaces',
    headers: { cookie, origin: 'https://bob.localhost:4280' } });
  assert.equal(denied.status, 401);
  const sessionsBefore = ledger.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  const authenticate = ledger.authenticate.bind(ledger);
  t.mock.method(ledger, 'authenticate', async (...args) => {
    const token = await authenticate(...args);
    t.mock.method(Date, 'now', () => material.expiresAt + 1000);
    return token;
  });
  const expiredLogin = await send(port, root.raw, { method: 'POST', path: '/_account/login',
    headers: { origin: alice.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString() });
  assert.equal(expiredLogin.status, 503);
  assert.equal(Object.hasOwn(expiredLogin.headers, 'set-cookie'), false);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, sessionsBefore);
  assert.equal((await send(port, root.raw, { headers: { cookie } })).status, 503);
});

test('owned acceptance profile installs and removes only its exact public CA', {
  timeout: 180_000,
  skip: process.env.FLUJO_CONTROLLER_TRUST_ACCEPTANCE !== 'owned-offline-profile' || !['win32', 'linux'].includes(process.platform),
}, async t => {
  // Release only, through flujo-bash in an owned OS/browser acceptance profile.
  // Never enable this flag in the user's ordinary desktop account. Failed native
  // removal retains the private fixture for fingerprint-based recovery.
  const { directory, close } = privateFixture(t, { preserveOnCloseFailure: true });
  const config = configuration(directory);
  const material = await ensureLocalTLS(config, { initialize: true });
  const database = process.platform === 'linux' ? join(directory, 'browser-nss') : undefined;
  close.push(async () => {
    try { await updateLocalTrust(config, true, database); }
    catch { throw new Error(`Native trust removal is unconfirmed; recovery files retained at ${directory}`); }
  });
  assert.ok(await updateLocalTrust(config, false, database));
  assert.ok(await updateLocalTrust(config, false, database), 'Repeated trust keeps the same installation');
  assert.equal(localTLSRoot(config).certificate.fingerprint256, material.rootFingerprint);
  assert.ok(await updateLocalTrust(config, true, database));
  assert.ok(await updateLocalTrust(config, true, database));
});

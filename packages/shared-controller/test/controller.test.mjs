import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { browserRequestAllowed, cookie, SESSION_COOKIE } from '../dist/http.js';
import { Ledger } from '../dist/ledger.js';
import { lockController } from '../dist/process-lock.js';

function configuration() {
  return configSchema.parse({ schemaVersion: 1, issuer: 'https://identity.example', clientId: 'controller',
    clientSecret: 'test-client-secret', stateDirectory: '/srv/private-controller', runtimes: [
      { id: 'alice-runtime', actorId: 'alice', subject: 'sub-alice', origin: 'https://alice.example',
        upstream: 'http://127.0.0.1:4211', isolationId: 'vm-alice', credential: `flo_v1_${'a'.repeat(43)}` },
      { id: 'bob-runtime', actorId: 'bob', subject: 'sub-bob', origin: 'https://bob.example',
        upstream: 'http://127.0.0.1:4212', isolationId: 'vm-bob', credential: `flo_v1_${'b'.repeat(43)}` },
    ] });
}

test('each owner gets distinct browser, network, credential and identity boundaries', () => {
  for (const key of ['id', 'actorId', 'subject', 'origin', 'upstream', 'credential', 'isolationId']) {
    const config = configuration();
    config.runtimes[1][key] = config.runtimes[0][key];
    assert.equal(configSchema.safeParse(config).success, false, key);
  }
  for (const upstream of ['http://localhost:4200', 'http://10.0.0.1:4200', 'https://user:pass@example.com',
    'https://private.example/path', 'http://127.0.0.1.evil.example']) {
    const config = configuration(); config.runtimes[0].upstream = upstream;
    assert.equal(configSchema.safeParse(config).success, false, upstream);
  }
});

test('a change to any credential or identity configuration invalidates prior sessions', () => {
  const config = configuration();
  const before = runtimeRevision(config, config.runtimes[0]);
  config.clientSecret = 'new-test-secret';
  assert.notEqual(runtimeRevision(config, config.runtimes[0]), before);
});

test('same-site siblings and missing mutation origins cannot use host-only authority', () => {
  const origin = 'https://alice.example';
  assert.equal(browserRequestAllowed({ method: 'POST', headers: { origin } }, origin), true);
  for (const headers of [{}, { origin: 'https://bob.example' }, { origin, 'sec-fetch-site': 'same-site' },
    { origin, 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
    assert.equal(browserRequestAllowed({ method: 'POST', headers }, origin), false);
  }
  const token = 'c'.repeat(43);
  assert.equal(cookie({ headers: { cookie: `${SESSION_COOKIE}=${token}` } }, SESSION_COOKIE), token);
  assert.equal(cookie({ headers: { cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}` } }, SESSION_COOKIE), '');
});

test('controller cannot import private runtime modules', () => {
  const directory = new URL('../src/', import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(filename, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      assert.ok(match[2].startsWith('node:') || /^\.\/[^/]+\.js$/.test(match[2])
        || ['zod', 'openid-client'].includes(match[2]), `${filename} imports ${match[2]}`);
    }
  }
});

test('persistent authority survives restart without resurrecting revoked sessions', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(homedir(), '.flujo-controller-test-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldMask = process.umask(0o077);
  t.after(() => process.umask(oldMask));
  let ledger = new Ledger(directory);
  t.after(() => ledger?.close());
  const config = configuration();
  const [alice, bob] = config.runtimes;
  const revision = runtimeRevision(config, alice);
  ledger.reconcile(config);
  assert.equal(ledger.createSession(alice, revision, config.issuer, bob.subject, 3600), null);
  const token = ledger.createSession(alice, revision, config.issuer, alice.subject, 3600);
  assert.ok(token);
  assert.ok(ledger.session(token, alice, revision));
  assert.equal(ledger.session(token, bob, runtimeRevision(config, bob)), null);
  const attempts = { verifier: 'test-verifier', nonce: 'test-nonce', state: 'test-state' };
  const login = ledger.beginLogin(alice, revision, attempts);
  assert.deepEqual(ledger.consumeLogin(login, alice, revision), attempts);
  assert.equal(ledger.consumeLogin(login, alice, revision), null);

  ledger.setActorEnabled(alice.actorId, false);
  assert.equal(ledger.session(token, alice, revision), null);
  ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config);
  assert.equal(ledger.createSession(alice, revision, config.issuer, alice.subject, 3600), null);
  ledger.setActorEnabled(alice.actorId, true);
  assert.equal(ledger.session(token, alice, revision), null);
  const next = ledger.createSession(alice, revision, config.issuer, alice.subject, 3600);
  assert.ok(next);

  const changed = structuredClone(config); changed.runtimes[0].subject = 'sub-mallory';
  assert.throws(() => ledger.reconcile(changed), /cannot be rebound/);
  // A failed reconciliation rolls the whole transition back, including enabled flags.
  assert.ok(ledger.session(next, alice, revision));
  changed.runtimes[0].subject = alice.subject;
  changed.runtimes[0].origin = 'https://replacement.example';
  assert.throws(() => ledger.reconcile(changed), /cannot change owner/);
  assert.ok(ledger.session(next, alice, revision));

  const removed = structuredClone(config); removed.runtimes = [bob];
  ledger.reconcile(removed); ledger.reconcile(config);
  assert.equal(ledger.session(next, alice, revision), null);
  const rows = ledger.db.prepare('SELECT * FROM audit').all();
  assert.ok(rows.some(row => row.action === 'actor.disabled'));
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.equal(JSON.stringify(rows).includes(config.clientSecret), false);
});

test('only one controller can own a state directory; the lock releases without deleting files', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(homedir(), '.flujo-controller-lock-test-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = lockController(directory);
  try { assert.throws(() => lockController(directory), /Another controller/); }
  finally { release(); }
  lockController(directory)();
});

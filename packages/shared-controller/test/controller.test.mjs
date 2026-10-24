import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { privateFixture } from './private-fixture.mjs';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { browserRequestAllowed, cookie, SESSION_COOKIE } from '../dist/http.js';
import { Ledger } from '../dist/ledger.js';
import { lockController } from '../dist/process-lock.js';
import { hashPassword, passwordAllowed, verifyPassword } from '../dist/password.js';
import { createController } from '../dist/server.js';

function configuration() {
  return configSchema.parse({ schemaVersion: 2, stateDirectory: homedir(), runtimes: [
      { id: 'alice-runtime', actorId: 'alice', origin: 'https://alice.localhost',
        upstream: 'http://127.0.0.1:4211', isolationId: 'vm-alice', credential: `flo_v1_${'a'.repeat(43)}` },
      { id: 'bob-runtime', actorId: 'bob', origin: 'https://bob.localhost',
        upstream: 'http://127.0.0.1:4212', isolationId: 'vm-bob', credential: `flo_v1_${'b'.repeat(43)}` },
    ] });
}

test('each owner gets distinct browser, network, credential and identity boundaries', () => {
  for (const key of ['id', 'actorId', 'origin', 'upstream', 'credential', 'isolationId']) {
    const config = configuration();
    config.runtimes[1][key] = config.runtimes[0][key];
    assert.equal(configSchema.safeParse(config).success, false, key);
  }
  for (const upstream of ['http://localhost:4200', 'http://10.0.0.1:4200', 'https://user:pass@example.com',
    'https://private.example/path', 'https://runtime.fly.dev', 'http://127.0.0.1.evil.example']) {
    const config = configuration(); config.runtimes[0].upstream = upstream;
    assert.equal(configSchema.safeParse(config).success, false, upstream);
  }
  const sameHost = configuration();
  sameHost.runtimes[1].origin = 'https://alice.localhost:4443';
  assert.equal(configSchema.safeParse(sameHost).success, false, 'cookies do not isolate ports');
  const remoteIdentity = { ...configuration(), issuer: 'https://identity.example' };
  assert.equal(configSchema.safeParse(remoteIdentity).success, false, 'no required external identity');
  const malformed = configuration(); malformed.runtimes[0].origin = 'not-a-url';
  assert.equal(configSchema.safeParse(malformed).success, false);
});

test('a change to any credential or identity configuration invalidates prior sessions', () => {
  const config = configuration();
  const before = runtimeRevision(config, config.runtimes[0]);
  config.runtimes[0].credential = `flo_v1_${'z'.repeat(43)}`;
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
        || match[2] === 'zod', `${filename} imports ${match[2]}`);
    }
  }
});

test('password hashes are salted, bounded and reject wrong or malformed credentials', async () => {
  const password = 'a local test passphrase';
  assert.equal(passwordAllowed('short'), false);
  assert.equal(passwordAllowed('x'.repeat(1025)), false);
  assert.equal(passwordAllowed('long password\u0000control'), false);
  const first = await hashPassword(password);
  assert.notEqual(first, await hashPassword(password));
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('a different test password', first), false);
  assert.equal(await verifyPassword(password, first.replace('scrypt-v1', 'scrypt-v2')), false);
});

test('local authority survives offline restart without resurrecting revoked sessions', async t => {
  // The durable backoff check must not depend on how long CI takes to reopen SQLite.
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  const { directory, close } = privateFixture(t);
  let ledger = new Ledger(directory);
  close.push(() => ledger?.close());
  const config = configuration();
  const [alice, bob] = config.runtimes;
  const revision = runtimeRevision(config, alice);
  ledger.reconcile(config);
  // No account is accessible until the local operator explicitly enrolls it.
  const alicePassword = 'alice private test passphrase';
  const bobPassword = 'bob private test passphrase';
  assert.equal(await ledger.authenticate(alice, revision, alicePassword, 3600), null);
  await ledger.setPassword(alice, revision, alicePassword);
  await ledger.setPassword(bob, runtimeRevision(config, bob), bobPassword);
  const token = await ledger.authenticate(alice, revision, alicePassword, 3600);
  assert.ok(token);
  assert.ok(ledger.session(token, alice, revision));
  assert.equal(ledger.session(token, bob, runtimeRevision(config, bob)), null);

  ledger.setActorEnabled(alice.actorId, false);
  assert.equal(ledger.session(token, alice, revision), null);
  ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config);
  assert.equal(await ledger.authenticate(alice, revision, alicePassword, 3600), null);
  ledger.setActorEnabled(alice.actorId, true);
  assert.equal(ledger.session(token, alice, revision), null);
  const next = await ledger.authenticate(alice, revision, alicePassword, 3600);
  assert.ok(next);

  const changed = structuredClone(config); changed.runtimes[0].actorId = 'mallory';
  assert.throws(() => ledger.reconcile(changed), /cannot change owner/);
  // A failed reconciliation rolls the whole transition back, including enabled flags.
  assert.ok(ledger.session(next, alice, revision));

  const reusedHost = structuredClone(config);
  reusedHost.runtimes = [{ ...alice, id: 'new-runtime', actorId: 'charlie', origin: 'https://alice.localhost:4443',
    isolationId: 'local-charlie' }];
  assert.throws(() => ledger.reconcile(reusedHost), /UNIQUE constraint failed/);
  assert.ok(ledger.session(next, alice, revision));
  changed.runtimes[0].actorId = alice.actorId;
  changed.runtimes[0].origin = 'https://replacement.example';
  assert.throws(() => ledger.reconcile(changed), /cannot change owner/);
  assert.ok(ledger.session(next, alice, revision));

  const removed = structuredClone(config); removed.runtimes = [bob];
  ledger.reconcile(removed); ledger.reconcile(config);
  assert.equal(ledger.session(next, alice, revision), null);
  const rows = ledger.db.prepare('SELECT * FROM audit').all();
  assert.ok(rows.some(row => row.action === 'actor.disabled'));
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.equal(JSON.stringify(rows).includes(alicePassword), false);

  // Startup itself performs no discovery or provider request, even on a cold
  // local restart. This is a controller regression, not full runtime acceptance.
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network disabled'); });
  const controller = await createController(config, ledger);
  controller.close();
  assert.equal(globalThis.fetch.mock.callCount(), 0);

  // A disable/re-enable while scrypt awaits must invalidate that login attempt.
  const inFlight = ledger.authenticate(alice, revision, alicePassword, 3600);
  ledger.setActorEnabled(alice.actorId, false); ledger.setActorEnabled(alice.actorId, true);
  assert.equal(await inFlight, null);
  await ledger.setPassword(alice, revision, 'replacement local test passphrase');
  const replacement = await ledger.authenticate(alice, revision, 'replacement local test passphrase', 3600);
  assert.ok(replacement);
  assert.equal(await ledger.authenticate(alice, revision, bobPassword, 3600), null);
  const attempts = ledger.db.prepare('SELECT attempts,next_attempt_at FROM passwords WHERE actor_id=?').get(alice.actorId);
  assert.equal(attempts.attempts, 1);
  ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config);
  assert.deepEqual(ledger.db.prepare('SELECT attempts,next_attempt_at FROM passwords WHERE actor_id=?').get(alice.actorId), attempts);
  assert.equal(await ledger.authenticate(alice, revision, 'replacement local test passphrase', 3600), null);
  assert.ok(ledger.session(replacement, alice, revision));
  await ledger.setPassword(alice, revision, alicePassword);
  assert.equal(ledger.session(replacement, alice, revision), null);
});

test('only one controller can own a state directory; the lock releases without deleting files', t => {
  const { directory } = privateFixture(t);
  const release = lockController(directory);
  try { assert.throws(() => lockController(directory), /Another controller/); }
  finally { release(); }
  lockController(directory)();
});

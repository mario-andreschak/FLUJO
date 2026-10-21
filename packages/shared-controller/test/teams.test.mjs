import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { Ledger } from '../dist/ledger.js';
import { Teams, TeamError } from '../dist/teams.js';
import { privateFixture } from './private-fixture.mjs';

const password = 'a local team fixture password';
async function fixture(t) {
  const { directory, close } = privateFixture(t);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    runtimes: ['alice', 'bob', 'charlie'].map((id, index) => ({ id, actorId: id,
      origin: `https://${id}.localhost:4280`, upstream: `http://127.0.0.1:${4400 + index}`,
      credential: `flo_v1_${String(index).repeat(43)}`, isolationId: `fixture:${id}` })) });
  let ledger = new Ledger(directory); ledger.reconcile(config);
  close.push(() => ledger.close());
  const sessions = {}; const tokens = {};
  for (const runtime of config.runtimes) {
    const revision = runtimeRevision(config, runtime);
    await ledger.setPassword(runtime, revision, password);
    tokens[runtime.id] = await ledger.authenticate(runtime, revision, password, 3600);
    sessions[runtime.id] = ledger.session(tokens[runtime.id], runtime, revision);
    assert.ok(sessions[runtime.id]);
  }
  return { get ledger() { return ledger; }, config, directory, sessions, tokens,
    reopen() { ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config); return new Teams(ledger); } };
}
const status = expected => error => error instanceof TeamError && error.status === expected;
const version = (teams, session, id) => teams.detail(session, id).team.generation;

test('local invitations require recipient consent; revision witnesses never revive after removal and reinvitation', async t => {
  const f = await fixture(t); const teams = new Teams(f.ledger); const { alice, bob, charlie } = f.sessions;
  const id = teams.create(alice, 'Our offline team');
  const created = teams.authority(alice, id);
  assert.deepEqual(teams.list(bob), { teams: [], invitations: [] });
  teams.invite(alice, id, created.generation, 'bob');
  assert.equal(teams.current(created), false);
  const invitation = teams.list(bob).invitations[0].invitation;
  assert.throws(() => teams.detail(bob, id), status(404));
  assert.throws(() => teams.respond(charlie, id, invitation, true), status(404));
  assert.throws(() => teams.respond(bob, id, 'x'.repeat(43), true), status(404));
  teams.respond(bob, id, invitation, true);
  const admitted = teams.authority(bob, id);
  assert.equal(teams.current(admitted), true);
  assert.throws(() => teams.respond(bob, id, invitation, true), status(404));
  assert.throws(() => teams.invite(bob, id, admitted.generation, 'charlie'), status(403));
  assert.throws(() => teams.remove(bob, id, admitted.generation, 'alice'), status(409));
  assert.throws(() => teams.detail(charlie, id), status(404));
  teams.remove(alice, id, admitted.generation, 'bob');
  assert.equal(teams.current(admitted), false);
  assert.throws(() => teams.detail(bob, id), status(404));
  teams.invite(alice, id, version(teams, alice, id), 'bob');
  const reissued = teams.list(bob).invitations[0].invitation;
  assert.notEqual(reissued, invitation);
  assert.throws(() => teams.respond(bob, id, invitation, true), status(404));
  teams.respond(bob, id, reissued, true);
  assert.equal(teams.current(admitted), false);
  assert.equal(teams.current(teams.authority(bob, id)), true);
  const detail = teams.detail(bob, id);
  assert.equal(detail.members.length, 2);
  assert.deepEqual(detail.events.map(event => event.action).reverse(), ['created', 'invited', 'joined', 'removed', 'invited', 'joined']);
  assert.ok(detail.events.every(event => !Object.hasOwn(event, 'invitation')));
});

test('restart preserves membership, while durable session recovery and cross-connection revocation deny old witnesses', async t => {
  const f = await fixture(t); let teams = new Teams(f.ledger); const { alice, bob } = f.sessions;
  const id = teams.create(alice, 'Restart team');
  teams.invite(alice, id, version(teams, alice, id), 'bob');
  teams.respond(bob, id, teams.list(bob).invitations[0].invitation, true);
  const authority = teams.authority(bob, id);
  teams = f.reopen();
  assert.equal(teams.current(authority), true);
  assert.equal(teams.list(bob).teams[0].name, 'Restart team');
  const second = new Ledger(f.directory);
  try {
    const concurrent = new Teams(second);
    const displayed = version(teams, alice, id);
    concurrent.rename(alice, id, displayed, 'Renamed locally');
    assert.throws(() => teams.invite(alice, id, displayed, 'charlie'), status(409));
    assert.equal(teams.current(authority), false);
    const fresh = teams.authority(bob, id);
    second.revokeSession(f.tokens.bob);
    assert.equal(teams.current(fresh), false);
    assert.throws(() => teams.list(bob), status(401));
  } finally { second.close(); }
  const creator = teams.authority(alice, id);
  const runtime = f.config.runtimes[0];
  await f.ledger.setPassword(runtime, runtimeRevision(f.config, runtime), 'replacement local team password');
  assert.equal(teams.current(creator), false);
});

test('withdrawal, decline, expiry, account disable and archive all refuse stale invitations', async t => {
  const f = await fixture(t); const teams = new Teams(f.ledger); const { alice, bob } = f.sessions;
  const id = teams.create(alice, 'Invitation lifecycle');
  const invite = () => { teams.invite(alice, id, version(teams, alice, id), 'bob'); return teams.list(bob).invitations[0].invitation; };
  const first = invite(); teams.remove(alice, id, version(teams, alice, id), 'bob');
  assert.throws(() => teams.respond(bob, id, first, true), status(404));
  const declined = invite(); teams.respond(bob, id, declined, false);
  assert.throws(() => teams.respond(bob, id, declined, true), status(404));
  const expired = invite();
  f.ledger.db.prepare('UPDATE team_members SET expires_at=? WHERE team_id=? AND actor_id=?').run(Date.now() - 1, id, 'bob');
  assert.equal(teams.list(bob).invitations.length, 0);
  assert.throws(() => teams.respond(bob, id, expired, true), status(404));
  const pending = invite();
  f.ledger.setActorEnabled('alice', false);
  assert.equal(teams.list(bob).invitations.length, 0);
  assert.throws(() => teams.respond(bob, id, pending, true), status(404));
  f.ledger.setActorEnabled('alice', true);
  assert.throws(() => teams.create(alice, 'Old session'), status(401));
  const runtime = f.config.runtimes[0]; const revision = runtimeRevision(f.config, runtime);
  const token = await f.ledger.authenticate(runtime, revision, password, 3600);
  const renewed = f.ledger.session(token, runtime, revision); assert.ok(renewed);
  const beforeArchive = teams.authority(renewed, id);
  teams.archive(renewed, id, beforeArchive.generation);
  assert.equal(teams.current(beforeArchive), false);
  assert.equal(teams.list(bob).invitations.length, 0);
  assert.throws(() => teams.respond(bob, id, pending, true), status(404));
  assert.equal(teams.list(renewed).teams.length, 0);
  assert.equal(f.ledger.db.prepare('SELECT archived FROM teams WHERE id=?').get(id).archived, 1);
});

test('team forms cannot use a forged session, invisible team or invalid name, and directory activity is bounded', async t => {
  const f = await fixture(t); const teams = new Teams(f.ledger); const { alice, bob } = f.sessions;
  assert.throws(() => teams.create({ ...alice, actorId: 'bob' }, 'Forged actor'), status(401));
  for (const name of ['', ' '.repeat(10), 'a'.repeat(81), 'name\u202eevil', 'name\0']) {
    assert.throws(() => teams.create(alice, name), status(400));
  }
  const id = teams.create(alice, 'Bounded activity');
  for (let i = 0; i < 205; i++) teams.rename(alice, id, version(teams, alice, id), `Name ${i}`);
  assert.equal(teams.detail(alice, id).events.length, 200);
  assert.throws(() => teams.rename(bob, id, 0, 'Guess'), status(404));
  assert.throws(() => teams.invite(alice, id, version(teams, alice, id), 'unknown'), status(400));
  assert.equal(teams.list(bob).teams.length, 0);
  assert.equal(f.ledger.db.prepare('PRAGMA user_version').get().user_version, 8);
});

test('schema 5 upgrades preserve enrolled accounts and current sessions without creating memberships', async t => {
  const f = await fixture(t);
  // Reconstruct the preceding unreleased schema: it has no team tables.
  f.ledger.db.exec('DROP TABLE team_resource_versions; DROP TABLE team_resources; DROP TABLE team_events; DROP TABLE team_members; DROP TABLE teams; PRAGMA user_version=5;');
  const teams = f.reopen();
  assert.equal(f.ledger.db.prepare('PRAGMA user_version').get().user_version, 8);
  for (const session of Object.values(f.sessions)) {
    assert.equal(f.ledger.sessionCurrent(session), true);
    assert.deepEqual(teams.list(session), { teams: [], invitations: [] });
  }
  assert.ok(teams.create(f.sessions.alice, 'First team after upgrade'));
});

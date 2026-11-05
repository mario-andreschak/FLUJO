import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GET as getPeople, POST as postPerson } from '@/app/api/owner/people/route';
import { DELETE as revokePerson, PATCH as patchPerson } from '@/app/api/owner/people/[id]/route';
import { GET as getAudit } from '@/app/api/owner/audit/route';
import { GET as getAccess, POST as postAccess } from '@/app/api/owner/access/route';
import { GET as getMe } from '@/app/api/owner/me/route';
import { DELETE as logout, GET as getSession, POST as login } from '@/app/api/owner/session/route';
import { accessActorFromPrincipal } from '@/backend/services/security/accessContext';
import { flushAccessEvents, recordAccessEvent, readAccessEvents } from '@/backend/services/security/accessAudit';
import { assertOwnerRequest, resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { readOwnerPolicy } from '@/backend/services/security/ownerPolicy';
import { assertOwnerStartup } from '@/backend/services/security/ownerStartup';
import { createPerson } from '@/backend/services/security/accessPeople';
import { bearer, createNamedAccessFixture, type NamedAccessFixture } from './fixtures/namedAccess';

const ORIGIN = 'http://localhost:4200';
const DAY = 24 * 60 * 60 * 1000;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const peopleUrl = `${ORIGIN}/api/owner/people`;

/** The real command line tool, in its own process, as an operator would run it. */
function tool(...args: string[]) {
  const run = spawnSync(process.execPath, ['scripts/owner-access.mjs', ...args], {
    encoding: 'utf8', env: { ...process.env, FLUJO_DATA_DIR: path.join(fixture.directory, 'data') },
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as Record<string, string> & { kept: number; leftOut: number };
}

let fixture: NamedAccessFixture;
beforeEach(() => {
  fixture = createNamedAccessFixture({ admin: 'admin', operator: 'operator', viewer: 'viewer', health: 'health' });
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = ORIGIN;
});
afterEach(async () => { await flushAccessEvents(); fixture.restore(); });

async function create(token: string, body: Record<string, unknown>) {
  const response = await postPerson(bearer(token, peopleUrl, { method: 'POST', body: JSON.stringify(body) }));
  return { response, json: await response.json() as { person?: { id: string }; token?: string; code?: string; error?: string } };
}
const inFuture = () => Date.now() + 30 * DAY;

describe('managing people without touching the file', () => {
  it('creates a person whose plain secret appears once and only in that response', async () => {
    const { response, json } = await create(fixture.tokens.admin, { name: 'Anna', role: 'operator', expiresAt: inFuture() });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.token).toMatch(/^flo_v1_/);
    await flushAccessEvents();
    const onDisk = fs.readdirSync(fixture.directory).map(file => {
      const full = path.join(fixture.directory, file);
      return fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : '';
    }).join('\n');
    expect(onDisk).not.toContain(json.token!);
    const listed = await (await getPeople(bearer(fixture.tokens.admin, peopleUrl))).json() as { people: Array<{ id: string; name: string }> };
    expect(JSON.stringify(listed)).not.toContain(json.token!);
    expect(JSON.stringify(listed)).not.toContain('digest');
    expect(listed.people.map(person => person.name)).toContain('Anna');
    // The new secret works at once, with exactly the role it was given.
    expect(assertOwnerRequest(bearer(json.token!, `${ORIGIN}/api/runs/active`))).toBeNull();
    expect(assertOwnerRequest(bearer(json.token!, `${ORIGIN}/api/flow`))?.status).toBe(403);
  });

  it('renames, expires and revokes, and each takes effect on the next request', async () => {
    const { json } = await create(fixture.tokens.admin, { name: 'Ben', role: 'operator', expiresAt: inFuture() });
    const id = json.person!.id;
    const check = `${ORIGIN}/api/runs/active`;
    const rename = await patchPerson(bearer(fixture.tokens.admin, `${peopleUrl}/${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Benjamin' }) }), context(id));
    expect(rename.status).toBe(200);
    expect(assertOwnerRequest(bearer(json.token!, check))).toBeNull();

    const expire = await patchPerson(bearer(fixture.tokens.admin, `${peopleUrl}/${id}`, { method: 'PATCH', body: JSON.stringify({ expiresAt: Date.now() }) }), context(id));
    expect(expire.status).toBe(200);
    expect(assertOwnerRequest(bearer(json.token!, check))?.status).toBe(401);

    const second = await create(fixture.tokens.admin, { name: 'Cara', role: 'operator', expiresAt: inFuture() });
    const revoked = await revokePerson(bearer(fixture.tokens.admin, `${peopleUrl}/${second.json.person!.id}`, { method: 'DELETE' }), context(second.json.person!.id));
    expect(revoked.status).toBe(200);
    expect(assertOwnerRequest(bearer(second.json.token!, check))?.status).toBe(401);
    // A revoked credential cannot be brought back by changing it.
    const revive = await patchPerson(bearer(fixture.tokens.admin, `${peopleUrl}/${second.json.person!.id}`, { method: 'PATCH', body: JSON.stringify({ expiresAt: inFuture() }) }), context(second.json.person!.id));
    expect(revive.status).toBe(400);
  });

  it.each([
    [{ name: '', role: 'operator' }], [{ name: 'x'.repeat(81), role: 'operator' }], [{ name: 'line\nbreak', role: 'operator' }],
    [{ name: 'Z', role: 'nonsense' }], [{ name: 'Z', role: 'custom', scopes: ['not:a:scope'] }], [{ name: 'Z', role: 'custom', scopes: [] }],
    [{ name: 'Z', role: 'operator', scopes: ['control:admin'] }],
    [{ name: 'Z', role: 'operator', flowIds: ['one'] }],
    [{ name: 'Z', role: 'admin', workspaceId: 'site-a' }],
    [{ name: 'Z', role: 'operator', workspaceId: '../escape' }],
    [{ name: 'Z', role: 'custom', scopes: ['runs:all', 'runs:read'], workspaceId: 'site-a', flowIds: ['one'] }],
  ])('refuses the broken input %j', async body => {
    const { response } = await create(fixture.tokens.admin, { ...body, expiresAt: inFuture() });
    expect(response.status).toBe(400);
    expect(fixture.read().credentials).toHaveLength(4);
  });

  it('refuses an expiry in the past or absurdly far away, and a body that is not JSON', async () => {
    expect((await create(fixture.tokens.admin, { name: 'Z', role: 'operator', expiresAt: Date.now() - 1 })).response.status).toBe(400);
    expect((await create(fixture.tokens.admin, { name: 'Z', role: 'operator', expiresAt: Date.now() + 11 * 365 * DAY })).response.status).toBe(400);
    const broken = await postPerson(bearer(fixture.tokens.admin, peopleUrl, { method: 'POST', body: 'not json' }));
    expect(broken.status).toBe(400);
  });

  it('allows a custom scope list, and a credential limited to named flows', async () => {
    const custom = await create(fixture.tokens.admin, { name: 'Dev', role: 'custom', scopes: ['runs:read', 'audit:read'], expiresAt: inFuture() });
    expect(custom.response.status).toBe(201);
    const limited = await create(fixture.tokens.admin, { name: 'Lim', role: 'operator', workspaceId: 'site-a', flowIds: ['one', 'two'], expiresAt: inFuture() });
    expect(limited.response.status).toBe(201);
    expect(fixture.read().credentials.find(item => item.name === 'Lim')).toMatchObject({ workspaceId: 'site-a', flowIds: ['one', 'two'] });
  });

  it('does not let a non-manager reach any of it', async () => {
    for (const role of ['operator', 'viewer', 'health']) {
      expect(assertOwnerRequest(bearer(fixture.tokens[role], peopleUrl))?.status).toBe(403);
      expect((await getPeople(bearer(fixture.tokens[role], peopleUrl))).status).toBe(403);
      expect((await create(fixture.tokens[role], { name: 'Z', role: 'admin', expiresAt: inFuture() })).response.status).toBe(403);
      expect((await getAudit(bearer(fixture.tokens[role], `${ORIGIN}/api/owner/audit`))).status).toBe(403);
    }
  });
});

describe('nobody can be locked out, and nobody can climb', () => {
  it('refuses to remove the last administrator, by any route', async () => {
    const id = fixture.ids.admin;
    const url = `${peopleUrl}/${id}`;
    expect((await revokePerson(bearer(fixture.tokens.admin, url, { method: 'DELETE' }), context(id))).status).toBe(409);
    expect((await patchPerson(bearer(fixture.tokens.admin, url, { method: 'PATCH', body: JSON.stringify({ expiresAt: Date.now() }) }), context(id))).status).toBe(409);
    const demoted = await patchPerson(bearer(fixture.tokens.admin, url, { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) }), context(id));
    expect(demoted.status).toBe(409);
    expect((await demoted.json() as { code: string }).code).toBe('LAST_ADMIN');
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, peopleUrl))).toBeNull();
  });

  it('lets the owner step down once there is another administrator', async () => {
    const second = await create(fixture.tokens.admin, { name: 'Second admin', role: 'admin', expiresAt: inFuture() });
    expect(second.response.status).toBe(201);
    const id = fixture.ids.admin;
    expect((await revokePerson(bearer(fixture.tokens.admin, `${peopleUrl}/${id}`, { method: 'DELETE' }), context(id))).status).toBe(200);
    expect(assertOwnerRequest(bearer(second.json.token!, peopleUrl))).toBeNull();
  });

  it('holds a people manager to what they hold themselves', async () => {
    fixture.add('site-manager', { scopes: ['access:manage', 'runs:read', 'runs:manage', 'openai:execute', 'openai:read', 'approvals:respond', 'session:login'], workspaceId: 'site-a' });
    const token = fixture.tokens['site-manager'];
    // Cannot mint anything broader than itself.
    expect((await create(token, { name: 'Up', role: 'admin', expiresAt: inFuture() })).response.status).toBe(400); // admin cannot be workspace-bound
    expect((await create(token, { name: 'Up', role: 'viewer', expiresAt: inFuture() })).response.status).toBe(403);
    expect((await create(token, { name: 'Up', role: 'custom', scopes: ['control:admin', 'secrets:read'], workspaceId: 'site-a', expiresAt: inFuture() })).response.status).toBe(400);
    // Cannot reach another site, or anyone outside its own.
    expect((await create(token, { name: 'Far', role: 'operator', workspaceId: 'site-b', expiresAt: inFuture() })).response.status).toBe(403);
    const adminId = fixture.ids.admin;
    expect((await revokePerson(bearer(token, `${peopleUrl}/${adminId}`, { method: 'DELETE' }), context(adminId))).status).toBe(404);
    const listed = await (await getPeople(bearer(token, peopleUrl))).json() as { people: Array<{ name: string }> };
    expect(listed.people.map(person => person.name)).toEqual(['site-manager']);
    // Inside its own site it works, and the new person lands inside that site.
    const made = await create(token, { name: 'Local', role: 'operator', expiresAt: inFuture() });
    expect(made.response.status).toBe(201);
    expect(fixture.read().credentials.find(item => item.name === 'Local')?.workspaceId).toBe('site-a');
    // And it cannot change its own access.
    const self = fixture.ids['site-manager'];
    expect((await patchPerson(bearer(token, `${peopleUrl}/${self}`, { method: 'PATCH', body: JSON.stringify({ role: 'operator' }) }), context(self))).status).toBe(403);
  });

  it('survives two changes racing each other without losing either', async () => {
    const results = await Promise.all(['one', 'two', 'three', 'four'].map(name => create(fixture.tokens.admin, { name, role: 'operator', expiresAt: inFuture() })));
    expect(results.every(result => result.response.status === 201)).toBe(true);
    const names = fixture.read().credentials.map(item => item.name);
    expect(names).toEqual(expect.arrayContaining(['one', 'two', 'three', 'four']));
  });

  it('takes over a lock left behind by a crash, and answers busy on a live one', async () => {
    const lock = `${fixture.policyFile}.lock`;
    fs.writeFileSync(lock, '');
    const busy = await create(fixture.tokens.admin, { name: 'while-busy', role: 'operator', expiresAt: inFuture() });
    expect(busy.response.status).toBe(503);
    expect(busy.json.code).toBe('BUSY');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    expect((await create(fixture.tokens.admin, { name: 'after-crash', role: 'operator', expiresAt: inFuture() })).response.status).toBe(201);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('makes room from long-ended entries when the list is full, and otherwise says so plainly', async () => {
    const policy = fixture.read();
    const now = Date.now();
    const ended = Array.from({ length: 124 }, (_, index) => {
      const { record } = issueOwnerCredential(['openai:read'], now + DAY, now - 60 * DAY);
      return { ...record, name: `old-${index}`, role: 'custom' as const, revokedAt: now - 40 * DAY };
    });
    fixture.write({ ...policy, credentials: [...policy.credentials, ...ended] });
    expect((await create(fixture.tokens.admin, { name: 'fits', role: 'operator', expiresAt: inFuture() })).response.status).toBe(201);
    expect(fixture.read().credentials.filter(item => item.name?.startsWith('old-'))).toHaveLength(0);

    const active = Array.from({ length: 123 }, (_, index) => {
      const { record } = issueOwnerCredential(['openai:read'], now + DAY, now - 1000);
      return { ...record, name: `active-${index}`, role: 'custom' as const };
    });
    const current = fixture.read();
    fixture.write({ ...current, credentials: [...current.credentials, ...active] });
    const full = await create(fixture.tokens.admin, { name: 'too-many', role: 'operator', expiresAt: inFuture() });
    expect(full.response.status).toBe(409);
    expect(full.json.code).toBe('POLICY_FULL');
    // Revoking someone gives the admin a way forward, without a restart.
    const victim = fixture.read().credentials.find(item => item.name === 'active-0')!;
    await revokePerson(bearer(fixture.tokens.admin, `${peopleUrl}/${victim.id}`, { method: 'DELETE' }), context(victim.id));
    expect((await create(fixture.tokens.admin, { name: 'now-fits', role: 'operator', expiresAt: inFuture() })).response.status).toBe(201);
  });
});

describe('turning it on and getting back in', () => {
  it('turns a schema 1 policy on without losing the owner or a browser session', async () => {
    const owner = issueOwnerCredential(['control:admin', 'secrets:read', 'mcp:access'], Date.now() + DAY, Date.now() - 1000);
    const client = issueOwnerCredential(['openai:execute'], Date.now() + DAY, Date.now() - 1000);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [owner.record, client.record] });
    const url = `${ORIGIN}/api/owner/session`;
    const signedIn = await login(bearer(owner.token, url, { method: 'POST', headers: { origin: ORIGIN } }));
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
    const session = () => new Request(url, { headers: { host: 'localhost:4200', origin: ORIGIN, cookie } });
    expect((await getSession(session())).status).toBe(200);

    expect(await (await getAccess(bearer(owner.token, `${ORIGIN}/api/owner/access`))).json()).toMatchObject({ mode: 'policy' });
    expect((await getPeople(bearer(owner.token, peopleUrl))).status).toBe(409);

    // Only an administrator may switch it on.
    const refused = await postAccess(bearer(client.token, `${ORIGIN}/api/owner/access`, { method: 'POST', body: JSON.stringify({ action: 'enable' }) }));
    expect(refused.status).toBe(403);
    const enabled = await postAccess(bearer(owner.token, `${ORIGIN}/api/owner/access`, { method: 'POST', body: JSON.stringify({ action: 'enable' }) }));
    expect(await enabled.json()).toEqual({ mode: 'named', changed: true });

    const policy = readOwnerPolicy(fixture.policyFile);
    expect(policy.schemaVersion).toBe(2);
    expect(policy.credentials.find(item => item.id === owner.record.id)).toMatchObject({ role: 'admin', name: 'Owner' });
    expect(policy.credentials.find(item => item.id === client.record.id)).toMatchObject({ role: 'custom', scopes: ['openai:execute'] });
    // Same secret, same open browser session.
    expect(assertOwnerRequest(bearer(owner.token, peopleUrl))).toBeNull();
    expect((await getSession(session())).status).toBe(200);
    // The other credential did not gain anything.
    expect(assertOwnerRequest(bearer(client.token, peopleUrl))?.status).toBe(403);
    // Switching on twice changes nothing.
    const again = await postAccess(bearer(owner.token, `${ORIGIN}/api/owner/access`, { method: 'POST', body: JSON.stringify({ action: 'enable' }) }));
    expect(await again.json()).toEqual({ mode: 'named', changed: false });
  });

  it('refuses to switch on a policy with no active administrator', async () => {
    const lapsed = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 500, Date.now() - 1000);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [{ ...lapsed.record, revokedAt: Date.now() - 1 }] });
    const before = fs.readFileSync(fixture.policyFile, 'utf8');
    const { enableNamedAccess } = await import('@/backend/services/security/accessPeople');
    expect(() => enableNamedAccess()).toThrow('lock everyone out');
    expect(fs.readFileSync(fixture.policyFile, 'utf8')).toBe(before);
  });

  it('reports off and refuses to enable when no policy is selected, as on an ordinary install', async () => {
    delete process.env.FLUJO_OWNER_AUTH_FILE;
    expect(await (await getAccess(new Request(`${ORIGIN}/api/owner/access`))).json()).toMatchObject({ mode: 'off' });
    expect(await (await getMe(new Request(`${ORIGIN}/api/owner/me`))).json()).toEqual({ mode: 'off' });
    expect((await postAccess(new Request(`${ORIGIN}/api/owner/access`, { method: 'POST', body: '{"action":"enable"}' }))).status).toBe(409);
    expect(assertOwnerRequest(new Request(`${ORIGIN}/api/flow`))).toBeNull();
  });

  it('recovers from a corrupt policy with the local tool, keeps the old file aside, and starts again', () => {
    fs.writeFileSync(fixture.policyFile, '{ broken', { mode: 0o600 });
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, peopleUrl))?.status).toBe(503);
    expect(() => assertOwnerStartup()).toThrow('owner-access.mjs recover');
    const result = tool('recover', fixture.policyFile);
    expect(fs.readFileSync(result.corruptPolicyKeptAt, 'utf8')).toBe('{ broken');
    const token = fs.readFileSync(result.tokenFile, 'utf8');
    expect(assertOwnerRequest(bearer(token, peopleUrl))).toBeNull();
    expect(() => assertOwnerStartup()).not.toThrow();
    expect(readOwnerPolicy(fixture.policyFile).schemaVersion).toBe(2);
  });

  it('recovers when every administrator is lost, without touching the other people', () => {
    const policy = fixture.read();
    fixture.write({ ...policy, credentials: policy.credentials.map(item => item.name === 'admin' ? { ...item, revokedAt: Date.now() - 1 } : item) });
    const { tokenFile, corruptPolicyKeptAt } = tool('recover', fixture.policyFile);
    expect(corruptPolicyKeptAt).toBeUndefined();
    expect(assertOwnerRequest(bearer(fs.readFileSync(tokenFile, 'utf8'), peopleUrl))).toBeNull();
    expect(assertOwnerRequest(bearer(fixture.tokens.viewer, `${ORIGIN}/api/flow`))).toBeNull();
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, peopleUrl))?.status).toBe(401);
  });

  it('adds a usable owner to a schema 1 policy and leaves it schema 1', () => {
    const owner = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + DAY, Date.now() - 1000);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [owner.record] });
    const { tokenFile } = tool('recover', fixture.policyFile);
    expect(readOwnerPolicy(fixture.policyFile).schemaVersion).toBe(1);
    expect(assertOwnerRequest(bearer(fs.readFileSync(tokenFile, 'utf8'), `${ORIGIN}/api/flow`))).toBeNull();
    expect(assertOwnerRequest(bearer(owner.token, `${ORIGIN}/api/flow`))).toBeNull();
  });

  it('restores the last good policy kept beside the current one', async () => {
    await create(fixture.tokens.admin, { name: 'added', role: 'operator', expiresAt: inFuture() });
    fs.writeFileSync(fixture.policyFile, 'ruined', { mode: 0o600 });
    tool('restore', fixture.policyFile);
    expect(readOwnerPolicy(fixture.policyFile).credentials.map(item => item.name)).toContain('admin');
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, peopleUrl))).toBeNull();
  });

  it('writes a policy an older version can read, leaving narrow people out rather than widening them', () => {
    const target = path.join(fixture.directory, 'older.json');
    const result = tool('export-v1', fixture.policyFile, target);
    expect(result).toMatchObject({ kept: 1, leftOut: 3 });
    const legacy = readOwnerPolicy(target);
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.credentials[0].scopes).toEqual(expect.arrayContaining(['control:admin', 'secrets:read']));
    process.env.FLUJO_OWNER_AUTH_FILE = target;
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, `${ORIGIN}/api/flow`))).toBeNull();
  });

  it('runs the real command line tool from enable to a working first administrator', () => {
    const directory = path.join(fixture.directory, 'fresh-private');
    const run = spawnSync(process.execPath, ['scripts/owner-access.mjs', 'enable', directory, '--origin', ORIGIN], {
      encoding: 'utf8', env: { ...process.env, FLUJO_DATA_DIR: path.join(fixture.directory, 'data') },
    });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout) as { policyFile: string; tokenFile: string; settings: Record<string, string> };
    const token = fs.readFileSync(output.tokenFile, 'utf8');
    expect(run.stdout).not.toContain(token);
    process.env.FLUJO_OWNER_AUTH_FILE = output.settings.FLUJO_OWNER_AUTH_FILE;
    expect(assertOwnerRequest(bearer(token, peopleUrl))).toBeNull();
    // A second run never overwrites existing authority.
    const again = spawnSync(process.execPath, ['scripts/owner-access.mjs', 'enable', directory], { encoding: 'utf8' });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('Existing authority was preserved');
    expect(fs.readFileSync(output.tokenFile, 'utf8')).toBe(token);
  });

  it('refuses a private directory inside the data folder', () => {
    expect(() => tool('enable', path.join(fixture.directory, 'data', 'inside'))).toThrow('outside the data directory');
    expect(() => tool('enable', 'relative-path')).toThrow('absolute path');
    expect(() => tool('restore', path.join(fixture.directory, 'owner.json'))).toThrow('no usable earlier policy');
  });
});

describe('browser login for a named person', () => {
  const sessionUrl = `${ORIGIN}/api/owner/session`;
  const signIn = (token: string) => login(bearer(token, sessionUrl, { method: 'POST', headers: { origin: ORIGIN } }));
  const asSession = (cookie: string, route: string, method = 'GET') => new Request(`${ORIGIN}${route}`, {
    method, headers: { host: 'localhost:4200', origin: ORIGIN, cookie },
  });

  it('gives a session exactly the role behind it, and ends when that person is revoked', async () => {
    const response = await signIn(fixture.tokens.viewer);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(assertOwnerRequest(asSession(cookie, '/api/flow'))).toBeNull();
    expect(assertOwnerRequest(asSession(cookie, '/api/flow', 'POST'))?.status).toBe(403);
    expect(assertOwnerRequest(asSession(cookie, '/api/owner/people'))?.status).toBe(403);
    expect(assertOwnerRequest(asSession(cookie, '/api/git', 'POST'))?.status).toBe(403);
    const me = await (await getMe(asSession(cookie, '/api/owner/me'))).json() as Record<string, unknown>;
    expect(me).toMatchObject({ mode: 'named', name: 'viewer', role: 'viewer', via: 'session' });
    expect(JSON.stringify(me)).not.toContain(fixture.tokens.viewer);

    const id = fixture.ids.viewer;
    await revokePerson(bearer(fixture.tokens.admin, `${peopleUrl}/${id}`, { method: 'DELETE' }), context(id));
    expect(assertOwnerRequest(asSession(cookie, '/api/flow'))?.status).toBe(401);
  });

  it('keeps someone signed in while other people are added or removed', async () => {
    const response = await signIn(fixture.tokens.operator);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    await create(fixture.tokens.admin, { name: 'Another', role: 'viewer', expiresAt: inFuture() });
    expect(assertOwnerRequest(asSession(cookie, '/api/runs/active'))).toBeNull();
  });

  it('refuses a role that has no browser login, and a cookie alone cannot sign in', async () => {
    expect((await signIn(fixture.tokens.health)).status).toBe(403);
    const operator = await signIn(fixture.tokens.operator);
    const cookie = operator.headers.get('set-cookie')!.split(';')[0];
    const response = await login(new Request(sessionUrl, { method: 'POST', headers: { host: 'localhost:4200', origin: ORIGIN, cookie } }));
    expect(response.status).toBe(401);
  });

  it('refuses a session from another origin', async () => {
    const operator = await signIn(fixture.tokens.operator);
    const cookie = operator.headers.get('set-cookie')!.split(';')[0];
    const forged = new Request(`${ORIGIN}/api/runs/active`, { headers: { host: 'localhost:4200', origin: 'https://evil.example', cookie } });
    expect(assertOwnerRequest(forged)?.status).toBe(401);
    expect((await logout(new Request(sessionUrl, { method: 'DELETE', headers: { host: 'localhost:4200', origin: 'https://evil.example', cookie } }))).status).toBe(403);
  });

  it('records sign-in, sign-out and a refused sign-in, with no secret in the record', async () => {
    const response = await signIn(fixture.tokens.operator);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    await logout(new Request(sessionUrl, { method: 'DELETE', headers: { host: 'localhost:4200', origin: ORIGIN, cookie } }));
    await signIn(`flo_v1_${'y'.repeat(43)}`);
    const { entries } = await readAccessEvents();
    expect(entries.map(entry => `${entry.action}:${entry.outcome}`)).toEqual(['login:denied', 'logout:ok', 'login:ok']);
    expect(entries[2].actor).toMatchObject({ name: 'operator' });
    const raw = fs.readFileSync(`${fixture.policyFile}.audit.jsonl`, 'utf8');
    expect(raw).not.toContain(fixture.tokens.operator);
    expect(raw).not.toContain(cookie.split('=')[1]);
  });
});

describe('the record of who did what', () => {
  it('stays bounded, keeps its newest entries, and skips a torn line', async () => {
    process.env.FLUJO_ACCESS_AUDIT_MAX_BYTES = '2048';
    const principal = resolveOwnerRequest(bearer(fixture.tokens.admin, peopleUrl));
    if (!principal.ok) throw new Error('denied');
    const actor = accessActorFromPrincipal(principal.authorization.principal)!;
    for (let index = 0; index < 400; index += 1) {
      recordAccessEvent({ action: 'flow.update', actor, target: `flow-${index}` });
    }
    await flushAccessEvents();
    const file = `${fixture.policyFile}.audit.jsonl`;
    expect(fs.statSync(file).size).toBeLessThanOrEqual(2048);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(2048);
    fs.appendFileSync(file, '{"at":1,"act');
    const { entries } = await readAccessEvents({ limit: 500 });
    expect(entries[0].target).toBe('flow-399');
    expect(entries.length).toBeLessThan(60);
  });

  it('never lets a value break a line or grow without limit', async () => {
    recordAccessEvent({ action: 'flow.update', target: `first\nsecond${'x'.repeat(5000)}` });
    await flushAccessEvents();
    const lines = fs.readFileSync(`${fixture.policyFile}.audit.jsonl`, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { target: string }).target.length).toBeLessThanOrEqual(203);
  });

  it('keeps working and says so when the record cannot be written', async () => {
    const { accessRecordWritable } = await import('@/backend/services/security/accessAudit');
    const file = `${fixture.policyFile}.audit.jsonl`;
    fs.mkdirSync(file); // A directory in the way makes every append fail.
    recordAccessEvent({ action: 'login' });
    await flushAccessEvents();
    expect(accessRecordWritable()).toBe(false);
    expect((await create(fixture.tokens.admin, { name: 'still-works', role: 'operator', expiresAt: inFuture() })).response.status).toBe(201);
    await flushAccessEvents();
    fs.rmdirSync(file);
    recordAccessEvent({ action: 'login' });
    await flushAccessEvents();
    expect(accessRecordWritable()).toBe(true);
  });

  it('shows someone bound to one workspace only that workspace', async () => {
    recordAccessEvent({ action: 'flow.update', target: 'a', workspace: 'site-a' });
    recordAccessEvent({ action: 'flow.update', target: 'b', workspace: 'site-b' });
    recordAccessEvent({ action: 'login' });
    fixture.add('site-reader', { scopes: ['audit:read'], workspaceId: 'site-a' });
    const read = await getAudit(bearer(fixture.tokens['site-reader'], `${ORIGIN}/api/owner/audit`));
    const { entries } = await read.json() as { entries: Array<{ target?: string }> };
    expect(entries.map(entry => entry.target)).toEqual(['a']);
    expect((await getAudit(bearer(fixture.tokens.admin, `${ORIGIN}/api/owner/audit?limit=abc`))).status).toBe(400);
    expect((await getAudit(bearer(fixture.tokens.admin, `${ORIGIN}/api/owner/audit?action=${encodeURIComponent('../x')}`))).status).toBe(400);
  });

  it('records person changes by field name, never by value', async () => {
    const { json } = await create(fixture.tokens.admin, { name: 'Private Name', role: 'operator', expiresAt: inFuture() });
    const id = json.person!.id;
    await patchPerson(bearer(fixture.tokens.admin, `${peopleUrl}/${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Other Private Name' }) }), context(id));
    const { entries } = await readAccessEvents();
    expect(entries[0]).toMatchObject({ action: 'person.update', detail: 'name', target: id });
    expect(entries[1]).toMatchObject({ action: 'person.create', detail: 'operator', target: id });
    expect(JSON.stringify(entries)).not.toContain('Private Name');
  });
});

it('createPerson keeps the secret out of the record it returns', () => {
  const principal = resolveOwnerRequest(bearer(fixture.tokens.admin, peopleUrl));
  if (!principal.ok) throw new Error('denied');
  const { person, token } = createPerson(accessActorFromPrincipal(principal.authorization.principal)!, {
    name: 'X', role: 'viewer', expiresAt: inFuture(),
  });
  expect(JSON.stringify(person)).not.toContain(token);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOwnerRequest, requiredOwnerScopes, assertOwnerRequest } from '@/backend/services/security/ownerAccess';
import { issueOwnerCredential, ownerPolicySchema, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';

let directory: string;
let filename: string;
let token: string;
let policy: OwnerPolicy;
let savedPolicyPath: string | undefined;
const issuedAt = 1_000;
const expiresAt = 10_000;

beforeEach(() => {
  savedPolicyPath = process.env.FLUJO_OWNER_AUTH_FILE;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-principal-'));
  filename = path.join(directory, 'owner.json');
  const issued = issueOwnerCredential(['avatar:voice'], expiresAt, issuedAt, { workspaceId: 'voice-workspace' });
  token = issued.token;
  policy = { schemaVersion: 1, ownerId: 'private-bff-owner', credentials: [issued.record] };
  persist();
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
});

afterEach(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), directory);
  if (!/^flujo-owner-principal-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe principal test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
  if (savedPolicyPath === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE;
  else process.env.FLUJO_OWNER_AUTH_FILE = savedPolicyPath;
});

function persist() {
  fs.writeFileSync(`${filename}.new`, JSON.stringify(policy), { mode: 0o600 });
  fs.renameSync(`${filename}.new`, filename);
}

function request(bearer: string | null = token, route = '/api/avatar/remote/native-turn', method = 'POST') {
  return new Request(`http://localhost:4200${route}`, { method, headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` } });
}

function authorize() {
  const result = resolveOwnerRequest(request(), ['avatar:voice'], { now: 2_000 });
  if (!result.ok) throw new Error(`Unexpected denial ${result.response.status}`);
  return result.authorization;
}

test('resolves frozen authenticated identity and explicit workspace before body or storage use', () => {
  const req = request(token, '/api/avatar/remote/native-turn?workspace=attacker&ownerId=attacker');
  req.headers.set('x-flujo-owner', 'attacker');
  req.headers.set('x-flujo-workspace', 'attacker');
  req.headers.set('cookie', 'owner=attacker');
  const readBody = jest.spyOn(req, 'json');
  const result = resolveOwnerRequest(req, ['avatar:voice'], { now: 2_000 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { principal } = result.authorization;
  expect(principal).toMatchObject({ ownerId: 'private-bff-owner', credentialId: policy.credentials[0].id,
    workspaceId: 'voice-workspace', scopes: ['avatar:voice'], expiresAt });
  expect(principal.policyRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(principal)).toBe(true);
  expect(Object.isFrozen(principal.scopes)).toBe(true);
  expect(Object.isFrozen(result.authorization)).toBe(true);
  expect(readBody).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(policy.credentials[0].digest);
  expect(result.authorization.recheck(2_000)).toBeNull();
});

test.each([undefined, '', 'missing.json'])('strict resolver denies unavailable policy (%s)', configured => {
  if (configured === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE;
  else process.env.FLUJO_OWNER_AUTH_FILE = configured;
  const result = resolveOwnerRequest(request(), ['avatar:voice'], { now: 2_000 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(503);
});

test('resolver does not inherit callback or anonymous-local admission exceptions', () => {
  const result = resolveOwnerRequest(request(null, '/api/oauth/callback', 'GET'), ['avatar:voice'], { now: 2_000 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(401);
});

test('voice authority requires an explicit workspace even when the caller requests otherwise', () => {
  delete policy.credentials[0].workspaceId;
  persist();
  const result = resolveOwnerRequest(request(), ['avatar:voice'], { now: 2_000, requireWorkspace: false });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(403);
});

test('voice-only scope cannot read secrets, control APIs, or execute OpenAI/MCP', () => {
  for (const scopes of [['secrets:read'], ['control:admin'], ['openai:execute'], ['mcp:access']] as const) {
    const result = resolveOwnerRequest(request(), scopes, { now: 2_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  }
});

test.each(['turn', 'input', 'observe', 'played', 'reset', 'result', 'result-receipt'])('classifies only POST remote native-%s as voice', action => {
  expect(requiredOwnerScopes(request(token, `/api/avatar/remote/native-${action}`))).toEqual(['avatar:voice']);
  expect(requiredOwnerScopes(request(token, `/api/avatar/remote/native-${action}`, 'GET'))).toEqual(['control:admin', 'secrets:read']);
});

test.each(['/api/avatar/native-turn', '/api/avatar/remote/native-turn-evil', '/api/avatar/remote/native-turn/extra', '/api/avatar/remote/config'])('retains conservative scopes for %s', route => {
  expect(requiredOwnerScopes(request(token, route))).toEqual(['control:admin', 'secrets:read']);
});

test.each([
  ['revocation', () => { policy.credentials[0].revokedAt = 2_001; }],
  ['workspace change', () => { policy.credentials[0].workspaceId = 'another-workspace'; }],
  ['owner change', () => { policy.ownerId = 'another-owner'; }],
  ['credential rotation with reused ID', () => { policy.credentials[0].digest = 'a'.repeat(64); }],
  ['removed credential', () => { policy.credentials = []; }],
])('rechecks durable %s without accepting copied principal claims', (_description, change) => {
  const witness = authorize();
  expect(witness.recheck(2_000)).toBeNull();
  change(); persist();
  expect(witness.recheck(2_002)?.status).toBe(401);
});

test('witness expires at the exact boundary and rejects invalid time', () => {
  const witness = authorize();
  expect(witness.recheck(expiresAt - 1)).toBeNull();
  expect(witness.recheck(expiresAt)?.status).toBe(401);
  expect(witness.recheck(issuedAt - 1)?.status).toBe(401);
  expect(witness.recheck(Number.NaN)?.status).toBe(401);
});

test('a new policy revision conservatively ends even an otherwise unchanged credential witness', () => {
  const witness = authorize();
  policy.credentials.push(issueOwnerCredential(['openai:read'], expiresAt, issuedAt).record);
  persist();
  expect(witness.recheck(2_000)?.status).toBe(401);
  expect(authorize().principal.policyRevision).not.toBe(witness.principal.policyRevision);
});

test('witness fails closed on policy deletion/corruption/configuration switch', async () => {
  const witness = authorize();
  fs.writeFileSync(filename, 'synthetic private malformed data');
  const denial = witness.recheck(2_000)!;
  expect(denial.status).toBe(503);
  expect(await denial.text()).not.toContain('private');
  persist();
  delete process.env.FLUJO_OWNER_AUTH_FILE;
  expect(witness.recheck(2_000)?.status).toBe(503);
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'another.json');
  expect(witness.recheck(2_000)?.status).toBe(503);
});

test('workspace grants reject traversal, reserved device names, and mixed control authority', () => {
  for (const workspaceId of ['../private', 'con', 'a/b', '']) {
    expect(ownerPolicySchema.safeParse({ ...policy, credentials: [{ ...policy.credentials[0], workspaceId }] }).success).toBe(false);
  }
  expect(ownerPolicySchema.safeParse({ ...policy, credentials: [{ ...policy.credentials[0], scopes: ['avatar:voice', 'secrets:read'] }] }).success).toBe(false);
});

test('legacy anonymous admission remains separate from strict principal resolution', () => {
  delete process.env.FLUJO_OWNER_AUTH_FILE;
  expect(assertOwnerRequest(request(null, '/api/storage', 'GET'))).toBeNull();
  expect(resolveOwnerRequest(request(null)).ok).toBe(false);
});

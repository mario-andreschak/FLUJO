import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { registerExecutionExtension, type ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { assertOwnerRequest, MAX_OWNER_POLICY_BYTES } from '@/backend/services/security/ownerAccess';
import {
  authenticateOwnerBearer, issueOwnerCredential, ownerPolicySchema, OWNER_SCOPES, type OwnerPolicy,
} from '@/backend/services/security/ownerCredentials';

describe('owner credentials at real proxy and handler admission', () => {
  let directory: string;
  let filename: string;
  let token: string;
  let policy: OwnerPolicy;
  const saved = Object.fromEntries([
    'FLUJO_OWNER_AUTH_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_EXPOSURE_MODE',
  ].map(key => [key, process.env[key]]));

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-policy-'));
    filename = path.join(directory, 'owner.json');
    const issued = issueOwnerCredential(['openai:read', 'openai:execute'], Date.now() + 60_000);
    token = issued.token;
    policy = { schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [issued.record] };
    persist();
    process.env.FLUJO_OWNER_AUTH_FILE = filename;
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    delete process.env.FLUJO_WORKER_MODE;
    delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  function persist() {
    const staged = `${filename}.new`;
    fs.writeFileSync(staged, JSON.stringify(policy), { mode: 0o600 });
    fs.renameSync(staged, filename);
  }
  function request(route = '/v1/models', bearer: string | null = token, extra: Record<string, string> = {}, method = 'GET') {
    return new NextRequest(`http://localhost:4200${route}`, { method, headers: {
      host: 'localhost:4200', ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...extra,
    } });
  }

  it('issues unique high-entropy credentials without persisting their plaintext', () => {
    const second = issueOwnerCredential(['openai:read'], Date.now() + 60_000);
    expect(token).toMatch(/^flo_v1_[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(token);
    expect(fs.readFileSync(filename, 'utf8')).not.toContain(token);
    expect(authenticateOwnerBearer(request(), policy)).toEqual({
      ownerId: 'synthetic-owner', credentialId: policy.credentials[0].id,
      scopes: ['openai:read', 'openai:execute'],
    });
  });
  it.each([null, '', 'not-a-token', `flo_v1_${'a'.repeat(43)}`])('denies a missing/invalid credential (%s)', async bearer => {
    const response = proxy(request('/v1/models', bearer));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
  it('denies expiration at the exact boundary and not-yet-valid grants', () => {
    const record = policy.credentials[0];
    expect(authenticateOwnerBearer(request(), policy, record.expiresAt - 1)).not.toBeNull();
    expect(authenticateOwnerBearer(request(), policy, record.expiresAt)).toBeNull();
    expect(authenticateOwnerBearer(request(), policy, record.issuedAt - 1)).toBeNull();
    record.issuedAt = Date.now() - 100;
    record.expiresAt = Date.now() - 1;
    persist();
    expect(proxy(request()).status).toBe(401);
  });
  it('observes revocation and reconnect credentials without a process-global cache', () => {
    expect(proxy(request()).status).toBe(200);
    policy.credentials[0].revokedAt = Date.now();
    persist();
    expect(proxy(request()).status).toBe(401);
    expect(assertOwnerRequest(request())?.status).toBe(401);
  });
  it('retains validity from durable policy in a fresh module runtime', () => {
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('@/backend/services/security/ownerAccess')>(
        '@/backend/services/security/ownerAccess',
      );
      expect(fresh.assertOwnerRequest(request())).toBeNull();
    });
  });
  it('authenticates and observes revocation/corruption across fresh OS processes', () => {
    function probe() {
      const result = spawnSync(process.execPath, [
        path.join(__dirname, 'fixtures', 'owner-access-child.cjs'),
        path.resolve('src/backend/services/security/ownerAccess.ts'),
        path.resolve('node_modules/typescript/lib/typescript.js'),
      ], {
        env: { NODE_ENV: 'test', SystemRoot: process.env.SystemRoot, FLUJO_OWNER_AUTH_FILE: filename },
        input: JSON.stringify({ token }), encoding: 'utf8', timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return result.stdout;
    }
    expect(probe()).toBe('200');
    policy.credentials[0].revokedAt = Date.now();
    persist();
    expect(probe()).toBe('401');
    fs.writeFileSync(filename, 'invalid metadata');
    expect(probe()).toBe('503');
  });
  it.each([
    '/api/env', '/api/git', '/api/storage', '/api/backup', '/api/upload',
    '/api/not-yet-implemented', '/v1/chat/conversations',
    '/v1/chat/conversations/id/respond', '/mcp-proxy/server', '/mcp-flows',
    '/v1/models-evil', '/v1/chat/completions-evil',
  ])('execution/read scopes cannot reach %s', route => {
    expect(proxy(request(route)).status).toBe(403);
  });
  it('permits OpenAI execution and treats explicit control/secret/MCP grants independently', () => {
    expect(proxy(request('/v1/chat/completions', token, {}, 'POST')).status).toBe(200);
    const admin = issueOwnerCredential(['control:admin'], Date.now() + 60_000);
    policy.credentials.push(admin.record);
    persist();
    expect(proxy(request('/api/env', admin.token)).status).toBe(403);
    const owner = issueOwnerCredential(OWNER_SCOPES, Date.now() + 60_000);
    policy.credentials.push(owner.record);
    persist();
    expect(proxy(request('/api/env', owner.token)).status).toBe(200);
    expect(proxy(request('/mcp-proxy/server', owner.token)).status).toBe(200);
    expect(proxy(request('/mcp-flows', owner.token)).status).toBe(200);
  });
  it('does not derive identity from URLs, cookies, or forwarding/owner headers', () => {
    expect(proxy(request(`/v1/models?token=${token}`, null, {
      cookie: `owner=${token}`, 'x-flujo-owner': 'synthetic-owner',
      'x-forwarded-host': 'localhost:4200', 'x-forwarded-for': '127.0.0.1',
    })).status).toBe(401);
  });
  it('retains Host/Origin defenses after owner authorization', () => {
    const owner = issueOwnerCredential(OWNER_SCOPES, Date.now() + 60_000);
    policy.credentials.push(owner.record);
    persist();
    expect(proxy(request('/api/env', owner.token, { origin: 'http://attacker.invalid' })).status).toBe(403);
    expect(proxy(request('/v1/models', token, { host: 'attacker.invalid' })).status).toBe(403);
  });
  it.each(['/api/oauth/callback', '/api/registry/oauth/callback'])('keeps only existing exact callback exceptions for %s', route => {
    expect(proxy(request(route, null)).status).toBe(200);
    expect(proxy(request(`${route}-evil`, null)).status).toBe(401);
    expect(proxy(request(route, null, {}, 'POST')).status).toBe(route === '/api/oauth/callback' ? 200 : 401);
    expect(proxy(request(route, null, {}, 'DELETE')).status).toBe(401);
  });
  it.each(['/api/oauth/initiate', '/api/oauth/reset'])('requires owner credentials on %s', route => {
    expect(proxy(request(route, null)).status).toBe(401);
  });
  it('preserves a POST webhook exception without opening reads or nested routes', () => {
    expect(proxy(request('/api/webhooks/id', null, {}, 'POST')).status).toBe(200);
    expect(proxy(request('/api/webhooks/id', null)).status).toBe(401);
    expect(proxy(request('/api/webhooks/id/extra', null, {}, 'POST')).status).toBe(401);
  });
  it('keeps snapshot bearer routes independent from the owner token', () => {
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-worker-bearer';
    const snapshot = request('/api/snapshot/begin', 'synthetic-worker-bearer', {}, 'POST');
    expect(proxy(snapshot).status).toBe(200);
    expect(assertSnapshotBearer(snapshot)).toBeNull();
    expect(assertSnapshotBearer(request('/api/snapshot/begin', token))?.status).toBe(401);
    expect(proxy(request('/api/snapshot/begin-evil', null)).status).toBe(401);
    expect(proxy(request('/api/snapshot/begin', null)).status).toBe(401);
  });
  it('keeps worker bearer authentication separate even when the owner policy is broken', () => {
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-worker-bearer';
    fs.writeFileSync(filename, 'not JSON');
    expect(proxy(request('/api/env', token)).status).toBe(401);
    expect(proxy(request('/api/env', 'synthetic-worker-bearer')).status).toBe(200);
  });
  it('preserves narrow trusted-adapter admission and repeats it at the handler', async () => {
    const handler = jest.fn(async (_request: Request) => Response.json({ accepted: true }));
    const withRoute = jest.fn(async () => Response.json({ extension: true }));
    const remove = registerExecutionExtension({
      authorizeTransport: (req: Request) => new URL(req.url).pathname === '/v1/chat/completions'
        ? (req.headers.get('authorization') === 'Bearer synthetic-adapter-bearer' ? null : new Response(null, { status: 401 }))
        : undefined,
      withRoute,
    } as unknown as ExecutionExtensionAdapter);
    try {
      const admitted = request('/v1/chat/completions', 'synthetic-adapter-bearer', {}, 'POST');
      expect(proxy(admitted).status).toBe(200);
      expect((await withWorkspaceRoute(handler)(admitted)).status).toBe(200);
      expect(withRoute).toHaveBeenCalledTimes(1);
      expect(proxy(request('/api/env', 'synthetic-adapter-bearer')).status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    } finally { remove(); }
  });
  it('denies direct handler invocation before data selection or a sensitive sink', async () => {
    const handler = jest.fn(async (_request: Request) => Response.json({ secret: 'should not be read' }));
    const wrapped = withWorkspaceRoute(handler);
    expect((await wrapped(request('/api/env', null))).status).toBe(401);
    expect((await wrapped(request('/api/env'))).status).toBe(403);
    policy.credentials[0].revokedAt = Date.now();
    persist();
    expect((await wrapped(request('/v1/models'))).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
  it('fails closed on malformed/unreadable/oversized policy without revealing it', async () => {
    for (const content of ['bad JSON including synthetic-private-data', ' '.repeat(MAX_OWNER_POLICY_BYTES + 1)]) {
      fs.writeFileSync(filename, content);
      const response = proxy(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic-private-data');
    }
    process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'absent.json');
    expect(proxy(request()).status).toBe(503);
    process.env.FLUJO_OWNER_AUTH_FILE = 'relative.json';
    expect(proxy(request()).status).toBe(503);
    process.env.FLUJO_OWNER_AUTH_FILE = '';
    expect(proxy(request()).status).toBe(503);
  });
  it('rejects unknown schema/scopes, duplicate identity and invalid timestamps', () => {
    for (const value of [
      { ...policy, schemaVersion: 2 },
      { ...policy, extra: 'unexpected' },
      { ...policy, credentials: [policy.credentials[0], policy.credentials[0]] },
      { ...policy, credentials: [{ ...policy.credentials[0], scopes: ['*'] }] },
      { ...policy, credentials: [{ ...policy.credentials[0], expiresAt: policy.credentials[0].issuedAt }] },
    ]) {
      expect(ownerPolicySchema.safeParse(value).success).toBe(false);
      fs.writeFileSync(filename, JSON.stringify(value));
      expect(proxy(request()).status).toBe(503);
    }
  });
  it('retains anonymous local compatibility only when owner auth is unconfigured', () => {
    delete process.env.FLUJO_OWNER_AUTH_FILE;
    expect(proxy(request('/api/storage', null)).status).toBe(200);
    expect(proxy(request('/api/storage', null, { origin: 'http://attacker.invalid' })).status).toBe(403);
  });
});

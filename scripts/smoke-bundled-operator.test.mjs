import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import test from 'node:test';
import { createServer } from 'node:http';
import { createSmokeOperator, createSmokeMetadataBff } from './smoke-bundled-operator.mjs';

test('the packed operator uses a genuine scoped credential with an absent cold ledger and independent cleanup', async () => {
  const operator = await createSmokeOperator();
  const ownerFile = operator.env.FLUJO_OWNER_AUTH_FILE;
  try {
    const bytes = await fs.readFile(ownerFile, 'utf8');
    const policy = JSON.parse(bytes);
    assert.equal(policy.credentials.length, 1);
    assert.deepEqual(policy.credentials[0].scopes, ['control:admin', 'mcp:access', 'secrets:read']);
    assert.equal(policy.credentials[0].digest, createHash('sha256').update(operator.token).digest('hex'));
    assert.equal(policy.credentials[0].workspaceId, undefined);
    assert.ok(!bytes.includes(operator.token));
    assert.ok(!JSON.stringify(operator.env).includes(operator.token));
    await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
    const stat = await fs.stat(ownerFile);
    assert.equal(stat.nlink, 1);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  } finally { await operator.restore(); }
  await assert.rejects(fs.access(ownerFile), { code: 'ENOENT' });
});

test('the disposable metadata bridge retains owner authority and refuses writes or other workspaces', async () => {
  const received = [];
  const upstream = createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization, workspace: request.headers['x-flujo-workspace'] });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ resources: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let bridge;
  try {
    bridge = await createSmokeMetadataBff(`http://127.0.0.1:${upstream.address().port}`, 'synthetic-test-only-owner');
    assert.ok(!bridge.url.includes('synthetic-test-only-owner'));
    const result = await fetch(bridge.url + '/api/mcp/flujo/resources?cursor=next', { headers: { 'x-flujo-workspace': 'foreign' } });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { resources: [] });
    assert.deepEqual(received, [{ url: '/api/mcp/flujo/resources?cursor=next', authorization: 'Bearer synthetic-test-only-owner', workspace: 'default-workspace' }]);
    for (const [route, method] of [['/api/mcp/flujo/flows', 'POST'], ['/api/mcp/flujo/resources', 'POST'], ['/api/mcp/flujo/tools?workspace=foreign', 'GET']]) {
      assert.equal((await fetch(bridge.url + route, { method })).status, 404);
    }
    assert.equal(received.length, 1);
    await assert.rejects(createSmokeMetadataBff('https://example.com', 'synthetic-test-only-owner'));
  } finally {
    await bridge?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

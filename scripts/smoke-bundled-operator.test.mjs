import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import test from 'node:test';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

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

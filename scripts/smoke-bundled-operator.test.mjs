import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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


test('the source-absent packaged consumer uses the built production issuer and rejects altered compiled bytes', async () => {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  await promisify(execFile)(process.execPath, [path.join(scripts, 'build-smoke-owner-issuer.mjs')]);
  const root = await fs.mkdtemp(path.join(scripts, '.owner-issuer-consumer-'));
  const equipment = path.join(root, 'scripts');
  try {
    await fs.mkdir(equipment);
    for (const name of ['smoke-bundled-operator.mjs', 'generated-smoke-owner-issuer.cjs', 'generated-smoke-owner-issuer.json']) {
      await fs.copyFile(path.join(scripts, name), path.join(equipment, name));
    }
    await assert.rejects(fs.access(path.join(root, 'src/backend/services/security/ownerCredentials.ts')), { code: 'ENOENT' });
    const { createSmokeOperator: createCompiledOperator } = await import(new URL(`./${path.basename(root)}/scripts/smoke-bundled-operator.mjs`, import.meta.url));
    const operator = await createCompiledOperator();
    try {
      assert.equal(operator.issuerEquipment, 'compiled-production-source');
      const actualSource = await fs.readFile(path.join(scripts, '../src/backend/services/security/ownerCredentials.ts'));
      assert.equal(operator.issuerSourceSha256, createHash('sha256').update(actualSource).digest('hex'));
      const policy = JSON.parse(await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE, 'utf8'));
      assert.deepEqual(policy.credentials[0].scopes, ['control:admin', 'mcp:access', 'secrets:read']);
      assert.equal(policy.credentials[0].digest, createHash('sha256').update(operator.token).digest('hex'));
      await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
    } finally { await operator.restore(); }
    await fs.appendFile(path.join(equipment, 'generated-smoke-owner-issuer.cjs'), '\n// altered bytes\n');
    await assert.rejects(createCompiledOperator(), /Compiled owner issuer binding mismatch/);
  } finally {
    if (path.dirname(root) !== scripts || !path.basename(root).startsWith('.owner-issuer-consumer-')) throw new Error('Unsafe compiled consumer cleanup.');
    await fs.rm(root, { recursive: true });
  }
});

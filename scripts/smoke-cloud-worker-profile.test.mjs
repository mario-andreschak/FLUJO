import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createPrivateSmokeProfile } from './smoke-cloud-worker-profile.mjs';

// Validate fixture bytes with the actual production parser and decryptor.
const production = {};
const source = readFileSync(new URL('../src/utils/encryption/format.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'exports', compiled)(createRequire(import.meta.url), production);

test('offline smoke carries a private metadata-bound key and authenticated model credential', async () => {
  const passphrase = 'independent-synthetic-private-smoke-passphrase';
  const profile = await createPrivateSmokeProfile(passphrase);
  const ring = production.parseSessionKey(profile.bootstrap.workspaceDek);
  assert.equal(profile.metadata.encryption_type, 'user');
  assert.equal(profile.metadata.key_protection, 'passphrase');
  assert.equal(profile.metadata.kdf_iterations, production.KDF_ITERATIONS);
  assert.equal(production.keyId(ring), profile.metadata.key_id);
  assert.equal(ring.metadataRevision, production.metadataRevision(profile.metadata));
  assert.deepEqual(await production.unwrapKeyring(profile.metadata, passphrase), { version: 2, activeKey: ring.activeKey });
  assert.equal(production.open(profile.encryptedApiKey, ring.activeKey, 'flujo:secret:v2'), 'synthetic-smoke-key');
  assert.throws(() => production.open(profile.encryptedApiKey, ring.activeKey, 'wrong-purpose'));
  assert.throws(() => production.open(profile.encryptedApiKey, '00'.repeat(32), 'flujo:secret:v2'));
  await assert.rejects(production.unwrapKeyring(profile.metadata, production.DEFAULT_PASSWORD));
});

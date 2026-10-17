import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { retainOAuthAcceptance } from './mcp-oauth-credentials.mjs';
import { readPrivateJson, writePrivateJson } from './local-instance.mjs';

const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(application, 'src/utils/encryption/format.ts');
const require = createRequire(import.meta.url), ts = require('typescript');
const loaded = new Module(filename); loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText, filename);
const format = loaded.exports;

test('retains the complete encrypted grant with the existing recovery key and refuses unsafe replacements', async () => {
  const parent = await fs.realpath(process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'flujo-oauth-retention-test-'));
  try {
    const privateDatabase = path.join(directory, 'private-db'), destination = path.join(directory, 'retained/slack.json');
    const password = randomBytes(32).toString('hex'), privateRing = format.newKeyring(), originalRing = format.newKeyring();
    const metadata = await format.wrapKeyring(privateRing, 'user', password, 'passphrase');
    await writePrivateJson(path.join(privateDatabase, 'encryption_key.json'), metadata);
    const metadataBefore = await fs.readFile(path.join(privateDatabase, 'encryption_key.json'));
    const value = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer',
      issuer: 'https://mcp.slack.com', issued_at: 123, extension: { opaque: 'synthetic-extension' } };
    const envelope = { format: 'flujo-oauth-v1', kind: 'tokens', workspace: 'default-workspace', value };
    const seal = entry => ({ format: 'flujo-oauth-v1', ciphertext: format.seal(JSON.stringify(entry), privateRing.activeKey, 'flujo:secret:v2') });
    const input = { format, originalRing, originalMetadataPath: 'existing/encryption_key.json', privateDatabase,
      password, tokens: seal(envelope), issuer: value.issuer, destination };
    assert.deepEqual(await retainOAuthAcceptance(input), { credentialPreserved: true, tokenIssuerVerified: true });
    const stored = await readPrivateJson(destination);
    assert.deepEqual(JSON.parse(format.open(stored.oauthTokens.ciphertext, originalRing.activeKey, 'flujo:secret:v2')), envelope);
    const serialized = await fs.readFile(destination, 'utf8');
    for (const secret of [value.access_token, value.refresh_token, value.extension.opaque, password]) assert.ok(!serialized.includes(secret));
    assert.deepEqual(await fs.readFile(path.join(privateDatabase, 'encryption_key.json')), metadataBefore);
    await assert.rejects(retainOAuthAcceptance(input), error => error.code === 'EEXIST');
    assert.equal(await fs.readFile(destination, 'utf8'), serialized);
    for (const [label, altered] of [
      ['workspace', { ...envelope, workspace: 'other-workspace' }],
      ['issuer', { ...envelope, value: { ...value, issuer: value.issuer + '/' } }],
      ['purpose', { ...envelope, kind: 'client' }],
    ]) {
      const refused = path.join(directory, `refused-${label}/slack.json`);
      await assert.rejects(retainOAuthAcceptance({ ...input, tokens: seal(altered), destination: refused }));
      await assert.rejects(fs.access(refused), error => error.code === 'ENOENT');
    }
  } finally {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^flujo-oauth-retention-test-[A-Za-z0-9]+$/);
    assert.equal(await fs.realpath(directory), directory);
    await fs.rm(directory, { recursive: true });
  }
});

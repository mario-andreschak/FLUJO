import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writePrivateJson } from './local-instance.mjs';

// Preserve a genuine grant independently of disposable acceptance authority.
// The existing workspace key remains its recovery key; shared config is untouched.
export async function retainOAuthAcceptance({ format, originalRing, originalMetadataPath,
  privateDatabase, password, tokens, issuer, destination }) {
  const metadata = JSON.parse(await fs.readFile(path.join(privateDatabase, 'encryption_key.json'), 'utf8'));
  const privateRing = await format.unwrapKeyring(metadata, password);
  assert.equal(tokens.format, 'flujo-oauth-v1');
  const decoded = JSON.parse(format.open(tokens.ciphertext, privateRing.activeKey, 'flujo:secret:v2'));
  assert.equal(decoded.format, 'flujo-oauth-v1');
  assert.equal(decoded.kind, 'tokens'); assert.equal(decoded.workspace, 'default-workspace');
  assert.equal(decoded.value.issuer, issuer);
  assert.equal(typeof decoded.value.access_token, 'string');
  assert.equal(typeof decoded.value.token_type, 'string');
  await writePrivateJson(destination, { format: 'flujo-oauth-acceptance', schemaVersion: 1,
    workspace: 'default-workspace', serverName: 'mcp-slack-com', sourceMetadataPath: originalMetadataPath, oauthIssuer: issuer,
    oauthTokens: { format: 'flujo-oauth-v1', ciphertext: format.seal(JSON.stringify(decoded), originalRing.activeKey, 'flujo:secret:v2') } },
  { exclusive: true });
  return { credentialPreserved: true, tokenIssuerVerified: true };
}

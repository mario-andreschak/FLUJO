import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { admitFeatureBrowserArtifact } from './artifact-admission.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = { head: '52e2c862d5ffec37d10c559e1815fdb743c0bd46', tree: 'c189aa95dfe00b1798a3fc7347c1112062c60812' };
const actualNodePin = fs.readFile(process.execPath).then(bytes => ({ file: process.execPath,
  bytes: bytes.length, sha256: sha(bytes), version: process.version }));
async function metadataFixture(t) {
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-artifact-admission-test-'));
  const ownedReal = await fs.realpath(owned);
  t.after(async () => {
    const target = await fs.realpath(owned);
    assert.equal(target, ownedReal);
    assert.ok(path.basename(target).startsWith('flujo-artifact-admission-test-'));
    assert.equal((await fs.lstat(owned)).isSymbolicLink(), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  const root = path.join(owned, 'runtime');
  const applicationRoot = path.join(root, 'node_modules/flujo-ai');
  const files = [
    ['node_modules/flujo-ai/package.json', JSON.stringify({ name: 'flujo-ai', version: '3.46.3' })],
    ['node_modules/flujo-ai/.next/BUILD_ID', 'metadata-only-test-build'],
    ['node_modules/flujo-ai/.next/server/app-paths-manifest.json', '{}'],
    ['node_modules/next/package.json', JSON.stringify({ name: 'next', version: '16.3.8' })],
    ['node_modules/next/dist/server/lib/start-server.js', '// Synthetic metadata fixture; never import or execute.'],
  ];
  for (const [file, content] of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  }
  const browser = path.join(owned, 'synthetic-browser-bytes');
  const browserBytes = Buffer.from('Metadata bytes only; no browser is executed.');
  await fs.writeFile(browser, browserBytes);
  const receipt = { schemaVersion: 1, state: 'ROOT_BOUND_PRODUCTION_BROWSER_CANDIDATE', source,
    buildProvenanceAcceptedByRoot: true, completeRecordedRuntimeInventory: true,
    origin: 'owned-exact-source-package', runtimeRoot: root, applicationRoot,
    buildId: 'metadata-only-test-build', runtimeFiles: files.map(([file, content]) => ({ path: file,
      bytes: Buffer.byteLength(content), sha256: sha(content) })), node: await actualNodePin,
    chromium: { file: browser, bytes: browserBytes.length, sha256: sha(browserBytes), revision: '1243' } };
  const receiptFile = path.join(owned, 'receipt.json');
  const seal = async () => {
    const bytes = JSON.stringify(receipt); await fs.writeFile(receiptFile, bytes);
    return { receiptFile, receiptSha256: sha(bytes), chromiumExecutable: browser };
  };
  return { root, applicationRoot, receipt, seal };
}

test('recorded matching byte identities remain a local binding rather than independent attestation', async t => {
  const fixture = await metadataFixture(t);
  const result = await admitFeatureBrowserArtifact(fixture.applicationRoot, await fixture.seal());
  assert.equal(result.runtimeFileCount, 5);
  assert.deepEqual(result.source, source);
  assert.match(result.scope, /no independent source, installed-launcher, provider or human attestation/);
});
test('a wrong receipt digest is refused before any candidate is admitted', async t => {
  const fixture = await metadataFixture(t);
  const options = await fixture.seal();
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, { ...options, receiptSha256: '0'.repeat(64) }), /receipt digest mismatch/);
});
test('a different Source head cannot use the exact producer Source admission', async t => {
  const fixture = await metadataFixture(t);
  fixture.receipt.source = { ...source, head: 'f'.repeat(40) };
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, await fixture.seal()), /exact producer Source/);
});
test('runtime bytes changed after sealing are refused', async t => {
  const fixture = await metadataFixture(t); const options = await fixture.seal();
  await fs.writeFile(path.join(fixture.applicationRoot, '.next/BUILD_ID'), 'different-runtime-build');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /runtime file byte\/digest mismatch/);
});
test('an inventory traversal is refused before reading the referenced path', async t => {
  const fixture = await metadataFixture(t);
  fixture.receipt.runtimeFiles[0] = { ...fixture.receipt.runtimeFiles[0], path: '../outside' };
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, await fixture.seal()), /unsafe, duplicate or malformed/);
});
test('an added runtime file cannot hide outside the sealed inventory', async t => {
  const fixture = await metadataFixture(t); const options = await fixture.seal();
  await fs.writeFile(path.join(fixture.root, 'node_modules/unrecorded.js'), '// Unrecorded synthetic bytes');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /unrecorded entry/);
});
test('candidate dotenv presence is refused without importing a candidate module', async t => {
  const fixture = await metadataFixture(t);
  await fs.writeFile(path.join(fixture.applicationRoot, '.env.local'), 'SYNTHETIC_ONLY=1');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, await fixture.seal()), /contains a dotenv file/);
});

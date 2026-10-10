import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { admitFeatureBrowserArtifact } from './artifact-admission.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = { head: 'ea592d62075bafbb70ddbe1eb76479f1572aff81', tree: 'eca03ce7627ba31f155a37da89deaf3a99ad2835' };
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
test('all runtime rows are validated before any runtime file is opened', async t => {
  const fixture = await metadataFixture(t);
  fixture.receipt.runtimeFiles.push({ path: '../outside', bytes: 1, sha256: '0'.repeat(64) });
  const options = await fixture.seal();
  const open = fs.open.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file).startsWith(fixture.root + path.sep)) reads++;
    return open(file, ...args);
  });
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /unsafe, duplicate or malformed/);
  assert.equal(reads, 0);
});

test('runtime failure stops new work and joins every bounded reader before rejecting', async t => {
  const fixture = await metadataFixture(t);
  for (let i = 0; i < 12; i++) {
    const relative = `node_modules/extra-${i}.js`;
    await fs.writeFile(path.join(fixture.root, relative), 'trusted');
    fixture.receipt.runtimeFiles.push({ path: relative, bytes: 7, sha256: sha('trusted') });
  }
  fixture.receipt.runtimeFiles[0].sha256 = '0'.repeat(64);
  const options = await fixture.seal();
  const open = fs.open.bind(fs);
  let live = 0;
  let opened = 0;
  let peak = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!String(file).startsWith(fixture.root + path.sep)) return handle;
    opened++; live++; peak = Math.max(peak, live);
    const close = handle.close.bind(handle);
    handle.close = async () => { try { await close(); } finally { live--; } };
    if (String(file) !== path.join(fixture.applicationRoot, 'package.json')) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return read(...readArgs);
      };
    }
    return handle;
  });
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /runtime file byte\/digest mismatch/);
  assert.ok(peak <= 8);
  assert.ok(opened <= 8);
  assert.equal(live, 0);
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

async function externalMetadataFixture(t) {
  const fixture = await metadataFixture(t);
  const inventoryFile = path.join(path.dirname(fixture.root), 'runtime-inventory.json');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runtimeRoot: fixture.root,
    runtimeFiles: fixture.receipt.runtimeFiles }));
  await fs.writeFile(inventoryFile, bytes);
  delete fixture.receipt.runtimeFiles;
  fixture.receipt.runtimeInventory = { file: inventoryFile, bytes: bytes.length, sha256: sha(bytes) };
  return fixture;
}

test('a wrong external runtime inventory digest is refused before any candidate is admitted', async t => {
  const fixture = await externalMetadataFixture(t);
  fixture.receipt.runtimeInventory.sha256 = '0'.repeat(64);
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, await fixture.seal()),
    /external runtime inventory byte\/digest mismatch/);
});

test('an added runtime file cannot hide outside a pinned external inventory', async t => {
  const fixture = await externalMetadataFixture(t); const options = await fixture.seal();
  const result = await admitFeatureBrowserArtifact(fixture.applicationRoot, options);
  assert.equal(result.runtimeFileCount, 5);
  assert.deepEqual(result.runtimeInventory, fixture.receipt.runtimeInventory);
  await fs.writeFile(path.join(fixture.root, 'node_modules/unrecorded.js'), '// Unrecorded synthetic bytes');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /unrecorded entry/);
});

async function addDocumentedRouteCache(fixture) {
  const root = path.join(fixture.applicationRoot, '.next/server/route-cache');
  const namespace = path.join(root, 'APP_PAGE', sha('/mcp/page'), '$');
  await fs.mkdir(namespace, { recursive: true });
  await fs.writeFile(path.join(namespace, 'mcp.html'), 'Disposable Next route-cache response');
  await fs.writeFile(path.join(namespace, 'mcp.rsc'), 'Disposable Next route-cache payload');
  return root;
}

test('documented Next route-cache writes remain mutable while every recorded runtime file is verified', async t => {
  const fixture = await externalMetadataFixture(t);
  const options = await fixture.seal();
  await addDocumentedRouteCache(fixture);
  const result = await admitFeatureBrowserArtifact(fixture.applicationRoot, options);
  assert.equal(result.runtimeFileCount, 5);
  assert.deepEqual(result.runtimeInventory, fixture.receipt.runtimeInventory);
});

test('a similarly named sibling cannot hide beside the documented Next route cache', async t => {
  const fixture = await externalMetadataFixture(t);
  const options = await fixture.seal();
  await addDocumentedRouteCache(fixture);
  const sibling = path.join(fixture.applicationRoot, '.next/server/route-cache-extra');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'unrecorded.rsc'), 'Unrecorded sibling bytes');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /unrecorded entry/);
});

test('documented route-cache writes cannot conceal changed immutable server artifacts', async t => {
  const fixture = await externalMetadataFixture(t);
  const options = await fixture.seal();
  await addDocumentedRouteCache(fixture);
  await fs.writeFile(path.join(fixture.applicationRoot, '.next/server/app-paths-manifest.json'), '{"changed":true}');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /runtime file byte\/digest mismatch/);
});

test('a documented route-cache root cannot be a link or junction outside the candidate runtime', async t => {
  const fixture = await externalMetadataFixture(t);
  const options = await fixture.seal();
  const outside = path.join(path.dirname(fixture.root), 'outside-route-cache');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'unrecorded.rsc'), 'Outside synthetic bytes');
  await fs.symlink(outside, path.join(fixture.applicationRoot, '.next/server/route-cache'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(admitFeatureBrowserArtifact(fixture.applicationRoot, options), /unadmitted link/);
});

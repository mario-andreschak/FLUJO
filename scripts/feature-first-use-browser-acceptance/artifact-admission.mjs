import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readPinnedFile } from '../pinned-file-read.mjs';

const expectedSource = {
  head: 'ea592d62075bafbb70ddbe1eb76479f1572aff81',
  tree: 'eca03ce7627ba31f155a37da89deaf3a99ad2835',
};
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`First-use artifact admission: ${message}`); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const contains = (root, file) => file.startsWith(root + path.sep);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Verify recorded bytes only; the receiver does not manufacture build provenance. */
export async function admitFeatureBrowserArtifact(applicationRoot, {
  receiptFile = process.env.FEATURE_BROWSER_ARTIFACT_RECEIPT,
  receiptSha256 = process.env.FEATURE_BROWSER_ARTIFACT_RECEIPT_SHA256,
  chromiumExecutable = process.env.FEATURE_BROWSER_CHROMIUM_EXECUTABLE,
} = {}) {
  if (!applicationRoot || !path.isAbsolute(applicationRoot) || !receiptFile || !path.isAbsolute(receiptFile)
    || !hashValue(receiptSha256)) fail('absolute application/receipt paths and exact receipt SHA-256 are required');
  const bytes = await readPinnedFile(receiptFile, { maxBytes: 8 * 1024 * 1024 });
  if (bytes.length < 1) fail('receipt byte budget exceeded');
  if (digest(bytes) !== receiptSha256) fail('receipt digest mismatch');
  const receipt = JSON.parse(bytes);
  if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.state !== 'ROOT_BOUND_PRODUCTION_BROWSER_CANDIDATE'
    || receipt.source?.head !== expectedSource.head || receipt.source?.tree !== expectedSource.tree
    || receipt.buildProvenanceAcceptedByRoot !== true || receipt.completeRecordedRuntimeInventory !== true) {
    fail('exact producer Source and reviewed actual build/inventory binding are required');
  }
  if (!['original-current-hosted-production-package', 'owned-exact-source-package'].includes(receipt.origin)) {
    fail('unsupported candidate origin');
  }
  const deadline = performance.now() + 90000;
  const checkDeadline = () => { if (performance.now() > deadline) fail('metadata verification deadline exceeded'); };
  if (!path.isAbsolute(receipt.runtimeRoot ?? '')) fail('invalid runtime root/inventory');
  const root = await fs.realpath(receipt.runtimeRoot);
  const inline = Object.hasOwn(receipt, 'runtimeFiles');
  const external = Object.hasOwn(receipt, 'runtimeInventory');
  if (inline === external) fail('exactly one inline or external runtime inventory is required');
  let runtimeFiles = receipt.runtimeFiles;
  if (external) {
    const reference = receipt.runtimeInventory;
    if (!record(reference) || !path.isAbsolute(reference.file ?? '') || !hashValue(reference.sha256)
      || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 32 * 1024 * 1024) {
      fail('invalid external runtime inventory pin');
    }
    checkDeadline();
    let inventory;
    try {
      const inventoryBytes = await readPinnedFile(reference.file, { maxBytes: 32 * 1024 * 1024,
        expectedBytes: reference.bytes, expectedSha256: reference.sha256, check: checkDeadline });
      inventory = JSON.parse(inventoryBytes.toString('utf8'));
      checkDeadline();
    } catch {
      fail('external runtime inventory byte/digest mismatch');
    }
    if (!record(inventory) || inventory.schemaVersion !== 1 || !path.isAbsolute(inventory.runtimeRoot ?? '')
      || !samePath(await fs.realpath(inventory.runtimeRoot), root)) fail('external runtime inventory shape/root mismatch');
    runtimeFiles = inventory.runtimeFiles;
  }
  checkDeadline();
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length < 5 || runtimeFiles.length > 200000) {
    fail('invalid runtime root/inventory');
  }
  const app = await fs.realpath(applicationRoot);
  if (!samePath(app, await fs.realpath(receipt.applicationRoot)) || !contains(root, app)) fail('application root mismatch');
  for (const dotenv of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { await fs.lstat(path.join(app, dotenv)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fail('candidate application contains a dotenv file');
  }
  const appRelative = path.relative(root, app).split(path.sep).join('/');
  // Next 16.3.8 promotes immutable build seeds into this runtime cache.
  // Keep the compiled server/app and server/pages artifacts in the inventory.
  const routeCache = `${appRelative}/.next/server/route-cache`;
  const ignored = file => file === `${appRelative}/.next/trace`
    || file === `${appRelative}/.next/cache` || file.startsWith(`${appRelative}/.next/cache/`)
    || file === routeCache || file.startsWith(`${routeCache}/`);
  const seen = new Set();
  const verifiedMetadata = new Map();
  const metadataPaths = new Set([`${appRelative}/package.json`, `${appRelative}/.next/BUILD_ID`,
    'node_modules/next/package.json']);
  let totalBytes = 0;
  for (const entry of runtimeFiles) {
    if (!record(entry) || typeof entry.path !== 'string' || entry.path.length > 2048 || entry.path.includes('\\')
      || entry.path.includes('\0') || entry.path.includes(':') || path.isAbsolute(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || ignored(entry.path)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 512 * 1024 * 1024
      || !hashValue(entry.sha256) || seen.has(entry.path)) {
      fail('unsafe, duplicate or malformed runtime inventory entry');
    }
    seen.add(entry.path);
    checkDeadline();
    const file = path.resolve(root, entry.path);
    if (!contains(root, file)) fail('runtime entry escapes candidate root');
    try {
      const bytes = await readPinnedFile(file, { maxBytes: 512 * 1024 * 1024,
        expectedBytes: entry.bytes, expectedSha256: entry.sha256, root, check: checkDeadline,
        collect: metadataPaths.has(entry.path) });
      if (metadataPaths.has(entry.path)) verifiedMetadata.set(entry.path, bytes);
    } catch {
      fail('runtime file byte/digest mismatch');
    }
    totalBytes += entry.bytes;
    if (totalBytes > 8 * 1024 * 1024 * 1024) fail('runtime inventory byte budget exceeded');
  }
  const pending = [''];
  let actualCount = 0;
  while (pending.length) {
    const relative = pending.pop();
    checkDeadline();
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('runtime tree contains an unadmitted link');
      if (ignored(child)) continue;
      if (entry.isDirectory()) pending.push(child);
      else if (!entry.isFile() || !seen.has(child)) fail('runtime tree contains an unrecorded entry');
      else if (++actualCount > 200000) fail('runtime enumeration entry budget exceeded');
    }
  }
  if (actualCount !== seen.size) fail('complete runtime inventory mismatch');
  const required = [
    `${appRelative}/package.json`, `${appRelative}/.next/BUILD_ID`,
    `${appRelative}/.next/server/app-paths-manifest.json`,
    'node_modules/next/package.json', 'node_modules/next/dist/server/lib/start-server.js',
  ];
  if (required.some(file => !seen.has(file))) fail('required production/Next runtime entry is absent from inventory');
  const pkg = JSON.parse(verifiedMetadata.get(`${appRelative}/package.json`).toString('utf8'));
  const next = JSON.parse(verifiedMetadata.get('node_modules/next/package.json').toString('utf8'));
  const buildId = verifiedMetadata.get(`${appRelative}/.next/BUILD_ID`).toString('utf8').trim();
  if (pkg.name !== 'flujo-ai' || pkg.version !== '3.46.3' || next.version !== '16.3.8'
    || !buildId || buildId !== receipt.buildId) fail('package, Next version or build identity mismatch');
  const runtime = receipt.node;
  if (!record(runtime) || !path.isAbsolute(runtime.file ?? '') || !hashValue(runtime.sha256)
    || !Number.isSafeInteger(runtime.bytes) || runtime.bytes < 1 || runtime.bytes > 512 * 1024 * 1024 || runtime.version !== process.version
    || !samePath(await fs.realpath(runtime.file), await fs.realpath(process.execPath))) fail('actual Node executable mismatch');
  await readPinnedFile(runtime.file, { maxBytes: 512 * 1024 * 1024,
    expectedBytes: runtime.bytes, expectedSha256: runtime.sha256, collect: false, check: checkDeadline });
  const browser = receipt.chromium;
  if (!record(browser) || browser.revision !== '1243' || !path.isAbsolute(browser.file ?? '') || !hashValue(browser.sha256)
    || !Number.isSafeInteger(browser.bytes) || browser.bytes < 1 || browser.bytes > 512 * 1024 * 1024 || !chromiumExecutable
    || !samePath(await fs.realpath(browser.file), await fs.realpath(chromiumExecutable))) fail('Chromium executable mismatch');
  await readPinnedFile(browser.file, { maxBytes: 512 * 1024 * 1024,
    expectedBytes: browser.bytes, expectedSha256: browser.sha256, collect: false, check: checkDeadline });
  checkDeadline();
  return { receiptFile, receiptSha256, applicationRoot: app, runtimeRoot: root, buildId,
    source: expectedSource, runtimeFileCount: seen.size, runtimeBytes: totalBytes,
    node: { ...runtime }, chromium: { ...browser },
    ...(external ? { runtimeInventory: { ...receipt.runtimeInventory } } : {}),
    scope: 'byte identity against a Root-reviewed build record; no independent source, installed-launcher, provider or human attestation' };
}

import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { createCipheriv, createHash, createDecipheriv } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKER_SNAPSHOT_ENVELOPE_READ_VERSIONS_LABEL, WORKER_SNAPSHOT_RESTORE_LIMITS_LABEL } from './snapshot-image-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
const contract = {
  snapshotEnvelopeReadVersions: WORKER_SNAPSHOT_ENVELOPE_READ_VERSIONS_LABEL.split(',').map(Number),
  snapshotDefaultLimits: JSON.parse(WORKER_SNAPSHOT_RESTORE_LIMITS_LABEL),
};
const limitKeys = ['maxFileBytes', 'maxUncompressedBytes', 'maxManifestBytes', 'maxArchiveBytes', 'maxEncryptedBytes', 'maxMembers'];
assert.deepEqual(Object.keys(contract.snapshotDefaultLimits), limitKeys);
assert.ok(limitKeys.every((key) => Number.isSafeInteger(contract.snapshotDefaultLimits[key]) && contract.snapshotDefaultLimits[key] > 0));
assert.deepEqual(contract.snapshotEnvelopeReadVersions, [1, 2]);
export const WORKER_IMAGE_LABELS = Object.freeze({
  'io.flujo.worker.snapshot-envelope-read-versions': WORKER_SNAPSHOT_ENVELOPE_READ_VERSIONS_LABEL,
  'io.flujo.worker.snapshot-default-limits': WORKER_SNAPSHOT_RESTORE_LIMITS_LABEL,
});
const defaultsEnvironment = (env, revision) => {
  const value = { ...env, FLUJO_BUILD_REVISION: revision };
  delete value.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
  delete value.FLUJO_SNAPSHOT_MAX_BYTES;
  return value;
};

/** Execute only the selected source capability/codec modules in an isolated defaults process. */
export function readWorkerImageSource(revision, sourceRoot = root) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Worker image source requires a full build revision.');
  const result = spawnSync(process.execPath, [self, 'probe-source', revision, sourceRoot], {
    env: defaultsEnvironment(process.env, revision), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Worker image source capability/codec verification failed.');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.labels, WORKER_IMAGE_LABELS);
  assert.equal(report.revision, revision);
  assert.equal(report.workerSnapshotSourceVersion, 1);
  return report;
}

export function checkWorkerImageBuild(revision, sourceRoot = root) {
  // Local builds without a revision cannot qualify an immutable worker image.
  if (!revision) return { sourceVerified: false };
  return { sourceVerified: true, ...readWorkerImageSource(revision, sourceRoot) };
}

export function generateWorkerImageCapability(revision, sourceRoot = root) {
  const report = readWorkerImageSource(revision, sourceRoot);
  const bytes = readFileSync(path.join(sourceRoot, 'Dockerfile'));
  const runtime = bytes.toString('utf8').slice(bytes.toString('utf8').indexOf('AS runtime'));
  assert.equal(runtime.match(/io\.flujo\.worker\.snapshot-envelope-read-versions="([^"]+)"/)[1], report.labels['io.flujo.worker.snapshot-envelope-read-versions']);
  assert.equal(runtime.match(/io\.flujo\.worker\.snapshot-default-limits='([^']+)'/)[1], report.labels['io.flujo.worker.snapshot-default-limits']);
  assert.match(runtime, /io\.flujo\.worker\.snapshot-source="1"/);
  return { ...report, dockerfileSha256: createHash('sha256').update(bytes).digest('hex') };
}

async function sourceProbe(revision, sourceRoot) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES, undefined);
  assert.equal(process.env.FLUJO_SNAPSHOT_MAX_BYTES, undefined);
  assert.equal(process.env.FLUJO_BUILD_REVISION, revision);
  const directory = path.join(sourceRoot, 'src/backend/services/workspace');
  const sourcePins = [];
  const source = (name) => {
    const bytes = readFileSync(path.join(directory, name));
    sourcePins.push({ file: `src/backend/services/workspace/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') });
    return stripTypeScriptTypes(bytes.toString('utf8'), { mode: 'strip' });
  };
  const url = (value) => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
  const replaceImport = (value, specifier, replacement) => {
    const expression = new RegExp(`from ['"]${specifier.replaceAll('.', '\\.')}['"]`, 'g');
    assert.match(value, expression);
    return value.replace(expression, `from '${replacement}'`);
  };
  const limitsUrl = url(source('snapshotLimits.ts'));
  const envelopeUrl = url(replaceImport(source('snapshotEnvelope.ts'), './snapshotLimits', limitsUrl));
  const layoutUrl = url(source('layoutVersion.ts'));
  let compatibility = source('workerCompatibility.ts');
  const packageBytes = readFileSync(path.join(sourceRoot, 'package.json'));
  const packageJson = JSON.parse(packageBytes);
  sourcePins.push({ file: 'package.json', sha256: createHash('sha256').update(packageBytes).digest('hex') });
  assert.match(compatibility, /import applicationPackage from ['"]\.\.\/\.\.\/\.\.\/\.\.\/package\.json['"];?/);
  compatibility = compatibility.replace(/import applicationPackage from ['"]\.\.\/\.\.\/\.\.\/\.\.\/package\.json['"];?/, `const applicationPackage = ${JSON.stringify(packageJson)};`);
  compatibility = replaceImport(compatibility, './layoutVersion', layoutUrl);
  compatibility = replaceImport(compatibility, './snapshotEnvelope', envelopeUrl);
  compatibility = replaceImport(compatibility, './snapshotLimits', limitsUrl);
  const limitsModule = await import(limitsUrl);
  const codec = await import(envelopeUrl);
  const info = (await import(url(compatibility))).getWorkerCompatibility();
  const capability = codec.SNAPSHOT_ENCRYPTION_CAPABILITY;
  assert.equal(info.revision, revision);
  assert.equal(info.applicationVersion, packageJson.version);
  assert.equal(info.workerSnapshotSourceVersion, 1);
  assert.deepEqual(info.snapshotEncryption, capability);
  assert.equal(capability.format, 'flujo-workspace-encrypted');
  assert.equal(capability.cipher, 'aes-256-gcm');
  assert.equal(capability.writeVersion, 2);
  assert.deepEqual(capability.readVersions, contract.snapshotEnvelopeReadVersions);
  assert.equal(capability.v2Aad, 'flujo:workspace-snapshot:v2');
  assert.equal(capability.v2Digest, 'sha256-encrypted-wire');
  assert.equal(capability.v1Digest, 'sha256-plaintext-zip');
  const limits = limitsModule.getSnapshotLimits();
  assert.deepEqual(info.snapshotLimits, limits);
  assert.deepEqual(limits, contract.snapshotDefaultLimits);
  const labels = {
    'io.flujo.worker.snapshot-envelope-read-versions': capability.readVersions.join(','),
    'io.flujo.worker.snapshot-default-limits': JSON.stringify(limits),
  };
  assert.deepEqual(labels, WORKER_IMAGE_LABELS);
  // Independent crypto constructs both advertised reads; these are small public fixtures.
  const key = Buffer.alloc(32, 0x5e);
  const plaintext = Buffer.from('public bounded worker-image capability fixture');
  try {
    for (const version of capability.readVersions) {
      const iv = Buffer.alloc(12, version);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      if (version === 2) cipher.setAAD(Buffer.from(capability.v2Aad));
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const wire = Buffer.from(JSON.stringify({ format: capability.format, version, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
      const decoded = codec.decryptSnapshotEnvelope(wire, key.toString('base64'), limits.maxArchiveBytes);
      assert.equal(decoded.version, version);
      assert.deepEqual(decoded.bytes, plaintext);
      assert.throws(() => codec.decryptSnapshotEnvelope(wire, Buffer.alloc(32, 0x6f).toString('base64'), limits.maxArchiveBytes));
      const changedTag = Buffer.from(cipher.getAuthTag());
      changedTag[0] ^= 1;
      const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(wire), tag: changedTag.toString('base64') }));
      assert.throws(() => codec.decryptSnapshotEnvelope(tampered, key.toString('base64'), limits.maxArchiveBytes));
    }
    const writtenWire = codec.encryptSnapshotEnvelope(plaintext, key);
    const written = JSON.parse(writtenWire.toString('utf8'));
    assert.equal(written.format, capability.format);
    assert.equal(written.version, capability.writeVersion);
    assert.deepEqual(Object.keys(written).sort(), ['data', 'format', 'iv', 'tag', 'version']);
    const readback = codec.decryptSnapshotEnvelope(writtenWire, key.toString('base64'), limits.maxArchiveBytes);
    assert.equal(readback.version, capability.writeVersion);
    assert.deepEqual(readback.bytes, plaintext);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(written.iv, 'base64'));
    decipher.setAAD(Buffer.from(capability.v2Aad));
    decipher.setAuthTag(Buffer.from(written.tag, 'base64'));
    assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(written.data, 'base64')), decipher.final()]), plaintext);
  } finally { key.fill(0); }
  const restoreBytes = readFileSync(path.join(directory, 'snapshotRestore.ts'));
  // Wiring is retained separately from codec proof; installed transactional restore remains a gate.
  assert.match(restoreBytes.toString('utf8'), /import \{ decryptSnapshotEnvelope \} from ['"]\.\/snapshotEnvelope['"]/);
  assert.match(restoreBytes.toString('utf8'), /decryptSnapshotEnvelope\(/);
  sourcePins.push({ file: 'src/backend/services/workspace/snapshotRestore.ts', sha256: createHash('sha256').update(restoreBytes).digest('hex') });
  return { schemaVersion: 1, revision, workerSnapshotSourceVersion: info.workerSnapshotSourceVersion, labels, sourcePins,
    proof: 'Actual isolated source metadata/defaults and independent v1/v2 crypto reads, wrong-key/modified-tag refusals, and new-v2-write/readback controls; not compiled/installed image, effective target configuration, private consent or lease acceptance' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, revision, first] = process.argv.slice(2);
    if (mode === 'probe-source') console.log(JSON.stringify(await sourceProbe(revision, first)));
    else if (mode === 'generate') {
      const report = generateWorkerImageCapability(revision);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `snapshot_envelope_read_versions=${report.labels['io.flujo.worker.snapshot-envelope-read-versions']}\nsnapshot_default_limits=${report.labels['io.flujo.worker.snapshot-default-limits']}\n`);
      console.log(JSON.stringify(report));
    } else if (mode === 'check-build') console.log(JSON.stringify(checkWorkerImageBuild(revision)));
    else throw new Error('Expected generate or check-build with source revision.');
  } catch { console.error('Worker image capability verification refused; source, revision or labels do not satisfy the reviewed contract.'); process.exitCode = 1; }
}

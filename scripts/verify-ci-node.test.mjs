import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CI_NODE_PROFILES, assertCiContainerContract, verifyCiNode } from './verify-ci-node.mjs';

function fixture(t) {
  const temp = realpathSync.native(os.tmpdir());
  const directory = realpathSync.native(mkdtempSync(path.join(temp, 'flujo-ci-node-')));
  t.after(() => {
    assert.equal(realpathSync.native(directory), directory);
    const relative = path.relative(temp, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    rmSync(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'owned-runtime-bytes');
  writeFileSync(executable, 'owned harmless executable-byte fixture; never executed');
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const binaries = { schemaVersion: 1, runtimes: Object.fromEntries(Object.values(CI_NODE_PROFILES).map((version) => [version,
    { uv: version === '22.13.1' ? '1.49.2' : version === '24.22.1' ? '1.52.1' : '1.51.0', executables: { linux: sha256, win32: sha256 } }])) };
  return { expectedVersion: CI_NODE_PROFILES.minimum22, version: CI_NODE_PROFILES.minimum22, uv: '1.51.0', platform: 'win32', arch: 'x64', executable, binaries, nodeOptions: '', execArgv: [] };
}

test('binary measurement accepts matching harmless bytes on every supported selected profile and OS', async (t) => {
  const f = fixture(t);
  for (const version of Object.values(CI_NODE_PROFILES).slice(1)) {
    for (const platform of ['win32', 'linux']) {
      const result = await verifyCiNode({ ...f, expectedVersion: version, version, uv: f.binaries.runtimes[version].uv, platform });
      assert.equal(result.node, version);
      assert.match(result.qualificationScope, /separate checks/);
    }
  }
});

test('a one-byte change is refused against the original pinned digest', async (t) => {
  const f = fixture(t);
  writeFileSync(f.executable, `${readFileSync(f.executable, 'utf8')}!`);
  await assert.rejects(verifyCiNode(f), /executable differs/);
});

test('historical build scope cannot admit the old runtime to installed acceptance or other versions to history', async (t) => {
  const f = fixture(t);
  const old = { ...f, expectedVersion: '22.13.1', version: '22.13.1', uv: '1.49.2' };
  await assert.rejects(verifyCiNode(old), { code: 'UNSUPPORTED_NODE_RUNTIME' });
  const measurement = await verifyCiNode({ ...old, historicalBuild: true });
  assert.match(measurement.qualificationScope, /unsupported for installed application acceptance/);
  await assert.rejects(verifyCiNode({ ...f, historicalBuild: true }), /restricted to Node 22.13.1/);
});

for (const [label, change, expected] of [
  ['version mismatch', (f) => { f.version = '22.23.3'; }, /exact selected runtime/],
  ['moving expected version', (f) => { f.expectedVersion = '22'; }, /exact selected runtime/],
  ['outside selected LTS lines', (f) => { f.expectedVersion = f.version = '26.10.0'; }, /exact selected runtime/],
  ['retired Node 22 minimum', (f) => { f.expectedVersion = f.version = '22.17.0'; }, /exact selected runtime/],
  ['wrong libuv', (f) => { f.uv = '1.49.2'; }, /binary\/libuv evidence/],
  ['unsupported OS', (f) => { f.platform = 'darwin'; }, /unsupported platform/],
  ['unsupported architecture', (f) => { f.arch = 'arm64'; }, /unsupported platform/],
  ['missing binary hash', (f) => { delete f.binaries.runtimes[f.version].executables.win32; }, /binary\/libuv evidence/],
  ['missing evidence schema', (f) => { delete f.binaries.schemaVersion; }, /binary\/libuv evidence/],
  ['heap override environment', (f) => { f.nodeOptions = '--max-old-space-size=8192'; }, /default heap/],
  ['Node argument override', (f) => { f.execArgv = ['--max-old-space-size=8192']; }, /default heap/],
]) {
  test(`binary measurement refuses ${label}`, async (t) => {
    const f = fixture(t);
    change(f);
    await assert.rejects(verifyCiNode(f), expected);
  });
}

test('pinned binary manifest retains actual signed checksums, signatures, key source and binary derivation', () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('scripts/ci-node-binaries.json', root), 'utf8'));
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const packets = new Map();
  function loadEvidence(evidence, evidenceSha256) {
    assert.equal(typeof evidence, 'string');
    assert.match(evidenceSha256, /^[a-f0-9]{64}$/);
    const receiptBytes = readFileSync(new URL(evidence, root));
    assert.equal(sha(receiptBytes), evidenceSha256, evidence);
    if (packets.has(evidence)) return packets.get(evidence);
    const receipt = JSON.parse(receiptBytes);
    const packet = new URL('./', new URL(evidence, root));
    assert.equal(manifest.officialKeysCommit, receipt.keySource.commit);
    assert.equal(receipt.keySource.repository, 'https://github.com/nodejs/release-keys');
    assert.equal(receipt.executableExecution, false);
    for (const item of receipt.inventory.filter((item) => !item.file.endsWith('.tar.gz') && item.retained !== false)) {
      const bytes = readFileSync(new URL(item.file, packet));
      assert.equal(bytes.length, item.bytes, item.file);
      assert.equal(sha(bytes), item.sha256, item.file);
    }
    for (const record of receipt.versions) {
      const checksums = readFileSync(new URL(`v${record.version}/SHASUMS256.txt`, packet));
      assert.equal(record.signatureExitCode, 0);
      assert.equal(sha(checksums), record.signedChecksumsSha256);
      assert.match(record.validSignatureStatus, new RegExp(`^\\[GNUPG:\\] VALIDSIG ${record.signingFingerprint} `));
      const status = readFileSync(new URL(`v${record.version}/signature-status.txt`, packet), 'utf8');
      assert.ok(status.split(/\r?\n/).includes(record.validSignatureStatus));
      assert.match(status, /\[GNUPG:\] GOODSIG /);
      assert.ok(readFileSync(new URL(`v${record.version}/SHASUMS256.txt.sig`, packet)).length > 0);
      assert.ok(checksums.toString().split(/\r?\n/).includes(`${record.windows.sha256}  win-x64/node.exe`));
      assert.ok(checksums.toString().split(/\r?\n/).includes(`${record.linux.archiveSha256}  ${record.linux.archive}`));
      assert.equal(record.linux.member, `node-v${record.version}-linux-x64/bin/node`);
      if (record.libuv) {
        const header = readFileSync(new URL(`v${record.version}/uv-version.h`, packet));
        assert.equal(header.length, record.libuv.bytes);
        assert.equal(sha(header), record.libuv.sha256);
        assert.equal(record.libuv.member, `node-v${record.version}-linux-x64/include/node/uv/version.h`);
        assert.equal(record.libuv.version, ['MAJOR', 'MINOR', 'PATCH'].map((part) => {
          const match = header.toString().match(new RegExp(`#define UV_VERSION_${part}\\s+(\\d+)`));
          assert.ok(match, `libuv ${part} version`);
          return match[1];
        }).join('.'));
      }
    }
    const result = { receipt, packet };
    packets.set(evidence, result);
    return result;
  }
  const original = loadEvidence(manifest.evidence, manifest.evidenceSha256);
  const containerBytes = readFileSync(new URL(manifest.containerBase.metadataFile, root));
  assert.equal(sha(containerBytes), manifest.containerBase.metadataSha256);
  const metadata = JSON.parse(containerBytes.toString().replace(/^\uFEFF/, ''));
  assert.equal(manifest.containerBase.reference, `mirror.gcr.io/library/node:${metadata.name}@${metadata.digest}`);
  assert.deepEqual(Object.keys(manifest.runtimes), [...new Set(Object.values(CI_NODE_PROFILES))]);
  for (const version of Object.values(CI_NODE_PROFILES)) {
    const entry = manifest.runtimes[version];
    const { receipt, packet } = loadEvidence(entry.evidence, entry.evidenceSha256);
    if (entry.evidence !== manifest.evidence) {
      assert.equal(receipt.keySource.evidence, manifest.evidence);
      assert.equal(receipt.keySource.evidenceSha256, manifest.evidenceSha256);
    }
    const records = receipt.versions.filter((record) => record.version === version);
    assert.equal(records.length, 1, `${version} must have exactly one signed binary derivation`);
    const [record] = records;
    const checksums = readFileSync(new URL(`v${record.version}/SHASUMS256.txt`, packet));
    assert.equal(sha(checksums), entry.signedChecksumsSha256);
    assert.equal(entry.signingFingerprint, record.signingFingerprint);
    assert.ok(checksums.toString().includes(`${entry.executables.win32}  win-x64/node.exe`));
    assert.ok(checksums.toString().includes(`${entry.linuxArchiveSha256}  ${entry.linuxArchive}`));
    assert.equal(entry.executables.win32, record.windows.sha256);
    assert.equal(entry.executables.linux, record.linux.sha256);
    assert.equal(entry.linuxArchiveSha256, record.linux.archiveSha256);
    assert.equal(entry.linuxArchive, record.linux.archive);
    if (record.libuv) assert.equal(entry.uv, record.libuv.version);
  }
  const { packet } = original;
  const control = JSON.parse(readFileSync(new URL('controls/receipt.json', packet)));
  assert.equal(control.exitCode, 1);
  assert.equal(control.actualBadSignature, true);
  for (const item of control.inventory) {
    const bytes = readFileSync(new URL(`controls/${item.file}`, packet));
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha(bytes), item.sha256);
  }
  assert.match(readFileSync(new URL('controls/signature-status.txt', packet), 'utf8'), /\[GNUPG:\] BADSIG /);
});

test('container packaging retains pinned bases, official binary checks and canonical guard files', () => {
  const source = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assertCiContainerContract(source);
  assert.throws(() => assertCiContainerContract(source.replace(/node:22\.23\.4-bookworm-slim@sha256:[a-f0-9]{64}/g, 'node:22-bookworm-slim')), /exact observed/);
  assert.throws(() => assertCiContainerContract(source.replace('COPY --from=builder /app/bin ./bin', '# omitted canonical guard')), /ship the canonical guard/);
  assert.throws(() => assertCiContainerContract(source.replace('RUN node scripts/verify-ci-node.mjs 22.23.4 --binary-only', '# omitted binary verification')), /verify its official Node binary/);
});

test('binary-only measurement cannot turn the historical runtime into container acceptance', () => {
  const entry = new URL('./verify-ci-node.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(entry), '22.13.1', '--historical-build', '--binary-only'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot use the historical build scope/);
});

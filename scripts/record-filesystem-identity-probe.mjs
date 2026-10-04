import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const versions = ['22.13.1', '22.17.0'];
const expectedLibuv = { '22.13.1': '1.49.2', '22.17.0': '1.51.0' };
const [operation, argument, extra] = process.argv.slice(2);
const directory = path.resolve(operation === 'run' ? extra || 'filesystem-identity-evidence' : argument || 'filesystem-identity-evidence');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

if (operation === 'run' && versions.includes(argument)) {
  assert.equal(process.versions.node, argument, 'Selected Node runtime does not match the requested probe.');
  mkdirSync(directory, { recursive: true });
  const caseDirectory = path.join(directory, `node-${argument}`);
  mkdirSync(caseDirectory); // Refuse an existing case instead of replacing evidence.
  const probe = path.resolve('scripts/probe-filesystem-identity.mjs');
  const childEnvironment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) childEnvironment[name] = process.env[name];
  }
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [probe], {
    env: childEnvironment, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const stdout = result.stdout || Buffer.alloc(0);
  const stderr = result.stderr || Buffer.alloc(0);
  writeFileSync(path.join(caseDirectory, 'stdout.json'), stdout);
  writeFileSync(path.join(caseDirectory, 'stderr.log'), stderr);
  let payload;
  let parseError;
  try { payload = JSON.parse(stdout.toString('utf8')); } catch (error) { parseError = error.message; }
  const record = {
    schemaVersion: 1, kind: 'captured-owned-temporary-file-identity-probe', startedAt,
    completedAt: new Date().toISOString(), expectedNode: argument,
    runtime: { node: process.version, libuv: process.versions.uv, platform: process.platform, architecture: process.arch },
    probeSha256: sha256(readFileSync(probe)), recorderSha256: sha256(readFileSync(new URL(import.meta.url))),
    nodeExecutableSha256: sha256(readFileSync(process.execPath)),
    child: { exitCode: result.status, signal: result.signal, error: result.error?.message || null },
    stdout: { file: 'stdout.json', bytes: stdout.length, sha256: sha256(stdout) },
    stderr: { file: 'stderr.log', bytes: stderr.length, sha256: sha256(stderr) },
    payloadParseError: parseError || null,
    identityContractSatisfied: payload?.identityContractSatisfied === true,
    cleanupCompleted: payload?.cleanupCompleted === true,
    installedStartupQualified: false,
  };
  writeJson(path.join(caseDirectory, 'record.json'), record);
  console.log(JSON.stringify(record));
  process.exitCode = result.status === 0 && record.identityContractSatisfied && record.cleanupCompleted ? 0 : result.status || 1;
} else if (operation === 'compare' && extra === undefined) {
  const errors = [];
  let host;
  let hostSha256;
  try {
    const hostBytes = readFileSync(path.join(directory, 'host.json'));
    hostSha256 = sha256(hostBytes);
    host = JSON.parse(hostBytes.toString('utf8'));
    assert.match(host.sourceRevision, /^[a-f0-9]{40}$/);
    assert.equal(host.sourceRevision, host.expectedSourceRevision);
    assert.equal(host.repository, 'mario-andreschak/FLUJO');
    assert.equal(host.runnerLabel, 'windows-2025');
    assert.match(host.operatingSystem.caption, /Windows Server 2025/);
    assert.ok(host.imageOS && host.imageVersion, 'Hosted image identity is missing.');
  } catch (error) { errors.push(`Host/source evidence: ${error.message}`); }
  const cases = versions.map((version) => {
    const item = { expectedNode: version, errors: [] };
    try {
      const caseDirectory = path.join(directory, `node-${version}`);
      item.record = JSON.parse(readFileSync(path.join(caseDirectory, 'record.json'), 'utf8'));
      assert.equal(item.record.expectedNode, version);
      assert.equal(item.record.runtime.node, `v${version}`);
      assert.equal(item.record.runtime.libuv, expectedLibuv[version]);
      assert.equal(item.record.runtime.platform, 'win32');
      for (const name of ['stdout', 'stderr']) {
        const raw = readFileSync(path.join(caseDirectory, `${name}.${name === 'stdout' ? 'json' : 'log'}`));
        assert.equal(raw.length, item.record[name].bytes);
        assert.equal(sha256(raw), item.record[name].sha256);
      }
      item.payload = JSON.parse(readFileSync(path.join(caseDirectory, 'stdout.json'), 'utf8'));
      assert.equal(item.payload.kind, 'owned-temporary-file-identity-contract');
      assert.equal(item.payload.samples.length, 6);
      assert.equal(item.payload.runtime.node, item.record.runtime.node);
      assert.equal(item.payload.runtime.libuv, item.record.runtime.libuv);
      assert.equal(item.record.child.exitCode, 0, 'Probe exited unsuccessfully; mismatch remains a failure.');
      assert.equal(item.record.identityContractSatisfied, true);
      assert.equal(item.payload.identityContractSatisfied, true);
      assert.equal(item.payload.cleanupCompleted, true);
    } catch (error) { item.errors.push(error.message); }
    return item;
  });
  if (cases.every(item => item.record)) {
    for (const field of ['probeSha256', 'recorderSha256']) {
      if (cases[0].record[field] !== cases[1].record[field]) errors.push(`The two runtimes executed different ${field} bytes.`);
    }
  }
  const comparison = {
    schemaVersion: 1, kind: 'same-host-windows-filesystem-runtime-comparison', createdAt: new Date().toISOString(),
    host, hostSha256, errors, cases,
    identityContractSatisfiedForBoth: errors.length === 0 && cases.every(item => item.errors.length === 0),
    productionAdmissionChanged: false, installedStartupQualified: false,
  };
  writeJson(path.join(directory, 'comparison.json'), comparison);
  console.log(JSON.stringify(comparison));
  if (!comparison.identityContractSatisfiedForBoth) process.exitCode = 1;
} else {
  throw new Error('Use run <22.13.1|22.17.0> [new evidence parent] or compare [evidence parent].');
}

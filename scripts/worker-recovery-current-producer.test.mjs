import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { checkRecoveryBinding, recoveryProducer, recoveryProducerEvidence,
  recoveryProducerPackageArchives, currentRecoveryProducerProfile } from './worker-recovery-binding.mjs';

const application = path.resolve('synthetic-producerEA592');
const equipmentRoot = path.resolve('synthetic-derivative-equipment');
const digest = 'a'.repeat(64);
const reference = { path: path.resolve('synthetic-reference.json'), bytes: 1, sha256: digest };
function fixture() {
  const pin = file => ({ path: file, bytes: 1, sha256: digest });
  return { schemaVersion: 1, profile: 'owned-windows-job-local-compiled-recovery',
    producer: { ...recoveryProducerEvidence, identity: { ...recoveryProducer },
      qualification: { status: 'QUALIFIED', cases: 737, receipt: recoveryProducerEvidence.qualificationReceipt },
      packageArchives: recoveryProducerPackageArchives, currentRecoveryProducerProfile },
    applicationRoot: application,
    equipment: { root: equipmentRoot, head: 'b'.repeat(40), tree: 'c'.repeat(40), graphReceipt: reference,
      qualification: { status: 'QUALIFIED', nodeCases: 47, nativeCases: 4, receipt: reference },
      files: ['scripts/smoke-cloud-worker.mjs', 'scripts/worker-recovery-acceptance.mjs',
        'scripts/pinned-file-read.mjs',
        'scripts/worker-recovery-runtime.mjs', 'scripts/worker-recovery-binding.mjs',
        'scripts/mcp-smoke-cleanup.mjs', 'scripts/healthcheck.mjs',
        'scripts/persona-browser-acceptance/next-process.cjs',
        'scripts/recovery-controller/Invoke-WorkerRecovery.ps1', 'scripts/recovery-controller/WindowsRecoveryJob.cs',
        'scripts/worker-recovery-acceptance.test.mjs', 'scripts/worker-recovery-runtime.test.mjs',
        'scripts/worker-recovery-binding.test.mjs', 'scripts/recovery-controller/Test-WindowsRecoveryJob.ps1',
        'scripts/recovery-controller/native-job-fixture.mjs'].map(pin) },
    payload: { files: ['package.json', '.next/BUILD_ID', 'node_modules/next/package.json',
      'node_modules/next/dist/server/lib/start-server.js'].map(pin) },
    node: { sha256: '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e' },
    controller: { status: 'QUALIFIED', profile: 'atomic-job-list-before-resume-windows-job', qualificationReceipt: reference },
    lease: { maximumEntries: 1, driverMs: 1_860_000, finalizationMs: 30_000, grant: reference,
      expiresAtUtc: new Date(Date.now() + 60_000).toISOString() } };
}
const check = binding => checkRecoveryBinding(binding, { application, equipmentRoot });

function currentFixture() {
  const binding = fixture();
  binding.producer = structuredClone({ ...currentRecoveryProducerProfile.evidence,
    identity: currentRecoveryProducerProfile.identity, qualification: currentRecoveryProducerProfile.qualification,
    packageArchives: currentRecoveryProducerProfile.packageArchives });
  binding.equipment.files.push({ path: 'scripts/worker-recovery-producer-cc69.json', bytes: 1, sha256: digest });
  return binding;
}
test('current cc69 admits only its own build/five-pack scope', () => {
  const binding = currentFixture(); assert.equal(check(binding), binding);
  assert.equal(binding.producer.qualification.cases, 0);
  assert.notEqual(binding.producer.qualification.status, 'QUALIFIED');
});
test('historical EA qualification cannot be transferred to current cc69', () => {
  const binding = currentFixture(); binding.producer.qualification = fixture().producer.qualification;
  assert.throws(() => check(binding), /historical EA qualification/);
});
test('current changed archives, identity or missing Source profile refuse', () => {
  const archive = currentFixture(); archive.producer.packageArchives[0].sha256 = digest;
  assert.throws(() => check(archive), /archive pins changed/);
  const identity = currentFixture(); identity.producer.identity.tree = 'a'.repeat(40);
  assert.throws(() => check(identity), /identity changed/);
  const missing = currentFixture(); missing.equipment.files.pop();
  assert.throws(() => check(missing), /Source pin missing/);
});

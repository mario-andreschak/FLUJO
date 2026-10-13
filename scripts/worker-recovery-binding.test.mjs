import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { checkRecoveryBinding, recoveryProducer, recoveryProducerEvidence,
  recoveryProducerPackageArchives } from './worker-recovery-binding.mjs';

const application = path.resolve('synthetic-producerEA592');
const equipmentRoot = path.resolve('synthetic-derivative-equipment');
const digest = 'a'.repeat(64);
const reference = { path: path.resolve('synthetic-reference.json'), bytes: 1, sha256: digest };
function fixture() {
  const pin = file => ({ path: file, bytes: 1, sha256: digest });
  return { schemaVersion: 1, profile: 'owned-windows-job-local-compiled-recovery',
    producer: { ...recoveryProducerEvidence, identity: { ...recoveryProducer },
      qualification: { status: 'QUALIFIED', cases: 737, receipt: recoveryProducerEvidence.qualificationReceipt },
      packageArchives: recoveryProducerPackageArchives },
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

test('qualified producerEA592 identity remains distinct from derivative equipment ancestry', () => {
  const binding = fixture(); assert.equal(check(binding), binding);
  assert.notEqual(binding.producer.identity.head, binding.equipment.head);
});
test('a4d9 application outcomes cannot substitute for actualEA592 producer qualification', () => {
  const binding = fixture(); binding.producer.identity.head = 'a4d9cc564cf021eb1857ab8e6618f07c05453354';
  assert.throws(() => check(binding), /Actual producer/);
});
test('held qualification cannot replace actualEA737 qualification', () => {
  const binding = fixture(); binding.producer.qualification.status = 'HELD';
  assert.throws(() => check(binding), /qualification is still held/);
});
test('the sealed5c918e leaf cannot be relabeled as qualified derivative equipment', () => {
  const binding = fixture(); binding.equipment.head = '5c918e793f4fe25f368fe3dee7a1d3811120b7e3';
  assert.throws(() => check(binding), /Original5c918e is preserved/);
});
test('an unqualified native controller cannot replace original birth and closure evidence', () => {
  const binding = fixture(); binding.controller.status = 'SOURCE_ONLY';
  assert.throws(() => check(binding));
});
test('payload escape and duplicate Windows aliases refuse their file census', () => {
  const escaped = fixture(); escaped.payload.files.push({ path: '../outside', bytes: 1, sha256: digest });
  assert.throws(() => check(escaped), /escapes or aliases/);
  const aliased = fixture(); aliased.payload.files.push({ path: 'PACKAGE.JSON', bytes: 1, sha256: digest });
  assert.throws(() => check(aliased), /duplicate/);
});
test('expired lease or widened driver deadline cannot renew the original acceptance window', () => {
  const expired = fixture(); expired.lease.expiresAtUtc = '2000-01-01T00:00:00Z';
  assert.throws(() => check(expired), /Lease expired/);
  const widened = fixture(); widened.lease.driverMs++; assert.throws(() => check(widened));
});

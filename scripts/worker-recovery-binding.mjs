import currentRecoveryProducer from './worker-recovery-producer-cc69.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readPinnedFile } from './pinned-file-read.mjs';

export const recoveryProducer = Object.freeze({
  head: 'ea592d62075bafbb70ddbe1eb76479f1572aff81',
  tree: 'eca03ce7627ba31f155a37da89deaf3a99ad2835',
});
// Actual producer qualification is distinct from equipment/controller qualification.
// These fixed producer receipts do not grant recovery entry.
export const recoveryProducerQualification = Object.freeze({ status: 'QUALIFIED', cases: 737 });
export const recoveryProducerEvidence = Object.freeze({
  qualificationReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-original737-success-root-v2/review.json","bytes":7790,"sha256":"e3a01453b7bc7dfd37bf7d7f164b224a00c0d1a9bf0ea0a64db9367051fae50d"}),
  producerRootReview: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/producer-and-short47-success-root-v83/review.json","bytes":5065,"sha256":"4e016fb886ce5f0bd5cdcd07fc8edc4c6531a2b68eeef98b523257441e1af16d"}),
  originalProducerResult: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/result.json","bytes":25090,"sha256":"acfe094189a22d6de137ef3e4df8bc1ed389005c33e097bc2da9859de845e7fa"}),
  buildReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/ordinary-production-build-original-result.json","bytes":13537,"sha256":"62b2da6fa03b91b6d836eba0af07fdfa9e09101180e78589465a50d2349a203d"}),
  packReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/five-actual-packages-original-result.json","bytes":5218,"sha256":"8f9ed9ecaae871fd1ddd3541891f14c5706720b7f1e4a37c6d8c2bb9ffbdecae"}),
  archive: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz","bytes":10339465,"sha256":"73b5f9f370d41a36bf450050fa3e7ac2817cccb03f861d4ed1e4f15ceb9f1554"}),
  graphReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/after-complete-own91930-graph.json","bytes":27410813,"sha256":"bc370cf7897f54801304c460cd116539ab1721499e995cb8f98a77249d7e529b"}),
  artifactJoin: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/five-original-packages-artifact-join.json","bytes":5769,"sha256":"e738f4fd8e0dcb9a593655341d63bd0a87ff4c9fe4453a0fc2afe97795817355"}),
  generatedOutputReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/after-complete-generated-output-pins.json","bytes":708941,"sha256":"ad84ba293d87eb3850ffa8cc01316ef88ae13466e00987f5eb9c4edfe2e4233c"}),
  originalEvidence: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/completed-original-nrec2-producer-output-pins-v1.json","bytes":252625,"sha256":"9bbde6cfe889e896257fcdc06df68afcecb945d1396d8e86c9b3dc886264750d"}),
  graphRootReview: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-monitor-install-success-root-v80/review.json","bytes":3191,"sha256":"ccbaa93f8231a6c83a89e9237b2837cf1085b6dda02e425a77e1a56d87aea6f6"}),
});
export const recoveryProducerPackageArchives = Object.freeze([
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz","bytes":10339465,"sha256":"73b5f9f370d41a36bf450050fa3e7ac2817cccb03f861d4ed1e4f15ceb9f1554"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-filesystem-3.46.3.tgz","bytes":56613,"sha256":"918435f4274c5d84ffafc07e1c0b5bcf662af768cbe27319b3b78a1679e50a21"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-bash-3.46.3.tgz","bytes":57885,"sha256":"a8cb28f8d9734cbed4764a8ec0388f80f1ea77999b7b045c56e9c378c1f44755"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-browser-3.46.3.tgz","bytes":95401,"sha256":"1ed59e83050e60b7f77ef92d6adf4f897a382202623cc0af9213310cdadc95fa"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-flujo-3.46.3.tgz","bytes":11678,"sha256":"40c9d29272aaa98363770cccdb9f305134cb76bb94fdc3a0f7b339bd88f6caa6"}),
]);

const digestPattern = /^[a-f0-9]{64}$/;
const maximumFiles = 100_000;
const maximumFileBytes = 256 * 1024 * 1024;
const maximumTableBytes = 32 * 1024 * 1024 * 1024;
const maximumBindingBytes = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export const currentRecoveryProducerProfile = currentRecoveryProducer;
const producerReferences = binding => binding.producer.identity.head === currentRecoveryProducer.identity.head
  ? [...Object.values(currentRecoveryProducer.evidence), ...currentRecoveryProducer.packageArchives]
  : [...Object.values(recoveryProducerEvidence), ...recoveryProducerPackageArchives];

export function checkRecoveryBinding(binding, { application, equipmentRoot }) {
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.profile, 'owned-windows-job-local-compiled-recovery');
  if (binding.producer.identity.head === currentRecoveryProducer.identity.head) {
    assert.deepEqual(binding.producer.identity, currentRecoveryProducer.identity, 'Actual current producer identity changed.');
    assert.deepEqual(binding.producer.qualification, currentRecoveryProducer.qualification,
      'Current build/pack evidence cannot borrow historical EA qualification.');
    for (const [name, reference] of Object.entries(currentRecoveryProducer.evidence)) {
      assert.deepEqual(binding.producer[name], reference, 'Current producer receipt changed.');
    }
    assert.deepEqual(binding.producer.packageArchives, currentRecoveryProducer.packageArchives, 'Current five archive pins changed.');
    assert.ok(binding.equipment.files.some(entry => entry.path === 'scripts/worker-recovery-producer-cc69.json'),
      'Current producer profile Source pin missing.');
  } else {
    assert.deepEqual(binding.producer.identity, recoveryProducer, 'Actual producer must be exactEA592, separately from equipment.');
    assert.equal(binding.producer.qualification.status, recoveryProducerQualification.status,
      'Producer qualification is still held; exactEA737 qualification required.');
    assert.equal(binding.producer.qualification.cases, recoveryProducerQualification.cases,
      'Producer requires its complete actual737 qualification.');
    assert.deepEqual(binding.producer.qualification.receipt, recoveryProducerEvidence.qualificationReceipt,
      'Actual737 Root qualification receipt changed.');
    for (const [name, reference] of Object.entries(recoveryProducerEvidence)) {
      if (name !== 'qualificationReceipt') assert.deepEqual(binding.producer[name], reference,
        'Actual producer build/archive/graph receipt changed.');
    }
    assert.deepEqual(binding.producer.packageArchives, recoveryProducerPackageArchives,
      'Actual five-package archive pins changed.');
  }
  assert.equal(binding.applicationRoot, path.resolve(application));
  assert.equal(binding.equipment.root, path.resolve(equipmentRoot));
  assert.match(binding.equipment.head, /^[a-f0-9]{40}$/);
  assert.match(binding.equipment.tree, /^[a-f0-9]{40}$/);
  assert.notEqual(binding.equipment.head, '5c918e793f4fe25f368fe3dee7a1d3811120b7e3', 'Original5c918e is preserved, not this derivative.');
  assert.equal(binding.equipment.qualification.status, 'QUALIFIED', 'Recovery equipment qualification is still held.');
  assert.equal(binding.equipment.qualification.nodeCases, 47);
  assert.equal(binding.equipment.qualification.nativeCases, 4);
  assert.match(binding.node.sha256, digestPattern);
  assert.equal(binding.node.sha256, '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e');
  assert.equal(binding.controller.status, 'QUALIFIED');
  assert.equal(binding.controller.profile, 'atomic-job-list-before-resume-windows-job');
  assert.equal(binding.lease.maximumEntries, 1);
  assert.equal(binding.lease.driverMs, 1_860_000);
  assert.equal(binding.lease.finalizationMs, 30_000);
  assert.ok(Number.isFinite(Date.parse(binding.lease.expiresAtUtc)) && Date.now() < Date.parse(binding.lease.expiresAtUtc), 'Lease expired.');
  for (const table of [binding.payload.files, binding.equipment.files]) {
    assert.ok(Array.isArray(table) && table.length > 0 && table.length <= maximumFiles, 'Binding file census is missing or oversized.');
    const seen = new Set(); let bytes = 0;
    for (const entry of table) {
      assert.ok(typeof entry.path === 'string' && entry.path.length <= 1024
        && !/[\\:\x00-\x1f]/.test(entry.path) && !entry.path.startsWith('/')
        && entry.path.split('/').every(part => part && part !== '.' && part !== '..'
          && !/[. ]$/.test(part)), 'Binding path escapes or aliases an admitted root.');
      const identity = entry.path.toLowerCase();
      assert.ok(!seen.has(identity), 'Binding has duplicate/aliased paths.'); seen.add(identity);
      assert.match(entry.sha256, digestPattern);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= maximumFileBytes);
      bytes += entry.bytes; assert.ok(bytes <= maximumTableBytes, 'Binding byte census exceeded.');
    }
  }
  const required = ['scripts/smoke-cloud-worker.mjs', 'scripts/worker-recovery-acceptance.mjs',
    'scripts/pinned-file-read.mjs',
    'scripts/worker-recovery-runtime.mjs', 'scripts/worker-recovery-binding.mjs',
    'scripts/mcp-smoke-cleanup.mjs', 'scripts/healthcheck.mjs',
    'scripts/persona-browser-acceptance/next-process.cjs',
    'scripts/recovery-controller/Invoke-WorkerRecovery.ps1', 'scripts/recovery-controller/WindowsRecoveryJob.cs',
    'scripts/worker-recovery-acceptance.test.mjs', 'scripts/worker-recovery-runtime.test.mjs',
    'scripts/worker-recovery-binding.test.mjs', 'scripts/recovery-controller/Test-WindowsRecoveryJob.ps1',
    'scripts/recovery-controller/native-job-fixture.mjs'];
  for (const file of required) assert.ok(binding.equipment.files.some(entry => entry.path === file), 'Missing runtime/controller equipment pin.');
  for (const file of ['package.json', '.next/BUILD_ID', 'node_modules/next/package.json', 'node_modules/next/dist/server/lib/start-server.js']) {
    assert.ok(binding.payload.files.some(entry => entry.path === file), 'Missing compiled producer/runtime pin.');
  }
  for (const ref of [...producerReferences(binding),
    binding.equipment.graphReceipt, binding.equipment.qualification.receipt,
    binding.controller.qualificationReceipt, binding.lease.grant]) {
    assert.ok(path.isAbsolute(ref.path) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0);
    assert.match(ref.sha256, digestPattern);
  }
  return binding;
}

async function assertPlainPath(root, relative) {
  let current = path.resolve(root);
  assert.ok(!(await fs.lstat(current)).isSymbolicLink(), 'Admitted root cannot be a junction/symlink.');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    assert.ok(!(await fs.lstat(current)).isSymbolicLink(), 'Binding cannot traverse a junction/symlink.');
  }
  return current;
}
async function verifyFile(file, entry, signal) {
  await readPinnedFile(file, { maxBytes: maximumFileBytes, expectedBytes: entry.bytes,
    expectedSha256: entry.sha256, signal, collect: false });
}
export async function verifyRecoveryBinding({ bindingPath, bindingSha256, application, equipmentRoot, signal }) {
  assert.ok(path.isAbsolute(bindingPath ?? ''), 'Recovery requires an absolute Root-admitted binding.');
  assert.match(bindingSha256 ?? '', digestPattern, 'Recovery requires the independently admitted binding digest.');
  const raw = await readPinnedFile(bindingPath, { maxBytes: maximumBindingBytes, signal });
  assert.equal(hash(raw), bindingSha256, 'Recovery binding changed.');
  const binding = checkRecoveryBinding(JSON.parse(raw), { application, equipmentRoot });
  for (const [root, table] of [[application, binding.payload.files], [equipmentRoot, binding.equipment.files]]) {
    for (const entry of table) await verifyFile(await assertPlainPath(root, entry.path), entry, signal);
  }
  for (const ref of [...producerReferences(binding),
    binding.equipment.graphReceipt, binding.equipment.qualification.receipt,
    binding.controller.qualificationReceipt, binding.lease.grant]) await verifyFile(ref.path, ref, signal);
  if (binding.producer.identity.head === currentRecoveryProducer.identity.head) {
    const rawCopy = await readPinnedFile(binding.producer.payloadCopyReceipt.path,
      { maxBytes: maximumBindingBytes, expectedBytes: binding.producer.payloadCopyReceipt.bytes,
        expectedSha256: binding.producer.payloadCopyReceipt.sha256, signal });
    const copy = JSON.parse(rawCopy);
    assert.equal(copy.buildId, currentRecoveryProducer.buildId);
    assert.deepEqual(binding.payload.files, copy.payloadFiles, 'Current payload differs from actual copied archive/trace join.');
  }
  return { bindingSha256, producer: binding.producer.identity,
    equipment: { head: binding.equipment.head, tree: binding.equipment.tree },
    profile: binding.profile, payloadFilesVerified: binding.payload.files.length,
    equipmentFilesVerified: binding.equipment.files.length,
    correspondence: 'Root-admitted external qualification/build/archive/graph receipts; listed bytes reverified',
    lease: binding.lease };
}

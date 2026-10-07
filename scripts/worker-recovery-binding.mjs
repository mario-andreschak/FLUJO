import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';

export const recoveryProducer = Object.freeze({
  head: 'ea592d62075bafbb70ddbe1eb76479f1572aff81',
  tree: 'eca03ce7627ba31f155a37da89deaf3a99ad2835',
});
// Actual producer qualification is distinct from equipment/controller qualification.
// These fixed producer receipts do not grant recovery entry.
export const recoveryProducerQualification = Object.freeze({ status: 'QUALIFIED', cases: 737 });
export const recoveryProducerEvidence = Object.freeze({
  qualificationReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-original737-success-root-v2/review.json","bytes":7790,"sha256":"e3a01453b7bc7dfd37bf7d7f164b224a00c0d1a9bf0ea0a64db9367051fae50d"}),
  producerRootReview: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-original-producer-root-join-v2/review.json","bytes":4206,"sha256":"15a4ab6a443e31c326b7d0e2e2d7f76764c3007f41c2c0129c830a187171bd57"}),
  originalProducerResult: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/result.json","bytes":23917,"sha256":"0ce089b1e4af1df7fc34ab9de568d10f321d6adb986224aa71bb5accd2a0922f"}),
  buildReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/ordinary-production-build-original-result.json","bytes":12670,"sha256":"1c8d6746c4aadb22961bd4c78f6ab66a2dbe15842c43fd8afccf477a3ccac171"}),
  packReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/five-actual-packages-original-result.json","bytes":5172,"sha256":"2d515dc2b881e8183bf3f131de0eaaffa7974fd43aa025b510d2be8daebf3f9c"}),
  archive: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz","bytes":10344082,"sha256":"f1ed62b496610d09afc82b7bbfa16a1ec13a5e65e69ed31fbe0bcac3d2dcd1e7"}),
  graphReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/after-complete-own91930-graph.json","bytes":27318857,"sha256":"951e9dc94cbc9ae840badefff0e390cb802e88a0e4257e642bc7b9a768593323"}),
  artifactJoin: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/five-original-packages-artifact-join.json","bytes":5670,"sha256":"786136c8fbd09692c78f3c95e709ff1d9da743eb899e6116eee28fb51f17fdec"}),
  generatedOutputReceipt: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/after-complete-generated-output-pins.json","bytes":706581,"sha256":"c63195b19c672400ffc130b78f9f83f4e9c11230e4e1cd5e61e43c028c35624f"}),
  originalEvidence: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/completed-original-producer-evidence-pins.json","bytes":241946,"sha256":"5e0f3a57460f385a17d10798901671373e6cde7b318ecf03c0dce29d64055eb8"}),
  graphRootReview: Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-source-own-graph-root-v1/review.json","bytes":4298,"sha256":"317d3c3cfe7717958eff9622d888a1e9a35f654b7e213830c55209dc760d9d45"}),
});
export const recoveryProducerPackageArchives = Object.freeze([
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz","bytes":10344082,"sha256":"f1ed62b496610d09afc82b7bbfa16a1ec13a5e65e69ed31fbe0bcac3d2dcd1e7"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-filesystem-3.46.3.tgz","bytes":56613,"sha256":"918435f4274c5d84ffafc07e1c0b5bcf662af768cbe27319b3b78a1679e50a21"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-bash-3.46.3.tgz","bytes":57885,"sha256":"a8cb28f8d9734cbed4764a8ec0388f80f1ea77999b7b045c56e9c378c1f44755"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-browser-3.46.3.tgz","bytes":95401,"sha256":"1ed59e83050e60b7f77ef92d6adf4f897a382202623cc0af9213310cdadc95fa"}),
  Object.freeze({"path":"C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-flujo-3.46.3.tgz","bytes":11678,"sha256":"40c9d29272aaa98363770cccdb9f305134cb76bb94fdc3a0f7b339bd88f6caa6"}),
]);

const digestPattern = /^[a-f0-9]{64}$/;
const maximumFiles = 100_000;
const maximumFileBytes = 256 * 1024 * 1024;
const maximumTableBytes = 32 * 1024 * 1024 * 1024;
const maximumBindingBytes = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function checkRecoveryBinding(binding, { application, equipmentRoot }) {
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.profile, 'owned-windows-job-local-compiled-recovery');
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
  for (const ref of [...Object.values(recoveryProducerEvidence), ...recoveryProducerPackageArchives,
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
  signal?.throwIfAborted();
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes, 'Pinned file shape/size changed.');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) digest.update(bytes);
  assert.equal(digest.digest('hex'), entry.sha256, 'Pinned file digest changed.');
}
export async function verifyRecoveryBinding({ bindingPath, bindingSha256, application, equipmentRoot, signal }) {
  assert.equal(recoveryProducerQualification.status, 'QUALIFIED',
    'Actual producer qualification is not frozen.');
  assert.ok(Number.isSafeInteger(recoveryProducerQualification.cases) && recoveryProducerQualification.cases > 0,
    'Actual producer qualification census is not frozen.');
  assert.ok(path.isAbsolute(bindingPath ?? ''), 'Recovery requires an absolute Root-admitted binding.');
  assert.match(bindingSha256 ?? '', digestPattern, 'Recovery requires the independently admitted binding digest.');
  const stat = await fs.lstat(bindingPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBindingBytes);
  const raw = await fs.readFile(bindingPath, { signal });
  assert.equal(hash(raw), bindingSha256, 'Recovery binding changed.');
  const binding = checkRecoveryBinding(JSON.parse(raw), { application, equipmentRoot });
  for (const [root, table] of [[application, binding.payload.files], [equipmentRoot, binding.equipment.files]]) {
    for (const entry of table) await verifyFile(await assertPlainPath(root, entry.path), entry, signal);
  }
  for (const ref of [...Object.values(recoveryProducerEvidence), ...recoveryProducerPackageArchives,
    binding.equipment.graphReceipt, binding.equipment.qualification.receipt,
    binding.controller.qualificationReceipt, binding.lease.grant]) await verifyFile(ref.path, ref, signal);
  return { bindingSha256, producer: binding.producer.identity,
    equipment: { head: binding.equipment.head, tree: binding.equipment.tree },
    profile: binding.profile, payloadFilesVerified: binding.payload.files.length,
    equipmentFilesVerified: binding.equipment.files.length,
    correspondence: 'Root-admitted external qualification/build/archive/graph receipts; listed bytes reverified',
    lease: binding.lease };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateRecoveryInput, validateRecoveryTarget, upgradeExistingRoot } from './maintainer-installed-recovery.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = 'a'.repeat(40);
const original = Buffer.from(JSON.stringify({ id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] }));
const archive = Buffer.from('fixture archive bytes');
const receipt = () => ({ schemaVersion: 1, kind: 'automated-installed-baseline-probe', result: 'passed-baseline-probe',
  sourceCleanBefore: true, sourceCleanAfter: true, toolRevision: tool, semanticComparison: { passed: true },
  integrity: 'independently pinned bytes', tarball: { observedIntegrity: 'independently pinned bytes' },
  version: '3.46.2', installedManifest: { name: 'flujo-ai', version: '3.46.2' }, backup: { sha256: digest(archive), bytes: archive.length },
  evidence: [{ path: 'original-flow.json', sha256: digest(original), bytes: original.length }] });

test('fresh recovery rejects changed archive/original bytes and unsuccessful or stale source evidence', () => {
  assert.equal(validateRecoveryInput(receipt(), archive, original, tool).id, 'maintainer_drill_flow');
  assert.throws(() => validateRecoveryInput(receipt(), Buffer.from('changed'), original, tool), /differs/);
  assert.throws(() => validateRecoveryInput(receipt(), archive, Buffer.from('{}'), tool), /differs/);
  assert.throws(() => validateRecoveryInput(receipt(), archive, original, 'b'.repeat(40)), /differs/);
  for (const changes of [{ result: 'failed' }, { sourceCleanAfter: false }, { semanticComparison: { passed: false } },
    { installedManifest: { name: 'flujo-ai', version: '3.46.1' } },
    { installedManifest: { name: 'other', version: '3.46.2' } }, { tarball: { observedIntegrity: 'different' } }, { evidence: [] }]) {
    assert.throws(() => validateRecoveryInput({ ...receipt(), ...changes }, archive, original, tool), /differs/);
  }
});

test('even recomputed checksums cannot replace the prescribed fixture with runnable or unrelated data', () => {
  for (const fixture of [{ id: '../other', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] },
    { id: 'maintainer_drill_flow', name: 'Private workflow', nodes: [], edges: [] },
    { id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [{ type: 'agent' }], edges: [] }]) {
    const altered = Buffer.from(JSON.stringify(fixture)); const evidence = receipt();
    evidence.evidence[0] = { path: 'original-flow.json', sha256: digest(altered), bytes: altered.length };
    assert.throws(() => validateRecoveryInput(evidence, archive, altered, tool), /prescribed empty synthetic flow/);
  }
});

test('candidate recovery requires a stopped successful consumer with exact source and installed identity', () => {
  const pin = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const value = { ...receipt(), integrity: pin, tarball: { observedIntegrity: pin }, declaredArtifactSourceRevision: 'c'.repeat(40), shutdown: { launcherExit: { code: 1 }, loopbackPortClosed: true } };
  assert.equal(validateRecoveryTarget(value, tool), value);
  for (const change of [{ shutdown: {} }, { shutdown: { launcherExit: { code: 0 }, loopbackPortClosed: false } },
    { declaredArtifactSourceRevision: 'unknown' }, { toolRevision: 'different' }, { sourceCleanAfter: false },
    { installedManifest: { name: 'flujo-ai', version: '3.46.3' } }, { tarball: { observedIntegrity: 'different' } },
    { schemaVersion: 2 }, { integrity: 'invalid', tarball: { observedIntegrity: 'invalid' } }]) {
    assert.throws(() => validateRecoveryTarget({ ...value, ...change }, tool), /Candidate consumer/);
  }
});

test('existing-root upgrade rejects equal, downgraded and malformed versions before any launch', () => {
  for (const version of ['3.46.2', '3.46.1', '03.47.0', '9007199254740992.0.0']) {
    assert.throws(() => upgradeExistingRoot({ receipt: { version: '3.46.2' } }, { receipt: { version } }), /greater candidate/);
  }
});

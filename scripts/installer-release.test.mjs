import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { INSTALLER_FILE, INSTALLER_EVIDENCE_FILE, INSTALLER_CHECKSUM_FILE, installerSourceContext,
  writeInstallerEvidence, validateInstallerEvidence, verifyInstallerAttestations, writeInstallerDigest } from './installer-release.mjs';
import { assertWorkflowContract } from './workflow-contract.mjs';

const revision = 'a'.repeat(40);
const version = '3.46.3';
const context = { repository: 'mario-andreschak/FLUJO', revision, checkout: revision,
  ref: `refs/tags/v${version}`, version, workflowRef: `mario-andreschak/FLUJO/.github/workflows/installer.yml@refs/tags/v${version}`,
  workflowSha: revision };

function fixture(t) {
  const temporary = realpathSync.native(os.tmpdir());
  const directory = realpathSync.native(mkdtempSync(path.join(temporary, 'flujo-installer-provenance-')));
  t.after(() => {
    const relative = path.relative(temporary, realpathSync.native(directory));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    rmSync(directory, { recursive: true, force: true });
  });
  // Synthetic bytes are never executed or represented as a compiled installer.
  writeFileSync(path.join(directory, INSTALLER_FILE), 'MZ synthetic bootstrapper fixture');
  const evidence = writeInstallerEvidence({ directory, context: { ...context, unrelatedSecret: 'private-fixture-value' } });
  return { directory, revision, version, expectedDigest: evidence.artifact.sha256, evidence };
}

test('installer inventory binds executable bytes to the exact tag/source without exporting other context', (t) => {
  const f = fixture(t);
  assert.deepEqual(validateInstallerEvidence(f), f.evidence);
  assert.equal(f.evidence.artifact.filename, INSTALLER_FILE);
  assert.equal(f.evidence.workflow.revision, revision);
  assert.match(f.evidence.scope, /installed-consumer acceptance.*separate/);
  assert.doesNotMatch(readFileSync(path.join(f.directory, INSTALLER_EVIDENCE_FILE), 'utf8'), /private-fixture/);
  assert.equal(readFileSync(path.join(f.directory, INSTALLER_CHECKSUM_FILE), 'utf8').trim().split('\n').length, 2);
  assert.throws(() => writeInstallerEvidence({ directory: f.directory, context }), /EEXIST/);
});

test('actual digest CLI emits a complete UTF-8 GitHub file command for ordinary build bytes', (t) => {
  const f = fixture(t);
  const outputFile = path.join(f.directory, 'github-output.txt');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./installer-release.mjs', import.meta.url)), 'digest'], {
    cwd: f.directory, env: { ...process.env, INSTALLER_RELEASE_DIR: f.directory, GITHUB_OUTPUT: outputFile },
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const bytes = readFileSync(outputFile);
  assert.equal(bytes.toString('utf8'), `sha256=${f.expectedDigest}\n`);
  assert.equal(bytes.includes(0), false);
  assert.throws(() => writeInstallerDigest({ directory: f.directory }), /output file/);
  writeFileSync(path.join(f.directory, INSTALLER_FILE), '');
  assert.throws(() => writeInstallerDigest({ directory: f.directory, outputFile }), /nonempty/);
});

test('download verification CLI checks explicit release inputs without a checkout or CI environment', (t) => {
  const f = fixture(t);
  const execute = (inputs) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./installer-release.mjs', import.meta.url)), 'verify-download', ...inputs], {
      cwd: f.directory, env: { ...process.env, GITHUB_SHA: '', GITHUB_REF: '', GITHUB_REPOSITORY: '',
        GITHUB_WORKFLOW_REF: '', GITHUB_WORKFLOW_SHA: '', INSTALLER_RELEASE_DIR: 'unused-directory',
        EXPECTED_INSTALLER_SHA256: 'unused-digest' },
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Downloaded installer verified/);
    return result.stderr;
  };
  const inputs = [f.directory, revision, version, f.expectedDigest];
  for (const invalid of [inputs.slice(0, 3), [...inputs, 'extra']]) {
    assert.match(execute(invalid), /verify-download requires/);
  }
  for (const mismatched of [[f.directory, 'b'.repeat(40), version, f.expectedDigest],
    [f.directory, revision, '3.46.4', f.expectedDigest],
    [f.directory, revision, version, 'b'.repeat(64)]]) {
    assert.match(execute(mismatched), /does not match the original executable/);
  }
  writeFileSync(path.join(f.directory, INSTALLER_FILE), 'tampered synthetic installer');
  assert.match(execute(inputs), /does not match the original executable/);
});

for (const [name, change] of [
  ['another repository', { repository: 'other/project' }],
  ['another checkout', { checkout: 'b'.repeat(40) }],
  ['main instead of a release tag', { ref: 'refs/heads/main' }],
  ['another release version', { version: '3.46.2' }],
  ['another signer source', { workflowSha: 'b'.repeat(40) }],
  ['another workflow', { workflowRef: 'other/project/.github/workflows/installer.yml@refs/tags/v3.46.3' }],
]) {
  test(`installer context refuses ${name}`, () => {
    assert.throws(() => installerSourceContext({ ...context, ...change }));
  });
}

for (const file of [INSTALLER_FILE, INSTALLER_EVIDENCE_FILE, INSTALLER_CHECKSUM_FILE]) {
  test(`installer verification refuses altered and missing ${file}`, (t) => {
    const f = fixture(t);
    writeFileSync(path.join(f.directory, file), 'altered fixture');
    assert.throws(() => validateInstallerEvidence(f));
    rmSync(path.join(f.directory, file));
    assert.throws(() => validateInstallerEvidence(f));
  });
}

test('installer evidence cannot move to another original digest, source or version', (t) => {
  const f = fixture(t);
  for (const change of [{ expectedDigest: undefined }, { expectedDigest: 'b'.repeat(64) },
    { revision: 'b'.repeat(40) }, { version: '3.46.4' }]) {
    assert.throws(() => validateInstallerEvidence({ ...f, ...change }));
  }
  const copied = structuredClone(f.evidence);
  copied.workflow.revision = 'b'.repeat(40);
  writeFileSync(path.join(f.directory, INSTALLER_EVIDENCE_FILE), JSON.stringify(copied));
  assert.throws(() => validateInstallerEvidence(f));
});

test('both signature checks require official hosted workflow, source digest and exact tag', (t) => {
  const f = fixture(t);
  const calls = [];
  verifyInstallerAttestations({ ...f, run: (command, args) => {
    calls.push(args);
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.equal(args[args.indexOf('--repo') + 1], 'mario-andreschak/FLUJO');
    assert.equal(args[args.indexOf('--source-digest') + 1], revision);
    assert.equal(args[args.indexOf('--signer-digest') + 1], revision);
    assert.equal(args[args.indexOf('--source-ref') + 1], `refs/tags/v${version}`);
    assert.equal(args[args.indexOf('--signer-workflow') + 1], 'mario-andreschak/FLUJO/.github/workflows/installer.yml');
    assert.equal(args[args.indexOf('--cert-identity') + 1], `https://github.com/mario-andreschak/FLUJO/.github/workflows/installer.yml@refs/tags/v${version}`);
    assert.equal(args[args.indexOf('--cert-oidc-issuer') + 1], 'https://token.actions.githubusercontent.com');
    assert.ok(args.includes('--deny-self-hosted-runners'));
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((args) => path.basename(args[2])), [INSTALLER_FILE, INSTALLER_EVIDENCE_FILE]);
  let attempts = 0;
  assert.throws(() => verifyInstallerAttestations({ ...f, run: () => {
    if (++attempts === 2) throw new Error('metadata signature rejected');
  } }), /metadata signature rejected/);
  assert.equal(attempts, 2);
});

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url);
function workflows() {
  return Object.fromEntries(readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, YAML.parse(readFileSync(new URL(name, workflowsDirectory), 'utf8'))]));
}

test('installer workflow reuses immutable build bytes with tag-only signing/publication', () => {
  assertWorkflowContract(workflows());
});

for (const file of ['scripts/installer-release.mjs', 'scripts/installer-release.test.mjs']) {
  test(`installer workflow refuses omitting the ${file} validation trigger`, () => {
    const files = workflows();
    files['installer.yml'].on.pull_request.paths = files['installer.yml'].on.pull_request.paths.filter((name) => name !== file);
    assert.throws(() => assertWorkflowContract(files), /trigger hosted installer validation/);
  });
}

test('installer workflow refuses excluding its helper files from validation', () => {
  const files = workflows();
  files['installer.yml'].on.pull_request.paths.push('!scripts/**');
  assert.throws(() => assertWorkflowContract(files), /trigger hosted installer validation/);
});

for (const job of ['installer-attest', 'installer-publish']) {
  test(`${job} refuses an unavailable runner context in its job environment`, () => {
    const files = workflows();
    files['installer.yml'].jobs[job].env.INSTALLER_RELEASE_DIR = '${{ runner.temp }}/flujo-installer-release';
    assert.throws(() => assertWorkflowContract(files), /declared workspace artifact directory/);
  });

  test(`${job} refuses downloading outside the directory used for byte validation`, () => {
    const files = workflows();
    files['installer.yml'].jobs[job].steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
      .with.path = 'other-directory';
    assert.throws(() => assertWorkflowContract(files), /declared workspace artifact directory/);
  });
}

for (const [name, change] of [
  ['build publication authority', (jobs) => { jobs['installer-build'].permissions = { contents: 'write' }; }],
  ['signing on a pull request', (jobs) => { delete jobs['installer-attest'].if; }],
  ['mutable artifact selection', (jobs) => { delete jobs['installer-attest'].steps.find((s) => s.uses?.startsWith('actions/download-artifact@')).with['artifact-ids']; }],
  ['missing original digest', (jobs) => { delete jobs['installer-publish'].env.EXPECTED_INSTALLER_SHA256; }],
  ['publication without attestations', (jobs) => { jobs['installer-publish'].needs.pop(); }],
  ['optional byte validation', (jobs) => { jobs['installer-attest'].steps.find((s) => s.run === 'node scripts/installer-release.mjs validate')['continue-on-error'] = true; }],
  ['missing signature verification', (jobs) => { jobs['installer-publish'].steps = jobs['installer-publish'].steps.filter((s) => s.run !== 'node scripts/installer-release.mjs verify-signatures'); }],
  ['omitted final source check', (jobs) => { jobs['installer-publish'].steps = jobs['installer-publish'].steps.filter((s) => s.run !== 'node scripts/require-release-verification.mjs installer'); }],
  ['rebuilding before publication', (jobs) => { jobs['installer-publish'].steps.unshift({ run: 'npm run build' }); }],
]) {
  test(`installer workflow refuses ${name}`, () => {
    const files = workflows();
    change(files['installer.yml'].jobs);
    assert.throws(() => assertWorkflowContract(files));
  });
}

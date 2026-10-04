import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { assertWorkflowContract } from './workflow-contract.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const readWorkflows = () => Object.fromEntries(readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))
  .map((file) => [file, YAML.parse(readFileSync(new URL(file, directory), 'utf8'))]));

test('repository workflows retain mandatory verification and immutable direct action dependencies', () => {
  assertWorkflowContract(readWorkflows());
});

for (const [label, change] of [
  ['mutable action', (files) => { files['verify.yml'].jobs.typecheck.steps[0].uses = 'actions/checkout@main'; }],
  ['persisted checkout credentials', (files) => { files['verify.yml'].jobs.typecheck.steps[0].with['persist-credentials'] = true; }],
  ['broad default token', (files) => { files['verify.yml'].permissions.contents = 'write'; }],
  ['missing permission default', (files) => { delete files['verify.yml'].permissions; }],
  ['path-filtered PR', (files) => { files['verify.yml'].on.pull_request = { paths: ['src/**'] }; }],
  ['missing Windows', (files) => { files['verify.yml'].jobs['production-build'].strategy.matrix.os.pop(); }],
  ['optional matrix', (files) => { files['verify.yml'].jobs['production-build']['continue-on-error'] = true; }],
  ['conditional tests', (files) => { files['verify.yml'].jobs.test.if = 'false'; }],
  ['omitted packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => !step.run?.split('\n').includes('npm run smoke:mcp-artifacts')); }],
  ['skipped packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.run?.split('\n').includes('npm run smoke:mcp-artifacts')).if = 'false'; }],
  ['omitted installed private-profile checks', (files) => {
    files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps
      .filter((step) => step.run !== 'node --test scripts/installed-private-profile.test.mjs');
  }],
  ['late installed private-profile checks', (files) => {
    const steps = files['verify.yml'].jobs['production-build'].steps;
    const index = steps.findIndex((step) => step.run === 'node --test scripts/installed-private-profile.test.mjs');
    const [checks] = steps.splice(index, 1);
    steps.push(checks);
  }],
  ['conditional installed private-profile checks', (files) => {
    files['verify.yml'].jobs['production-build'].steps.find((step) => step.run === 'node --test scripts/installed-private-profile.test.mjs').if = 'false';
  }],
  ['optional installed private-profile checks', (files) => {
    files['verify.yml'].jobs['production-build'].steps.find((step) => step.run === 'node --test scripts/installed-private-profile.test.mjs')['continue-on-error'] = true;
  }],
  ['combined installed private-profile checks', (files) => {
    const build = files['verify.yml'].jobs['production-build'];
    build.steps = build.steps.filter((step) => step.run !== 'node --test scripts/installed-private-profile.test.mjs');
    build.steps.find((step) => step.run === 'npm run smoke:mcp-artifacts').run = 'node --test scripts/installed-private-profile.test.mjs\nnpm run smoke:mcp-artifacts';
  }],
  ['optional assertion baseline', (files) => { files['verify.yml'].jobs.test.steps.find((step) => step.run?.startsWith('npm run verify:test-baseline'))['continue-on-error'] = true; }],
  ['omitted final dependency', (files) => { files['verify.yml'].jobs.verification.needs.pop(); }],
  ['conditionally skipped final gate', (files) => { delete files['verify.yml'].jobs.verification.if; }],
  ['unverified selected checkout', (files) => { files['persona-browser-journey.yml'].jobs.journey.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref = '${{ inputs.commit_sha }}'; }],
  ['selected-release cache', (files) => { files['persona-browser-journey.yml'].jobs.journey.steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with.cache = 'npm'; }],
  ['late selected-source guard', (files) => {
    const steps = files['persona-browser-journey.yml'].jobs.journey.steps;
    const index = steps.findIndex((step) => step.name === 'Verify the selected trusted checkout');
    const [guard] = steps.splice(index, 1);
    steps.push(guard);
  }],
  ['detaching before ancestry verification', (files) => {
    const guard = files['persona-browser-journey.yml'].jobs.journey.steps.find((step) => step.name === 'Verify the selected trusted checkout');
    guard.run = guard.run.replace('git merge-base --is-ancestor "$PERSONA_JOURNEY_COMMIT" "$WORKFLOW_SHA"', 'git checkout --detach "$PERSONA_JOURNEY_COMMIT"');
  }],
]) {
  test(`workflow validation refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertWorkflowContract(files));
  });
}

function journeyGitFixture(t) {
  const tempRoot = realpathSync.native(os.tmpdir());
  const root = realpathSync.native(mkdtempSync(path.join(tempRoot, 'flujo-journey-trust-')));
  t.after(() => {
    const relative = path.relative(tempRoot, realpathSync.native(root));
    assert.equal(realpathSync.native(root), root);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (content) => {
    writeFileSync(path.join(root, 'fixture.txt'), content);
    git('add', 'fixture.txt');
    git('-c', 'user.name=FLUJO trust fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', content);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--initial-branch=trusted');
  const ancestor = commit('trusted ancestor');
  const workflowSha = commit('trusted workflow');
  git('checkout', '-b', 'unmerged', ancestor);
  const unmerged = commit('unmerged source');
  git('checkout', '--detach', workflowSha);
  const guard = readWorkflows()['persona-browser-journey.yml'].jobs.journey.steps.find((step) => step.name === 'Verify the selected trusted checkout').run;
  const bash = process.platform === 'win32'
    ? path.resolve(git('--exec-path'), '..', '..', '..', 'bin', 'bash.exe')
    : 'bash';
  const execute = (selected, expectedWorkflow = workflowSha) => {
    git('checkout', '--detach', workflowSha);
    const result = spawnSync(bash, ['-e', '-c', guard], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, WORKFLOW_SHA: expectedWorkflow, PERSONA_JOURNEY_COMMIT: selected },
    });
    assert.ifError(result.error);
    return result;
  };
  return { ancestor, workflowSha, unmerged, git, execute };
}

test('real selected-source guard accepts trusted workflow and ancestor checkouts', (t) => {
  const f = journeyGitFixture(t);
  for (const selected of [f.workflowSha, f.ancestor]) {
    const result = f.execute(selected);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git('rev-parse', 'HEAD'), selected);
  }
});

test('real selected-source guard refuses unmerged or mismatched source before detaching', (t) => {
  const f = journeyGitFixture(t);
  for (const [selected, workflow] of [[f.unmerged, f.workflowSha], [f.ancestor, f.unmerged]]) {
    const result = f.execute(selected, workflow);
    assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.workflowSha, 'rejected input cannot change the trusted checkout');
  }
});

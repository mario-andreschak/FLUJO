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
  ['YAML boolean-false required job', (files) => { files['verify.yml'].jobs.test.if = YAML.parse('if: false').if; }],
  ['omitted packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.17.0')).run = 'npm run build'; }],
  ['skipped packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.17.0')).if = 'false'; }],
  ['disabled real container probes', files => { delete files['verify.yml'].jobs.test.steps.find(step => step.run === 'npm run test:ci').env.FLUJO_RUN_ISOLATION_SOURCE_PROBE; }],
  ['missing Linux Docker preparation', files => { files['verify.yml'].jobs.test.steps = files['verify.yml'].jobs.test.steps.filter(step => step.name !== 'Prepare real Linux MCP isolation image'); }],
  ['optional Linux Docker preparation', files => { files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image')['continue-on-error'] = true; }],
  ['optional assertion baseline', (files) => { files['verify.yml'].jobs.test.steps.find((step) => step.run?.startsWith('npm run verify:test-baseline'))['continue-on-error'] = true; }],
  ['omitted final dependency', (files) => { files['verify.yml'].jobs.verification.needs.pop(); }],
  ['conditionally skipped final gate', (files) => { delete files['verify.yml'].jobs.verification.if; }],
  ['conditional CodeQL action', (files) => { files['verify.yml'].jobs.codeql.steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@')).if = 'false'; }],
  ['disabled CodeQL upload', (files) => { files['verify.yml'].jobs.codeql.steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@')).with.upload = 'never'; }],
  ['skipped CodeQL queries', (files) => { files['verify.yml'].jobs.codeql.steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@')).with['skip-queries'] = 'true'; }],
  ['reduced CodeQL query suite', (files) => { files['verify.yml'].jobs.codeql.steps.find((step) => step.uses?.startsWith('github/codeql-action/init@')).with.queries = 'security-default'; }],
  ['moving runtime selector', (files) => { files['verify.yml'].jobs.typecheck.steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with['node-version'] = '22'; }],
  ['wrong npm publication runtime', (files) => { files['publish-npm.yml'].jobs.prepare.steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with['node-version'] = '24.17.0'; }],
  ['missing official binary guard', (files) => { files['verify.yml'].jobs.typecheck.steps = files['verify.yml'].jobs.typecheck.steps.filter((step) => step.name !== 'Verify exact official Node runtime'); }],
  ['YAML boolean-false runtime setup', (files) => { files['verify.yml'].jobs.typecheck.steps.find(step => step.uses?.startsWith('actions/setup-node@')).if = YAML.parse('if: false').if; }],
  ['YAML boolean-false runtime guard', (files) => { files['verify.yml'].jobs.typecheck.steps.find(step => step.name === 'Verify exact official Node runtime').if = YAML.parse('if: false').if; }],
  ['optional binary guard', (files) => { files['publish-image.yml'].jobs.candidate.steps.find((step) => step.name === 'Verify exact official Node runtime')['continue-on-error'] = true; }],
  ['new unpinned release job', (files) => { files['installer.yml'].jobs['new-release-job'] = { steps: [{ run: 'node scripts/installer-release.mjs validate' }] }; }],
  ['Node command before verified selection', (files) => { files['verify.yml'].jobs.typecheck.steps.unshift({ run: 'npm ci --include=dev' }); }],
  ['minimum Node 24 profile omitted', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => step.with?.['node-version'] !== '24.2.0'); }],
  ['lost shell failure propagation', (files) => { delete files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 24.2.0')).shell; }],
  ['increased production heap', (files) => { files['verify.yml'].jobs['production-build'].env = { NODE_OPTIONS: '--max-old-space-size=8192' }; }],
  ['missing runtime evidence retention', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => step.name !== 'Retain exact runtime measurements'); }],
  ['omitted canonical runtime fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/node-runtime.test.mjs', ''); }],
  ['omitted scanner fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/scanner-workflow-contract.test.mjs', ''); }],
  ['omitted selector security fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/selector-parser-security.test.mjs', ''); }],
  ['omitted native probe fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/probe-filesystem-identity.test.mjs', ''); }],
  ['YAML boolean-false canonical fixture step', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find(step => step.run?.startsWith('node --test')).if = YAML.parse('if: false').if; }],
  ['filtered canonical runtime fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run += ' --test-name-pattern=embedding'; }],
  ['tolerated canonical runtime failure', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run += ' || true'; }],
  ['omitted Docs workflow', files => { delete files['scorecard-source.yml']; }],
  ['YAML boolean-false Docs job', files => { files['scorecard-source.yml'].jobs['scorecard-source'].if = YAML.parse('if: false').if; }],
  ['omitted Docs capture', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps = files['scorecard-source.yml'].jobs['scorecard-source'].steps.filter(step => !step.run?.includes('check-scorecard-ci.mjs')); }],
  ['optional Docs capture', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps.find(step => step.run?.includes('check-scorecard-ci.mjs'))['continue-on-error'] = true; }],
  ['skipped Docs capture', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps.find(step => step.run?.includes('check-scorecard-ci.mjs')).if = 'false'; }],
  ['YAML boolean-false Docs capture', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps.find(step => step.run?.includes('check-scorecard-ci.mjs')).if = YAML.parse('if: false').if; }],
  ['missing Docs binary guard', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps = files['scorecard-source.yml'].jobs['scorecard-source'].steps.filter(step => !step.run?.includes('verify-ci-node.mjs')); }],
  ['filtered Docs PR', files => { files['scorecard-source.yml'].on.pull_request = {paths:['docs/**']}; }],
  ['missing Docs Windows coverage', files => { files['scorecard-source.yml'].jobs['scorecard-source'].strategy.matrix.os.pop(); }],
  ['missing Docs source retention', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps = files['scorecard-source.yml'].jobs['scorecard-source'].steps.filter(step => step.with?.path !== '${{ runner.temp }}/scorecard-source-checks/'); }],
  ['missing Docs binary retention', files => { files['scorecard-source.yml'].jobs['scorecard-source'].steps = files['scorecard-source.yml'].jobs['scorecard-source'].steps.filter(step => step.with?.path !== 'ci-node-runtime/'); }],
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

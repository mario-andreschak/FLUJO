import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  assertContainerSmoke, assertContributorGuideJob, assertFullWorkflowContract, assertReleaseSweepReportsOnly, assertReleaseSweepRunsByDefault, assertWorkflowContract, CONTAINER_SMOKE_COMMAND, PACKAGED_ACCEPTANCE_TESTS, RELEASE_CONTAINER_SMOKE_COMMAND,
} from './workflow-contract.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const readWorkflows = () => Object.fromEntries(readdirSync(directory).filter((file) => /\.ya?ml$/.test(file) && file !== 'verify.yml')
  .map((file) => [file === 'verify-full.yml' ? 'verify.yml' : file, YAML.parse(readFileSync(new URL(file, directory), 'utf8'))]));

test('repository workflows retain mandatory verification and immutable direct action dependencies', () => {
  assertFullWorkflowContract(readWorkflows());
});

test('the main bridge runs genuine required jobs and the broad workflow remains manual', () => {
  const files = Object.fromEntries(readdirSync(directory).filter(file => /\.ya?ml$/.test(file))
    .map(file => [file, YAML.parse(readFileSync(new URL(file, directory), 'utf8'))]));
  assertWorkflowContract(files);
  assert.equal(files['verify.yml'].jobs['production-build'].strategy.matrix.os.length, 1);
  assert.equal(files['verify-full.yml'].jobs['production-build'].strategy.matrix.os.length, 2);
  assert.equal(files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run,
    files['verify-full.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run);
});

for (const [label, change] of [
  ['shallow installer decision checkout', files => { files['installer.yml'].jobs['powershell-tests'].steps[0].with['fetch-depth'] = 1; }],
  ['shallow clean Windows decision checkout', files => { files['installer.yml'].jobs['clean-windows'].steps[0].with['fetch-depth'] = 1; }],
  ['shallow pre-publication installer checkout', files => { files['verify.yml'].jobs['release-safety'].steps[0].with['fetch-depth'] = 1; }],
  ['missing pre-publication installer decisions', files => { files['verify.yml'].jobs['release-safety'].steps = files['verify.yml'].jobs['release-safety'].steps.filter(step => step.name !== 'Verify Windows installer decisions before publication'); }],
  ['skipped pre-publication installer decisions', files => { files['verify.yml'].jobs['release-safety'].steps.find(step => step.name === 'Verify Windows installer decisions before publication').if = 'false'; }],
  ['tolerated pre-publication installer decisions', files => { files['verify.yml'].jobs['release-safety'].steps.find(step => step.name === 'Verify Windows installer decisions before publication')['continue-on-error'] = true; }],
  ['unpinned pre-publication Pester', files => { const step = files['verify.yml'].jobs['release-safety'].steps.find(step => step.name === 'Verify Windows installer decisions before publication'); step.run = step.run.replaceAll('5.7.1', 'latest'); }],
  ['mutable action', (files) => { files['verify.yml'].jobs.typecheck.steps[0].uses = 'actions/checkout@main'; }],
  ['persisted checkout credentials', (files) => { files['verify.yml'].jobs.typecheck.steps[0].with['persist-credentials'] = true; }],
  ['broad default token', (files) => { files['verify.yml'].permissions.contents = 'write'; }],
  ['missing permission default', (files) => { delete files['verify.yml'].permissions; }],
  ['path-filtered PR', (files) => { files['verify.yml'].on.pull_request = {}; }],
  ['missing Windows', (files) => { files['verify.yml'].jobs['production-build'].strategy.matrix.os.pop(); }],
  ['floating Linux matrix runner', files => { files['verify.yml'].jobs['production-build']['runs-on'] = '${{ matrix.os }}'; }],
  ['floating direct Linux runner', files => { files['verify.yml'].jobs.test['runs-on'] = 'ubuntu-latest'; }],
  ['unqualified direct Linux runner', files => { files['verify.yml'].jobs.codeql['runs-on'] = 'ubuntu-26.04'; }],
  ['changed Windows matrix runner', files => { files['verify.yml'].jobs['release-safety']['runs-on'] = "${{ matrix.os == 'ubuntu-latest' && 'ubuntu-24.04' || 'ubuntu-24.04' }}"; }],
  ['additional matrix combinations', files => { files['verify.yml'].jobs['release-safety'].strategy.matrix.include = [{ os: 'ubuntu-latest' }]; }],
  ['excluded Windows matrix coverage', files => { files['verify.yml'].jobs['release-safety'].strategy.matrix.exclude = [{ os: 'windows-latest' }]; }],
  ['renamed required platform check', files => { files['verify.yml'].jobs['production-build'].name = 'Production build (${{ matrix.runner }})'; }],
  ['optional matrix', (files) => { files['verify.yml'].jobs['production-build']['continue-on-error'] = true; }],
  ['conditional tests', (files) => { files['verify.yml'].jobs.test.if = 'false'; }],
  ['YAML boolean-false required job', (files) => { files['verify.yml'].jobs.test.if = YAML.parse('if: false').if; }],
  ['omitted packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.23.4')).run = 'npm run build'; }],
  ['repeated production build', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.name?.endsWith('on Node 22.23.4')).run += 'npm run build\n'; }],
  ['repeated production install', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.name?.endsWith('on Node 22.23.4')).run += 'npm ci --include=dev\n'; }],
  ['skipped packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.23.4')).if = 'false'; }],
  ['unpaired production runtime guard', files => { delete files['verify.yml'].jobs['production-build'].steps.find(step => step.run === 'node scripts/verify-ci-node.mjs 22.23.4 --record').if; }],
  ['shallow production comparison checkout', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'] = 2; }],
  ['shallow historical fixture checkout', files => { files['verify.yml'].jobs['workflow-contract'].steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'] = 1; }],
  ['untrusted production comparison revision', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.id === 'application-change').env.HEAD_REVISION = '${{ github.event.pull_request.title }}'; }],
  ['omitted publisher syntax validation', files => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter(step => step.name !== 'Validate Worker publisher shell syntax'); }],
  ['disabled real container probes', files => { delete files['verify.yml'].jobs.test.steps.find(step => step.run === 'npm run test:ci').env.FLUJO_RUN_ISOLATION_SOURCE_PROBE; }],
  ['missing Linux Docker preparation', files => { files['verify.yml'].jobs.test.steps = files['verify.yml'].jobs.test.steps.filter(step => step.name !== 'Prepare real Linux MCP isolation image'); }],
  ['optional Linux Docker preparation', files => { files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image')['continue-on-error'] = true; }],
  ['unpinned isolation image', files => { files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run = files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run.replace("digest='sha256:", "digest='moving:"); }],
  ['unbounded registry retries', files => { files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run = files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run.replace('for attempt in 1 2; do', 'while true; do'); }],
  ['optional isolation image identity', files => { files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run = files['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run.replace('test -n "$image_ref"', 'true'); }],
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
  ['minimum Node 24 profile omitted', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => step.with?.['node-version'] !== '24.22.1'); }],
  ['lost shell failure propagation', (files) => { delete files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 24.22.1')).shell; }],
  ['increased production heap', (files) => { files['verify.yml'].jobs['production-build'].env = { NODE_OPTIONS: '--max-old-space-size=8192' }; }],
  ['missing runtime evidence retention', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => step.name !== 'Retain exact runtime measurements'); }],
  ['omitted canonical runtime fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/node-runtime.test.mjs', ''); }],
  ['omitted scanner fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/scanner-workflow-contract.test.mjs', ''); }],
  ['omitted selector security fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/selector-parser-security.test.mjs', ''); }],
  ['omitted native probe fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run = files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run.replace(' scripts/probe-filesystem-identity.test.mjs', ''); }],
  ['YAML boolean-false canonical fixture step', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find(step => step.run?.startsWith('node --test')).if = YAML.parse('if: false').if; }],
  ['filtered canonical runtime fixtures', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run += ' --test-name-pattern=embedding'; }],
  ['tolerated canonical runtime failure', (files) => { files['verify.yml'].jobs['workflow-contract'].steps.find((step) => step.run?.startsWith('node --test')).run += ' || true'; }],
  ['omitted installed npm package acceptance', files => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter(step => !step.run?.includes('packaged-acceptance.mjs')); }],
  ['installed npm package acceptance without upgrade', files => { const step = files['verify.yml'].jobs['production-build'].steps.find(step => step.run?.includes('packaged-acceptance.mjs')); step.run = step.run.replace(' --from npm:latest', ''); }],
  ['skipped release package acceptance', files => { files['publish-npm.yml'].jobs.prepare.steps.find(step => step.run?.includes('packaged-acceptance.mjs')).if = 'false'; }],
  ['release package acceptance after upload', files => { const steps = files['publish-npm.yml'].jobs.prepare.steps; const index = steps.findIndex(step => step.run?.includes('packaged-acceptance.mjs')); steps.push(...steps.splice(index, 1)); }],
  ['tolerated image acceptance', files => { files['publish-image.yml'].jobs.candidate.steps.find(step => step.run?.includes('packaged-acceptance.mjs'))['continue-on-error'] = true; }],
  ['image acceptance after push', files => { const steps = files['publish-image.yml'].jobs.candidate.steps; const index = steps.findIndex(step => step.run?.includes('packaged-acceptance.mjs')); steps.push(...steps.splice(index, 1)); }],
  ['installer acceptance on the wrong form', files => { const step = files['installer.yml'].jobs['installer-acceptance'].steps.find(step => step.run?.includes('packaged-acceptance.mjs')); step.run = step.run.replace('--form checkout', '--form npm'); }],
  ['omitted harness tests', files => { files['verify.yml'].jobs['release-safety'].steps = files['verify.yml'].jobs['release-safety'].steps.filter(step => step.run !== PACKAGED_ACCEPTANCE_TESTS); }],
  ['harness tests without the operator runbook tests', files => { const step = files['verify.yml'].jobs['release-safety'].steps.find(step => step.run === PACKAGED_ACCEPTANCE_TESTS); step.run = step.run.replace(' scripts/operator-runbook.test.mjs', ''); }],
  ['omitted operator runbook in the broad run', files => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter(step => !step.run?.includes('operator-runbook.mjs')); }],
  ['skipped operator runbook', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.run?.includes('operator-runbook.mjs')).if = 'false'; }],
  ['operator runbook after its report is kept', files => { const steps = files['verify.yml'].jobs['production-build'].steps; const index = steps.findIndex(step => step.run?.includes('operator-runbook.mjs')); steps.push(...steps.splice(index, 1)); }],
  ['release packages published without the operator runbook', files => { files['publish-npm.yml'].jobs.prepare.steps = files['publish-npm.yml'].jobs.prepare.steps.filter(step => !step.run?.includes('operator-runbook.mjs')); }],
  ['tolerated release operator runbook', files => { files['publish-npm.yml'].jobs.prepare.steps.find(step => step.run?.includes('operator-runbook.mjs'))['continue-on-error'] = true; }],
  ['omitted installed Windows build check', files => { delete files['verify.yml'].jobs['installed-windows-acceptance']; }],
  ['installed Windows build check on Linux', files => { files['verify.yml'].jobs['installed-windows-acceptance']['runs-on'] = 'ubuntu-24.04'; }],
  ['conditional installed Windows build check', files => { files['verify.yml'].jobs['installed-windows-acceptance'].if = 'false'; }],
  ['installed Windows build without compiling the installer', files => { files['verify.yml'].jobs['installed-windows-acceptance'].steps = files['verify.yml'].jobs['installed-windows-acceptance'].steps.filter(step => !step.run?.includes('flujo-setup.iss')); }],
  ['installed Windows build checked as an npm package', files => { const step = files['verify.yml'].jobs['installed-windows-acceptance'].steps.find(step => step.run?.includes('packaged-acceptance.mjs')); step.run = step.run.replace('--form checkout', '--form npm'); }],
  ['installed Windows build report not kept on failure', files => { delete files['verify.yml'].jobs['installed-windows-acceptance'].steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if; }],
  ['omitted Docker image check', files => { delete files['verify.yml'].jobs['image-acceptance']; }],
  ['tolerated Docker image check', files => { files['verify.yml'].jobs['image-acceptance'].steps.find(step => step.run?.includes('packaged-acceptance.mjs'))['continue-on-error'] = true; }],
  ['Docker image check without an upgrade', files => { const step = files['verify.yml'].jobs['image-acceptance'].steps.find(step => step.run?.includes('packaged-acceptance.mjs')); step.run = step.run.replace(/ --from \S+/, ''); }],
  ['Docker image check before the image is built', files => { const steps = files['verify.yml'].jobs['image-acceptance'].steps; const index = steps.findIndex(step => step.run?.includes('packaged-acceptance.mjs')); steps.unshift(...steps.splice(index, 1)); }],
  ['Docker image pushed instead of checked locally', files => { files['verify.yml'].jobs['image-acceptance'].steps.find(step => step.uses?.startsWith('docker/build-push-action@')).with.push = true; }],
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
    assert.throws(() => assertFullWorkflowContract(files));
  });
}

for (const [label, change] of [
  ['can push code', (sweep) => { sweep.jobs.sweep.permissions.contents = 'write'; }],
  ['can open pull requests', (sweep) => { sweep.jobs.report.permissions['pull-requests'] = 'write'; }],
  ['has a job without its own permissions', (sweep) => { delete sweep.jobs.sweep.permissions; }],
  ['runs FLUJO where it can file issues', (sweep) => { sweep.jobs.report.steps.push({ run: 'npm ci --include=dev' }); }],
]) {
  test(`the release sweep stays report-only: refuses a sweep that ${label}`, () => {
    const files = readWorkflows();
    assertReleaseSweepReportsOnly(files['release-sweep.yml']);
    change(files['release-sweep.yml']);
    assert.throws(() => assertFullWorkflowContract(files), /release-sweep\.yml\/(?:sweep|report) /);
  });
}

test('the release sweep workflow is strict YAML and needs only the built-in token with issues: write', () => {
  const text = readFileSync(new URL('release-sweep.yml', directory), 'utf8');
  const document = YAML.parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: true });
  assert.deepEqual([...document.errors, ...document.warnings].map(String), []);
  const sweep = document.toJS();
  assertReleaseSweepRunsByDefault(sweep);
  assert.deepEqual(sweep.permissions, { contents: 'read' });
  assert.deepEqual(Object.fromEntries(Object.entries(sweep.jobs).map(([id, job]) => [id, job.permissions])),
    { sweep: { contents: 'read' }, report: { contents: 'read', issues: 'write' } });
  const tokens = [...text.matchAll(/\$\{\{\s*([^}]*?(?:token|secrets)[^}]*?)\s*\}\}/g)].map((match) => match[1]);
  assert.deepEqual(tokens, ['github.token']);
  assert.ok(!/RELEASE_SWEEP/.test(text), 'the RELEASE_SWEEP switch is gone for good');
});

for (const [label, change] of [
  ['waits for a repository variable', (sweep) => { sweep.jobs.sweep.if = `vars.RELEASE_SWEEP == 'report' && ${sweep.jobs.sweep.if}`; }],
  ['files only when a variable says so', (sweep) => { sweep.jobs.report.steps.find((step) => step.name === 'File one issue per real problem').env.FILE_ISSUES = '${{ vars.RELEASE_SWEEP }}'; }],
  ['needs a secret', (sweep) => { sweep.jobs.report.steps.find((step) => step.name === 'File one issue per real problem').env.GH_TOKEN = '${{ secrets.SWEEP_PAT }}'; }],
  ['files only on request', (sweep) => { sweep.jobs.report.steps.find((step) => step.name === 'File one issue per real problem').if = "github.event_name == 'workflow_dispatch'"; }],
  ['only plans issues', (sweep) => {
    const step = sweep.jobs.report.steps.find((item) => item.name === 'File one issue per real problem');
    step.run = step.run.replace(' --file', '');
  }],
  ['has a job without a time limit', (sweep) => { delete sweep.jobs.sweep['timeout-minutes']; }],
  ['has a job that may run for hours', (sweep) => { sweep.jobs.report['timeout-minutes'] = 360; }],
  ['does not bound the sweep itself', (sweep) => {
    const step = sweep.jobs.sweep.steps.find((item) => item.id === 'sweep');
    step.run = step.run.replace(/ --total-timeout \d+/, '');
  }],
  ['is not started by releases', (sweep) => { delete sweep.on.workflow_run; }],
]) {
  test(`the release sweep runs after every release by default: refuses a sweep that ${label}`, () => {
    const files = readWorkflows();
    assertReleaseSweepRunsByDefault(files['release-sweep.yml']);
    change(files['release-sweep.yml']);
    assert.throws(() => assertFullWorkflowContract(files), /release-sweep\.yml/);
  });
}

const releaseGateCases = [
  ['image promotion without exact-commit verification', files => {
    const step = files['publish-image.yml'].jobs.publish.steps.find(item => item.run?.includes('image-release.mjs promote'));
    step.run = 'node scripts/image-release.mjs promote\n';
  }],
  ['npm signing before exact-commit verification', files => {
    const steps = files['publish-npm.yml'].jobs.attest.steps;
    const [gate] = steps.splice(steps.findIndex(step => step.run === 'node scripts/require-release-verification.mjs npm'), 1);
    steps.push(gate);
  }],
  ['conditional npm publication verification', files => {
    files['publish-npm.yml'].jobs.publish.steps.find(step => step.run === 'node scripts/require-release-verification.mjs npm').if = 'false';
  }],
  ['tolerated npm finalization verification', files => {
    files['publish-npm.yml'].jobs.finalize.steps.find(step => step.run === 'node scripts/require-release-verification.mjs npm')['continue-on-error'] = true;
  }],
  ['new release workflow without verification', files => {
    files['publish-extra.yml'] = { on: { workflow_dispatch: {} }, permissions: { contents: 'read' }, jobs: { release: {
      'runs-on': 'ubuntu-24.04', permissions: { contents: 'write' },
      steps: [{ uses: `softprops/action-gh-release@${'a'.repeat(40)}`, with: { files: 'x' } }],
    } } };
  }],
  ['stale release gate exception', files => { delete files['pages.yml']; }],
];

for (const [label, change] of releaseGateCases) {
  test(`release gate refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), /exact-commit main verification|no longer matches a job/);
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

for (const [label, change] of [
  ['omitted installed Codex checks', files => { const job = files['installer.yml'].jobs['installer-acceptance']; job.steps = job.steps.filter(step => !step.run?.includes('packaged-codex-acceptance.mjs')); }],
  ['tolerated installed Codex checks', files => { files['installer.yml'].jobs['installer-acceptance'].steps.find(step => step.run?.includes('packaged-codex-acceptance.mjs'))['continue-on-error'] = true; }],
  ['installed Codex checks after the evidence upload', files => { const steps = files['installer.yml'].jobs['installer-acceptance'].steps; const index = steps.findIndex(step => step.run?.includes('packaged-codex-acceptance.mjs')); steps.push(...steps.splice(index, 1)); }],
  ['omitted shipped Codex tests', files => { const job = files['verify.yml'].jobs['release-safety']; job.steps = job.steps.filter(step => step.run !== 'node --test scripts/packaged-codex-acceptance.test.mjs'); }],
]) {
  test(`workflow validation refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), /Codex checks/);
  });
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

test('production qualification reuses only CI-only changes and fails closed on application or invalid revisions', t => {
  const f = journeyGitFixture(t);
  const root = f.git('rev-parse', '--show-toplevel');
  const scope = readWorkflows()['verify.yml'].jobs['production-build'].steps.find(step => step.id === 'application-change').run;
  const bash = process.platform === 'win32' ? path.resolve(f.git('--exec-path'), '..', '..', '..', 'bin', 'bash.exe') : 'bash';
  const commitFile = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
    f.git('add', '--', file);
    f.git('-c', 'user.name=FLUJO CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', content);
    return f.git('rev-parse', 'HEAD');
  };
  const base = f.git('rev-parse', 'HEAD');
  const workflowHead = commitFile('.github/workflows/publish-cloud-worker.yml', 'workflow repair');
  const contractHead = commitFile('scripts/workflow-contract.mjs', 'CI contract repair');
  const applicationHead = commitFile('src/runtime.ts', 'application change');
  const output = path.join(root, 'scope-output.txt');
  const execute = (head, event = 'pull_request') => {
    writeFileSync(output, '');
    const result = spawnSync(bash, ['-e', '-c', scope], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: event, BASE_REVISION: base, HEAD_REVISION: head },
    });
    assert.ifError(result.error);
    return { result, output: readFileSync(output, 'utf8') };
  };
  for (const [head, event, expected] of [[workflowHead, 'pull_request', false], [contractHead, 'pull_request', false], [applicationHead, 'pull_request', true], [workflowHead, 'push', true]]) {
    const actual = execute(head, event);
    assert.equal(actual.result.status, 0, actual.result.stderr);
    assert.equal(actual.output.trim(), 'changed=' + expected);
  }
  const rejected = execute('invalid revision');
  assert.notEqual(rejected.result.status, 0);
  assert.equal(rejected.output, '');
});

test('Worker publisher scripts parse in Bash and reject the nested heredoc indentation regression', t => {
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const bash = process.platform === 'win32' ? path.resolve(git.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe') : 'bash';
  const steps = readWorkflows()['publish-cloud-worker.yml'].jobs.publish.steps.filter(step => step.shell === 'bash' && typeof step.run === 'string');
  for (const step of steps) {
    const result = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, step.name + ': ' + result.stderr);
  }
  const publish = steps.find(step => step.name === 'Publish the tested image without rebuilding').run;
  assert.ok(publish.includes('\nNODE\n'));
  const broken = spawnSync(bash, ['-n'], { input: publish.replace('\nNODE\n', '\n  NODE\n'), encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(broken.error);
  assert.notEqual(broken.status, 0);
  const tempRoot = realpathSync.native(os.tmpdir());
  const checkerTemp = realpathSync.native(mkdtempSync(path.join(tempRoot, 'flujo-publisher-syntax-')));
  t.after(() => {
    const relative = path.relative(tempRoot, realpathSync.native(checkerTemp));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(checkerTemp, { recursive: true, force: true });
  });
  const checker = readWorkflows()['verify.yml'].jobs['production-build'].steps.find(step => step.name === 'Validate Worker publisher shell syntax').run;
  const checked = spawnSync(bash, ['-e', '-c', checker], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, RUNNER_TEMP: checkerTemp },
  });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual isolation setup retries identical manifest mirrors and fails closed without an image', t => {
  const tempRoot = realpathSync.native(os.tmpdir());
  const root = realpathSync.native(mkdtempSync(path.join(tempRoot, 'flujo-isolation-mirrors-')));
  t.after(() => {
    const relative = path.relative(tempRoot, realpathSync.native(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(root, { recursive: true, force: true });
  });
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const bash = process.platform === 'win32' ? path.resolve(git.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe') : 'bash';
  const preparation = readWorkflows()['verify.yml'].jobs.test.steps.find(step => step.name === 'Prepare real Linux MCP isolation image').run;
  const image = `sha256:${'a'.repeat(64)}`;
  // Run the actual YAML with fixture commands; no real daemon or registry is used.
  const fixture = `
docker() {
  test "$1" = --host && test "$2" = unix:///var/run/docker.sock || return 2
  shift 2
  case "$1" in
    info) printf '%s\\n' linux/2 ;;
    pull)
      printf '%s\\n' "$2" >> "$PULL_LOG"
      test "\${2##*@}" = 'sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392' || return 2
      test "$MODE" = primary && return 0
      if test "$MODE" = mirror && [[ "$2" = public.ecr.aws/* ]]; then return 0; fi
      test "$MODE" = malformed && return 0
      return 1 ;;
    image)
      test "$2" = inspect || return 2
      if test "$MODE" = malformed; then printf '%s\\n' bogus; else printf '%s\\n' '${image}'; fi ;;
    *) return 2 ;;
  esac
}
sleep() { :; }
`;
  for (const [mode, expectedAttempts, expectedStatus] of [['primary', 1, 0], ['mirror', 3, 0], ['failed', 4, 1], ['malformed', 1, 1]]) {
    const envFile = path.join(root, `${mode}.env`);
    const pullLog = path.join(root, `${mode}.pulls`);
    writeFileSync(envFile, '');
    writeFileSync(pullLog, '');
    const result = spawnSync(bash, ['-e', '-c', fixture + preparation], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, MODE: mode, GITHUB_ENV: envFile, PULL_LOG: pullLog },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, `${mode}: ${result.stderr}`);
    const pulls = readFileSync(pullLog, 'utf8').trim().split('\n');
    assert.equal(pulls.length, expectedAttempts);
    for (const ref of pulls) assert.match(ref, /@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392$/);
    if (mode === 'mirror') assert.match(pulls.at(-1), /^public\.ecr\.aws\/docker\/library\/node:/);
    const output = readFileSync(envFile, 'utf8');
    if (expectedStatus === 0) assert.ok(output.includes(`FLUJO_TEST_ISOLATION_IMAGE=${image}\n`));
    else assert.equal(output, '', 'A failed pull or malformed image must not supply probe environment.');
  }
});

const antigravityJob = files => files['verify.yml'].jobs['antigravity-cli'];
const antigravityStep = (files, prefix) => antigravityJob(files).steps.find(step => step.run?.startsWith(prefix));
const journeyJob = files => files['verify.yml'].jobs['first-use-journey'];
const claudeCodeJob = files => files['verify.yml'].jobs['claude-code'];
const journeyStep = (files, prefix) => journeyJob(files).steps.find(step => step.run?.startsWith(prefix));
for (const [label, change, expected] of [
  ['a missing official Antigravity CLI job', files => { delete files['verify.yml'].jobs['antigravity-cli']; }, /official Antigravity CLI suite on macOS and Windows/],
  ['an Antigravity job without macOS', files => { antigravityJob(files).strategy.matrix.os = ['windows-latest']; }, /official Antigravity CLI suite/],
  ['an Antigravity job with extra matrix rows', files => { antigravityJob(files).strategy.matrix.include = [{ os: 'ubuntu-latest' }]; }, /official Antigravity CLI suite/],
  ['an optional Antigravity suite', files => { antigravityStep(files, 'node scripts/run-local-jest.cjs')['continue-on-error'] = true; }, /official Antigravity CLI suite/],
  ['a skipped Antigravity job', files => { antigravityJob(files).if = 'false'; }, /official Antigravity CLI suite/],
  ['an Antigravity suite filtered to fewer cases', files => { antigravityStep(files, 'node scripts/run-local-jest.cjs').run += ' -t effort'; }, /official Antigravity CLI suite/],
  ['an Antigravity suite run before the CLI is installed', files => {
    const steps = antigravityJob(files).steps;
    const [installer] = steps.splice(steps.findIndex(step => step.run?.includes('antigravity-runtime.cjs')), 1);
    steps.push(installer);
  }, /official Antigravity CLI suite/],
  ['an Antigravity job without the verified Node runtime', files => {
    antigravityJob(files).steps = antigravityJob(files).steps.filter(step => !step.run?.startsWith('node scripts/verify-ci-node.mjs'));
  }, /verify official binary identity/],
  ['a verification gate that ignores the Antigravity job', files => { const gate = files['verify.yml'].jobs.verification; gate.needs = gate.needs.filter(id => id !== 'antigravity-cli'); }, /evaluate every prerequisite/],
  ['a verification gate that ignores the installed Windows build check', files => { const gate = files['verify.yml'].jobs.verification; gate.needs = gate.needs.filter(id => id !== 'installed-windows-acceptance'); }, /evaluate every prerequisite/],
  ['a verification gate that ignores the Docker image check', files => { const gate = files['verify.yml'].jobs.verification; gate.needs = gate.needs.filter(id => id !== 'image-acceptance'); }, /evaluate every prerequisite/],
  ['a verification gate that ignores the first-use journey', files => { const gate = files['verify.yml'].jobs.verification; gate.needs = gate.needs.filter(id => id !== 'first-use-journey'); }, /evaluate every prerequisite/],
  ['a missing first-use journey', files => { delete files['verify.yml'].jobs['first-use-journey']; }, /first-use journey/],
  ['a skipped first-use journey', files => { journeyJob(files).if = 'false'; }, /first-use journey/],
  ['a first-use journey without the phone screen', files => {
    journeyJob(files).steps = journeyJob(files).steps.filter(step => !step.run?.includes('--viewport 390x844'));
  }, /first-use journey/],
  ['an optional first-use journey', files => { journeyStep(files, 'npm run journey:first-use')['continue-on-error'] = true; }, /first-use journey/],
  ['a first-use journey before the production build', files => {
    const steps = journeyJob(files).steps;
    const [build] = steps.splice(steps.findIndex(step => step.run === 'npm run build'), 1);
    steps.push(build);
  }, /first-use journey/],
  ['a first-use journey without the 128-tool app', files => {
    journeyJob(files).steps = journeyJob(files).steps.filter(step => !step.run?.includes('playwright.features-first-use.config.mjs'));
  }, /128-tool app/],
  ['a first-use journey without the tool tester check', files => {
    journeyJob(files).steps = journeyJob(files).steps.filter(step => !step.run?.includes('playwright.features.config.mjs'));
  }, /tool tester/],
  ['an optional tool tester check', files => {
    journeyStep(files, 'npx playwright test --config=playwright.features.config.mjs')['continue-on-error'] = true;
  }, /tool tester/],
  ['a 128-tool check against another build', files => {
    journeyStep(files, 'npx playwright test').env.FEATURE_BROWSER_APP_DIR = '/opt/old-flujo';
  }, /128-tool app/],
  ['a first-use journey that drops its evidence after a failure', files => {
    journeyJob(files).steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if = 'success()';
  }, /first-use journey/],
  ['a missing bundled Claude Code job', files => { delete files['verify.yml'].jobs['claude-code']; }, /bundled Claude Code suites/],
  ['a Claude Code job without macOS', files => { claudeCodeJob(files).strategy.matrix.os = ['windows-latest']; }, /bundled Claude Code suites/],
  ['a skipped Claude Code job', files => { claudeCodeJob(files).if = 'false'; }, /bundled Claude Code suites/],
  ['an optional Claude Code suite', files => { claudeCodeJob(files).steps.at(-1)['continue-on-error'] = true; }, /bundled Claude Code suites/],
  ['a Claude Code suite filtered to fewer cases', files => { claudeCodeJob(files).steps.at(-1).run += ' -t approvals'; }, /bundled Claude Code suites/],
  ['a Claude Code suite without the product check', files => {
    const step = claudeCodeJob(files).steps.at(-1);
    step.run = step.run.replace(' __tests__/chat/claudeFlowStandIn.test.ts', '');
  }, /bundled Claude Code suites/],
  ['a verification gate that ignores the Claude Code job', files => {
    const gate = files['verify.yml'].jobs.verification;
    gate.needs = gate.needs.filter(id => id !== 'claude-code');
  }, /evaluate every prerequisite/],
]) {
  test(`broad qualification refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), expected);
  });
}

const guideJob = files => files['verify.yml'].jobs['contributor-guide'];
const guideStep = (files, prefix) => guideJob(files).steps.find(step => step.run?.startsWith(prefix) || step.uses?.startsWith(prefix));
for (const [label, change, expected] of [
  ['a missing contributor guide job', files => { delete files['verify.yml'].jobs['contributor-guide']; }, /follow the contributor guide on Linux and macOS/],
  ['a contributor guide job without macOS', files => { guideJob(files).strategy.matrix.os = ['ubuntu-latest']; }, /follow the contributor guide/],
  ['a contributor guide job with extra matrix rows', files => { guideJob(files).strategy.matrix.include = [{ os: 'windows-latest' }]; }, /follow the contributor guide/],
  ['a contributor guide job that stops the other system on a failure', files => { guideJob(files).strategy['fail-fast'] = true; }, /follow the contributor guide/],
  ['a skipped contributor guide job', files => { guideJob(files).if = 'false'; }, /follow the contributor guide/],
  ['an optional walkthrough', files => { guideStep(files, 'node scripts/contributor-guide.mjs')['continue-on-error'] = true; }, /follow the contributor guide/],
  ['a conditional walkthrough', files => { guideStep(files, 'node scripts/contributor-guide.mjs').if = "runner.os == 'Linux'"; }, /follow the contributor guide/],
  ['a walkthrough with extra settings', files => { guideStep(files, 'node scripts/contributor-guide.mjs').env = { NODE_OPTIONS: '--max-old-space-size=8192' }; }, /follow the contributor guide/],
  ['a contributor guide job with job-wide settings', files => { guideJob(files).env = { FLUJO_DATA_DIR: '/tmp/flujo' }; }, /follow the contributor guide/],
  ['a shallow contributor guide checkout', files => { guideStep(files, 'actions/checkout@').with['fetch-depth'] = 1; }, /follow the contributor guide/],
  ['a walkthrough that does not keep its report', files => { guideStep(files, 'actions/upload-artifact@').if = 'success()'; }, /follow the contributor guide/],
  ['a walkthrough report kept from the wrong folder', files => { guideStep(files, 'actions/upload-artifact@').with.path = 'ci-node-runtime/'; }, /follow the contributor guide/],
  ['a walkthrough run before the runtime is verified', files => {
    const steps = guideJob(files).steps;
    const [walkthrough] = steps.splice(steps.findIndex(step => step.run?.startsWith('node scripts/contributor-guide.mjs')), 1);
    steps.splice(1, 0, walkthrough);
  }, /executes Node commands (?:before runtime verification|without)|follow the contributor guide/],
  ['a contributor guide job without the verified Node runtime', files => {
    guideJob(files).steps = guideJob(files).steps.filter(step => !step.run?.startsWith('node scripts/verify-ci-node.mjs'));
  }, /verify official binary identity/],
  ['a verification gate that ignores the contributor guide job', files => {
    files['verify.yml'].jobs.verification.needs = files['verify.yml'].jobs.verification.needs.filter(id => id !== 'contributor-guide');
  }, /evaluate every prerequisite/],
]) {
  test(`broad qualification refuses ${label}`, () => {
    const files = readWorkflows();
    assertContributorGuideJob(files['verify.yml']);
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), expected);
  });
}

test('the main pull-request bridge does not need the broad-only jobs, and the broad gate waits for them', () => {
  const files = Object.fromEntries(readdirSync(directory).filter(file => /\.ya?ml$/.test(file))
    .map(file => [file, YAML.parse(readFileSync(new URL(file, directory), 'utf8'))]));
  const broadOnly = ['antigravity-cli', 'installed-windows-acceptance', 'image-acceptance', 'system-key-store', 'system-key-store-linux', 'contributor-guide', 'first-use-journey', 'scripted-pilot', 'claude-code'];
  for (const id of broadOnly) assert.equal(files['verify.yml'].jobs[id], undefined, id);
  assert.deepEqual(files['verify-full.yml'].jobs.verification.needs.slice(-broadOnly.length), broadOnly);
});

const systemKeyJob = (files, id = 'system-key-store') => files['verify.yml'].jobs[id];
const systemKeyStep = (files, id, matches) => systemKeyJob(files, id).steps.find(matches);
const isSystemKeyCheck = step => step.run === 'node scripts/check-system-key-store.mjs';
const isKeyringInstall = step => step.run?.includes('apt-get install');
for (const [label, change, expected] of [
  ['a missing desktop system key job', files => { delete files['verify.yml'].jobs['system-key-store']; }, /real key store on macOS, Windows and Linux/],
  ['a missing Linux keyring job', files => { delete files['verify.yml'].jobs['system-key-store-linux']; }, /real key store/],
  ['a system key job without macOS', files => { systemKeyJob(files).strategy.matrix.os = ['windows-latest']; }, /real key store/],
  ['a system key job with extra matrix rows', files => { systemKeyJob(files).strategy.matrix.exclude = [{ os: 'macos-latest' }]; }, /real key store/],
  ['a system key job that stops other systems on the first failure', files => { systemKeyJob(files).strategy['fail-fast'] = true; }, /real key store/],
  ['a skipped Linux keyring job', files => { systemKeyJob(files, 'system-key-store-linux').if = 'false'; }, /real key store/],
  ['a tolerated failing system key check', files => { systemKeyStep(files, 'system-key-store', isSystemKeyCheck)['continue-on-error'] = true; }, /real key store/],
  ['a conditional system key check', files => { systemKeyStep(files, 'system-key-store-linux', isSystemKeyCheck).if = "runner.os == 'Linux'"; }, /real key store/],
  ['a system key check that turns the real store off', files => { systemKeyStep(files, 'system-key-store', isSystemKeyCheck).env = { FLUJO_SYSTEM_KEY_STORE: 'off' }; }, /real key store/],
  ['a system key check narrowed to one situation', files => { systemKeyJob(files, 'system-key-store-linux').env = { FLUJO_TEST_REAL_SYSTEM_KEY: 'absent' }; }, /real key store/],
  ['a replaced system key check', files => { systemKeyStep(files, 'system-key-store', isSystemKeyCheck).run = 'node scripts/check-system-key-store.mjs || true'; }, /real key store/],
  ['a Linux keyring job without the keyring', files => {
    const job = systemKeyJob(files, 'system-key-store-linux');
    job.steps = job.steps.filter(step => !isKeyringInstall(step));
  }, /real key store/],
  ['a Linux keyring installed after the check', files => {
    const steps = systemKeyJob(files, 'system-key-store-linux').steps;
    const [install] = steps.splice(steps.findIndex(isKeyringInstall), 1);
    steps.push(install);
  }, /real key store/],
  ['a system key check run before npm ci', files => {
    const steps = systemKeyJob(files).steps;
    const [check] = steps.splice(steps.findIndex(isSystemKeyCheck), 1);
    steps.splice(steps.findIndex(step => step.run === 'npm ci --include=dev'), 0, check);
  }, /real key store/],
  ['a system key job without the verified Node runtime', files => {
    systemKeyJob(files).steps = systemKeyJob(files).steps.filter(step => !step.run?.startsWith('node scripts/verify-ci-node.mjs'));
  }, /verify official binary identity/],
  ['a verification gate that ignores the Linux keyring job', files => {
    const gate = files['verify.yml'].jobs.verification;
    gate.needs = gate.needs.filter(id => id !== 'system-key-store-linux');
  }, /evaluate every prerequisite/],
]) {
  test(`broad qualification refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), expected);
  });
}

const containerSteps = (files) => files['verify.yml'].jobs.test.steps;
const containerStep = (files, test) => containerSteps(files).find(test);
const releaseSteps = (files) => files['publish-image.yml'].jobs.candidate.steps;
for (const [label, change, where] of [
  ['no container smoke on a main-target change', files => { files['verify.yml'].jobs.test.steps = containerSteps(files).filter(step => step.run !== CONTAINER_SMOKE_COMMAND); }, /verify\.yml\/test/],
  ['a skipped container smoke', files => { containerStep(files, step => step.run === CONTAINER_SMOKE_COMMAND).if = 'false'; }, /verify\.yml\/test/],
  ['a tolerated container smoke failure', files => { containerStep(files, step => step.run === CONTAINER_SMOKE_COMMAND)['continue-on-error'] = true; }, /verify\.yml\/test/],
  ['a container smoke on a pulled image', files => { containerStep(files, step => step.uses?.startsWith('docker/build-push-action@')).with.tags = 'ghcr.io/mario-andreschak/flujo:latest'; }, /verify\.yml\/test/],
  ['a container smoke before the image is built', files => {
    const steps = containerSteps(files);
    const [build] = steps.splice(steps.findIndex(step => step.uses?.startsWith('docker/build-push-action@')), 1);
    steps.push(build);
  }, /verify\.yml\/test/],
  ['a container smoke report kept only on success', files => { delete containerStep(files, step => step.with?.path === '${{ runner.temp }}/container-smoke/').if; }, /verify\.yml\/test/],
  ['a release image pushed without the container smoke', files => {
    files['publish-image.yml'].jobs.candidate.steps = releaseSteps(files).filter(step => step.run !== RELEASE_CONTAINER_SMOKE_COMMAND);
  }, /publish-image\.yml\/candidate/],
  ['a release container smoke after the push', files => {
    const steps = releaseSteps(files);
    const [smoke] = steps.splice(steps.findIndex(step => step.run === RELEASE_CONTAINER_SMOKE_COMMAND), 1);
    steps.push(smoke);
  }, /publish-image\.yml\/candidate/],
  ['a release container smoke on another image', files => { releaseSteps(files).find(step => step.run === RELEASE_CONTAINER_SMOKE_COMMAND).env.TESTED_IMAGE_ID = 'flujo:latest'; }, /publish-image\.yml\/candidate/],
]) {
  test(`the container smoke contract refuses ${label} (#1408)`, () => {
    const files = readWorkflows();
    assertContainerSmoke(files);
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), where);
  });
}

const pilotJob = files => files['verify.yml'].jobs['scripted-pilot'];
const pilotStep = (files, prefix) => pilotJob(files).steps.find(step => step.run?.startsWith(prefix) || step.uses?.startsWith(prefix));
for (const [label, change, expected] of [
  ['a missing scripted pilot job', files => { delete files['verify.yml'].jobs['scripted-pilot']; }, /scripted pilot/],
  ['a pilot without Windows', files => { pilotJob(files).strategy.matrix.os = ['ubuntu-24.04']; }, /scripted pilot/],
  ['a pilot with extra matrix rows', files => { pilotJob(files).strategy.matrix.include = [{ os: 'macos-latest' }]; }, /scripted pilot/],
  ['a skipped pilot job', files => { pilotJob(files).if = 'false'; }, /scripted pilot/],
  ['an optional pilot', files => { pilotStep(files, 'npm run pilot:scripted')['continue-on-error'] = true; }, /scripted pilot/],
  ['a pilot that only runs sometimes', files => { pilotStep(files, 'npm run pilot:scripted').if = "github.event_name == 'push'"; }, /scripted pilot/],
  ['a pilot on the development server', files => { pilotStep(files, 'npm run pilot:scripted').run = pilotStep(files, 'npm run pilot:scripted').run.replace('--mode start', '--mode dev'); }, /scripted pilot/],
  ['a pilot limited to one tester', files => { pilotStep(files, 'npm run pilot:scripted').run += ' --only p01-desk'; }, /scripted pilot/],
  ['a pilot run before the production build', files => {
    const steps = pilotJob(files).steps;
    const [build] = steps.splice(steps.findIndex(step => step.run === 'npm run build'), 1);
    steps.push(build);
  }, /scripted pilot/],
  ['a pilot whose result is lost when it fails', files => { delete pilotStep(files, 'actions/upload-artifact@').if; }, /scripted pilot/],
  ['a pilot whose result may be missing', files => { pilotStep(files, 'actions/upload-artifact@').with['if-no-files-found'] = 'warn'; }, /scripted pilot/],
  ['a pilot job without the verified Node runtime', files => {
    pilotJob(files).steps = pilotJob(files).steps.filter(step => !step.run?.startsWith('node scripts/verify-ci-node.mjs'));
  }, /verify official binary identity/],
  ['a verification gate that ignores the pilot', files => {
    const gate = files['verify.yml'].jobs.verification;
    gate.needs = gate.needs.filter(id => id !== 'scripted-pilot');
  }, /evaluate every prerequisite/],
]) {
  test(`broad qualification refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertFullWorkflowContract(files), expected);
  });
}

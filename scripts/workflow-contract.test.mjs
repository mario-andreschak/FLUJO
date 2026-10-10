import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { assertFullWorkflowContract, assertWorkflowContract } from './workflow-contract.mjs';

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
  ['mutable action', (files) => { files['verify.yml'].jobs.typecheck.steps[0].uses = 'actions/checkout@main'; }],
  ['persisted checkout credentials', (files) => { files['verify.yml'].jobs.typecheck.steps[0].with['persist-credentials'] = true; }],
  ['broad default token', (files) => { files['verify.yml'].permissions.contents = 'write'; }],
  ['missing permission default', (files) => { delete files['verify.yml'].permissions; }],
  ['path-filtered PR', (files) => { files['verify.yml'].on.pull_request = {}; }],
  ['missing Windows', (files) => { files['verify.yml'].jobs['production-build'].strategy.matrix.os.pop(); }],
  ['optional matrix', (files) => { files['verify.yml'].jobs['production-build']['continue-on-error'] = true; }],
  ['conditional tests', (files) => { files['verify.yml'].jobs.test.if = 'false'; }],
  ['YAML boolean-false required job', (files) => { files['verify.yml'].jobs.test.if = YAML.parse('if: false').if; }],
  ['omitted packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.17.0')).run = 'npm run build'; }],
  ['repeated production build', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.name?.endsWith('on Node 22.17.0')).run += 'npm run build\n'; }],
  ['repeated production install', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.name?.endsWith('on Node 22.17.0')).run += 'npm ci --include=dev\n'; }],
  ['skipped packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.name?.endsWith('on Node 22.17.0')).if = 'false'; }],
  ['unpaired production runtime guard', files => { delete files['verify.yml'].jobs['production-build'].steps.find(step => step.run === 'node scripts/verify-ci-node.mjs 22.17.0 --record').if; }],
  ['shallow production comparison checkout', files => { files['verify.yml'].jobs['production-build'].steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'] = 2; }],
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
    assert.throws(() => assertFullWorkflowContract(files));
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

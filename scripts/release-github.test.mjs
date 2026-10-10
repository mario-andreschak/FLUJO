import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchRelease, readReleaseWorkflow, resumeRelease, validateReleaseRun, watchRelease } from './release-github.mjs';

const SHA = 'a'.repeat(40);
const VERSION = '3.40.1';
const WORKFLOW_ID = 456;
const releaseRun = () => ({
  id: 123,
  repository: { full_name: 'mario-andreschak/FLUJO' },
  path: '.github/workflows/publish-npm.yml',
  workflow_id: WORKFLOW_ID,
  head_branch: 'main',
  event: 'workflow_dispatch',
  head_sha: SHA,
  display_title: `Release FLUJO ${VERSION} at ${SHA}`,
  status: 'completed',
  conclusion: 'failure',
});

test('a release retry is bound to its original official workflow, main revision and version', () => {
  const identity = validateReleaseRun(releaseRun(), WORKFLOW_ID);
  assert.equal(identity.sha, SHA);
  assert.equal(identity.version, VERSION);
});

for (const [label, mutate] of [
  ['fork repository', (run) => { run.repository.full_name = 'fork/FLUJO'; }],
  ['missing repository identity', (run) => { delete run.repository; }],
  ['different workflow ID', (run) => { run.workflow_id += 1; }],
  ['different workflow path', (run) => { run.path = '.github/workflows/verify.yml'; }],
  ['another branch', (run) => { run.head_branch = 'hackathon'; }],
  ['pull request event', (run) => { run.event = 'pull_request'; }],
  ['push event', (run) => { run.event = 'push'; }],
  ['malformed SHA', (run) => { run.head_sha = 'not-a-commit'; }],
  ['title from another revision', (run) => { run.head_sha = 'b'.repeat(40); }],
  ['missing release title', (run) => { delete run.display_title; }],
  ['unrelated workflow title', (run) => { run.display_title = 'Release all packages'; }],
  ['prerelease version title', (run) => { run.display_title = `Release FLUJO ${VERSION}-rc.1 at ${SHA}`; }],
  ['leading-zero version title', (run) => { run.display_title = `Release FLUJO 03.40.1 at ${SHA}`; }],
]) {
  test(`resume rejects ${label} before replaying any release jobs`, () => {
    const run = releaseRun();
    mutate(run);
    assert.throws(() => validateReleaseRun(run, WORKFLOW_ID));
  });
}

function githubFixture({ previous = [], next = [], details = releaseRun(), main = SHA, workflowState = 'active' } = {}) {
  const commands = [];
  let dispatched = false;
  const run = (command, args) => {
    commands.push({ command, args });
    assert.equal(command, 'gh');
    if (args[0] === 'api') {
      assert.ok(args[1].startsWith('repos/mario-andreschak/FLUJO/'));
      if (args[1].endsWith('/actions/workflows/publish-npm.yml')) {
        return JSON.stringify({ id: WORKFLOW_ID, path: '.github/workflows/publish-npm.yml', state: workflowState });
      }
      if (args[1].includes('/actions/workflows/456/runs?')) {
        assert.ok(args[1].includes(`head_sha=${SHA}`) && args[1].includes('event=workflow_dispatch') && args[1].includes('branch=main'));
        return JSON.stringify({ workflow_runs: dispatched ? next : previous });
      }
      if (args[1].includes('/actions/runs/')) return JSON.stringify(details);
      assert.ok(args[1].endsWith('/git/ref/heads/main'));
      return main;
    }
    if (args[0] === 'workflow') {
      assert.deepEqual(args.slice(0, 3), ['workflow', 'run', 'publish-npm.yml']);
      assert.equal(args[args.indexOf('--ref') + 1], 'main');
      assert.ok(args.includes(`expected_sha=${SHA}`) && args.includes(`version=${VERSION}`));
      dispatched = true;
      return '';
    }
    assert.equal(args[0], 'run');
    return '';
  };
  return { run, commands };
}

test('a duplicate release dispatch directs the caller to the original run without creating another artifact set', async () => {
  const github = githubFixture({ previous: [releaseRun()] });
  await assert.rejects(dispatchRelease({ run: github.run, sha: SHA, version: VERSION, wait: async () => {} }), /--resume 123/);
  assert.equal(github.commands.some(({ args }) => args[0] === 'workflow'), false);
});

test('a new dispatch returns only an authoritative run for the selected release identity', async () => {
  const github = githubFixture({ next: [releaseRun()] });
  assert.deepEqual(await dispatchRelease({ run: github.run, sha: SHA, version: VERSION, wait: async () => {} }), {
    sha: SHA, version: VERSION, runId: 123,
  });
  assert.equal(github.commands.filter(({ args }) => args[0] === 'workflow').length, 1);
});

test('a dispatch timeout does not automatically create a second release run', async () => {
  const github = githubFixture();
  let waits = 0;
  await assert.rejects(dispatchRelease({ run: github.run, sha: SHA, version: VERSION, wait: async () => { waits += 1; } }), /Inspect Actions.*do not create another version/);
  assert.ok(waits > 0);
  assert.equal(github.commands.filter(({ args }) => args[0] === 'workflow').length, 1);
});

test('an inactive release workflow cannot dispatch or resume a release', async () => {
  const github = githubFixture({ workflowState: 'disabled_manually' });
  assert.throws(() => readReleaseWorkflow(github.run));
  await assert.rejects(dispatchRelease({ run: github.run, sha: SHA, version: VERSION, wait: async () => {} }));
  assert.throws(() => resumeRelease({ run: github.run, runId: '123', checkoutSha: SHA, checkoutVersion: VERSION }));
  assert.equal(github.commands.some(({ args }) => args[0] !== 'api'), false);
});

for (const status of ['queued', 'in_progress', 'success']) {
  test(`resume does not rerun an original release that is ${status}`, () => {
    const details = releaseRun();
    if (status === 'success') details.conclusion = 'success';
    else details.status = status;
    const github = githubFixture({ details });
    assert.equal(resumeRelease({ run: github.run, runId: '123', checkoutSha: SHA, checkoutVersion: VERSION }).runId, 123);
    assert.equal(github.commands.some(({ args }) => args[0] === 'run' && args[1] === 'rerun'), false);
  });
}

test('a successful watch command still requires exact revision and successful GitHub run metadata', () => {
  const github = githubFixture();
  assert.throws(() => watchRelease({ run: github.run, identity: { sha: SHA, version: VERSION, runId: 123 } }), /exact-revision success/);
  assert.ok(github.commands.some(({ args }) => args[0] === 'run' && args[1] === 'watch' && args.includes('--exit-status')));
});

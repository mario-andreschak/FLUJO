import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchRelease, landVersionCommit, readReleaseWorkflow, resumeRelease, validateReleaseRun, watchRelease } from './release-github.mjs';

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

// --- Landing the version commit through a pull request -----------------------

function landingRepository(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'flujo-release-landing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const real = (args) => {
    const result = spawnSync('git', ['-C', directory, '-c', 'user.name=Release Test', '-c', 'user.email=release@test.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  real(['init', '-q']);
  const commit = (parent, files, message) => {
    if (parent) real(['checkout', '-q', '--detach', parent]);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), content);
    }
    real(['add', '-A']);
    real(['commit', '-q', '-m', message]);
    return real(['rev-parse', 'HEAD']);
  };
  const base = commit(null, { 'package.json': '{"version":"3.40.0"}\n', 'src/app/mcp-proxy/[server]/route.ts': "const v = '3.40.0';\n", 'README.md': 'docs\n' }, 'base');
  const bump = { 'package.json': `{"version":"${VERSION}"}\n`, 'src/app/mcp-proxy/[server]/route.ts': `const v = '${VERSION}';\n` };
  const local = commit(base, bump, 'local bump');
  // Another pull request merged first; GitHub squashes the bump on top of it.
  const moved = commit(base, { 'README.md': 'newer docs\n' }, 'unrelated');
  const merged = commit(moved, bump, 'squash');
  const tampered = commit(moved, { ...bump, 'src/extra.ts': 'export {};\n' }, 'squash with more');
  const remote = [];
  const git = (args) => (['push', 'fetch'].includes(args[0]) ? (remote.push(args), '') : real(args));
  return { git, remote, base, local, merged, tampered };
}

function pullRequests({ headRefOid, mergeCommit, prs = [], blocked = false, mergeAfterPolls = 0, closeAfterPolls = null }) {
  const calls = [];
  let polls = 0;
  let auto = false;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api') return '';
    const [, action, number] = args;
    if (action === 'list') {
      polls += 1;
      const open = prs.find((pr) => pr.state === 'OPEN');
      if (open && auto && closeAfterPolls !== null && polls > closeAfterPolls) open.state = 'CLOSED';
      else if (open && auto && polls > mergeAfterPolls) Object.assign(open, { state: 'MERGED', mergeCommit: { oid: mergeCommit } });
      return JSON.stringify(prs);
    }
    if (action === 'create') { prs.push({ number: 41, state: 'OPEN', headRefOid, mergeCommit: null }); return 'https://github.com/mario-andreschak/FLUJO/pull/41'; }
    assert.equal(action, 'merge');
    assert.ok(args.includes('--squash'));
    if (args.includes('--auto')) { auto = true; return ''; }
    if (blocked) throw new Error('the base branch policy prohibits the merge');
    Object.assign(prs.find((pr) => pr.number === Number(number)), { state: 'MERGED', mergeCommit: { oid: mergeCommit } });
    return '';
  };
  return { gh, calls };
}

test('a version commit lands through a squash-merged pull request even after main moved', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.merged });
  const merged = await landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base,
    wait: async () => assert.fail('a direct merge needs no polling') });
  assert.equal(merged, repo.merged);
  assert.deepEqual(repo.remote[0], ['push', 'origin', `${repo.local}:refs/heads/release/${VERSION}`], 'the branch push must never be forced');
  assert.equal(github.calls.filter(([, action]) => action === 'create').length, 1);
  const merge = github.calls.find(([, action]) => action === 'merge');
  assert.equal(merge[merge.indexOf('--subject') + 1], `Bump version to ${VERSION} (#41)`);
  assert.ok(github.calls.some((args) => args[0] === 'api' && args.includes('DELETE')), 'the release branch is cleaned up');
});

test('a blocked merge falls back to auto-merge and waits for GitHub to merge it', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.merged, blocked: true, mergeAfterPolls: 4 });
  let waits = 0;
  assert.equal(await landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base,
    wait: async () => { waits += 1; } }), repo.merged);
  assert.ok(github.calls.some((args) => args[1] === 'merge' && args.includes('--auto')));
  assert.ok(waits >= 1);
});

test('rerunning after the merge reuses the merged pull request without another push or merge', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.merged,
    prs: [{ number: 41, state: 'MERGED', headRefOid: repo.local, mergeCommit: { oid: repo.merged } }] });
  assert.equal(await landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base }), repo.merged);
  assert.equal(repo.remote.some(([command]) => command === 'push'), false);
  assert.equal(github.calls.some(([, action]) => action === 'create' || action === 'merge'), false);
});

test('a merged main commit with any change beyond the local version commit is refused', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.tampered });
  await assert.rejects(() => landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base }),
    /does not introduce exactly the local version change; nothing was published/);
});

test('a release pull request closed without merging stops the release', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.merged, blocked: true, mergeAfterPolls: Infinity, closeAfterPolls: 3 });
  await assert.rejects(() => landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base, wait: async () => {} }),
    /closed without merging/);
});

test('a release pull request that never merges stops at the deadline with resume guidance', async (t) => {
  const repo = landingRepository(t);
  const github = pullRequests({ headRefOid: repo.local, mergeCommit: repo.merged, blocked: true, mergeAfterPolls: Infinity });
  let elapsed = 0;
  await assert.rejects(() => landVersionCommit({ git: repo.git, gh: github.gh, version: VERSION, localSha: repo.local, baseSha: repo.base,
    timeoutMs: 60_000, now: () => elapsed, wait: async (delay) => { elapsed += delay; } }), /has not merged\. Merge it, then rerun npm run release/);
});

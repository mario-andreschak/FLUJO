import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_NEW_ISSUES, OVERFLOW_MARKER, fingerprintMarker, fingerprintsIn, planIssues, renderIssue, renderPlan, seenMarker } from './issues.mjs';
import { errorCategory, errorKey, normalizeError, problemsFromReport, runnerCause, runnerNotes } from './problems.mjs';
import { isTransientGhError, main, releasedAt, retryTransient, walkedEverything } from './report-issues.mjs';

const failedCheck = (overrides = {}) => ({
  id: 'settings/open-the-page', entry: 'settings', file: 'settings.md', entryTitle: 'Settings', label: 'Open the page',
  status: 'failed', confirmed: true, error: 'locator.waitFor: Timeout 60000ms exceeded.', url: '/settings',
  failedStep: {
    index: 1, total: 2, step: { do: 'wait-for', role: 'heading', name: 'Settings' },
    steps: [{ do: 'goto', route: '/settings' }, { do: 'wait-for', role: 'heading', name: 'Settings' }],
  },
  evidence: { screenshot: 'settings/open-the-page-failed.png', aria: 'settings/open-the-page-failed.aria.yml' },
  ariaExcerpt: '- heading "Something went wrong" [level=1]\n- button "Retry"',
  pageErrors: [], consoleErrors: [],
  ...overrides,
});

const report = (checks, extra = {}) => ({
  tool: 'release-sweep', target: { kind: 'release', version: '3.48.11' }, result: 'problems',
  entries: [{ entry: 'settings', file: 'settings.md', title: 'Settings', checks }], ...extra,
});

const manyChecks = (count) => Array.from({ length: count }, (_, index) => failedCheck({ id: `settings/check-${index + 1}`, label: `Check ${index + 1}` }));

/** The issues GitHub would hold after carrying out `actions` (what the next run reads back). */
function applyActions(known, actions) {
  let next = Math.max(100, ...known.map((issue) => issue.number)) + 1;
  const issues = known.map((issue) => ({ ...issue, comments: [...(issue.comments ?? [])] }));
  for (const action of actions) {
    if (action.type === 'create') issues.push({ number: next++, state: 'OPEN', body: action.issue.body, comments: [] });
    if (action.type === 'comment') issues.find((issue) => issue.number === action.number).comments.push({ body: action.body });
    if (action.type === 'close') Object.assign(issues.find((issue) => issue.number === action.number), { state: 'CLOSED', stateReason: 'COMPLETED' });
  }
  return issues;
}

test('errors are normalized so ports, ids, build hashes, numbers and hosts do not change the fingerprint', () => {
  assert.equal(
    normalizeError('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:53211/flows?x=1\nCall log: ...'),
    'page.goto: net::ERR_CONNECTION_REFUSED at /flows?…',
  );
  assert.equal(normalizeError('Chat 0f8fad5b-d9cb-469f-a165-70867728950e failed after 12 tries'), 'Chat <id> failed after # tries');
  assert.equal(normalizeError('Error at /_next/static/chunks/page-4f3a2b1c9d8e.js:1:2'), 'Error at /_next/static/chunks/page-<hash>.js:#:#');
  assert.equal(normalizeError('net::ERR_HTTP2_PROTOCOL_ERROR'), 'net::ERR_HTTP#_PROTOCOL_ERROR');
  assert.equal(errorKey('TypeError: e.map is not a function'), errorKey('TypeError: tn.map is not a function'));
  assert.equal(errorKey("ReferenceError: Cannot access 'n' before initialization"), errorKey("ReferenceError: Cannot access 'r' before initialization"));
  assert.notEqual(errorKey('TypeError: e.map is not a function'), errorKey('TypeError: e.filter is not a function'));
  assert.equal(errorCategory('locator.click: Timeout 30000ms exceeded.'), 'element missing');
  assert.equal(errorCategory('"Agent saved." did not appear on the page within 60s.'), 'text missing');
  assert.equal(errorCategory('The check took longer than 180s, the time a sweep gives one check.'), 'too slow');
});

test('fingerprints are stable across runs and releases, and pinned so open issues are never orphaned', () => {
  const first = problemsFromReport(report([failedCheck()]));
  const again = problemsFromReport(report([failedCheck({ error: 'locator.waitFor: Timeout 45000ms exceeded.', url: '/settings?x' })], { target: { kind: 'release', version: '3.48.12' } }));
  const otherStep = problemsFromReport(report([failedCheck({ failedStep: { ...failedCheck().failedStep, step: { do: 'click', role: 'button', name: 'Save' } } })]));
  const otherPage = problemsFromReport(report([failedCheck({ id: 'help/open-the-page' })]));
  assert.equal(first.length, 1);
  assert.equal(first[0].fingerprint, 'rs-99ebec1c01a8');
  assert.equal(again[0].fingerprint, first[0].fingerprint);
  assert.notEqual(otherStep[0].fingerprint, first[0].fingerprint);
  assert.notEqual(otherPage[0].fingerprint, first[0].fingerprint);

  const pageError = (message) => problemsFromReport(report([failedCheck({ status: 'passed', pageErrors: [message] })]))[0].fingerprint;
  assert.equal(pageError('TypeError: e.map is not a function at /_next/static/chunks/app-4f3a2b1c9d.js'), 'rs-10a5733c9f80');
  assert.equal(pageError('TypeError: t.map is not a function at /_next/static/chunks/app-91ab77c0e2.js'), 'rs-10a5733c9f80');
});

test('the same report always gives the same problems in the same order', () => {
  const input = report([...manyChecks(3), failedCheck({ id: 'settings/x', label: 'X', status: 'passed', pageErrors: ['Boom 1', 'Boom 2'] })]);
  assert.deepEqual(problemsFromReport(structuredClone(input)), problemsFromReport(structuredClone(input)));
  assert.deepEqual(problemsFromReport(input).map((problem) => problem.kind), ['step', 'step', 'step', 'page-error']);
});

test('one page error seen on several pages is one problem; a dead instance is one problem', () => {
  const problems = problemsFromReport(report([
    failedCheck({ status: 'passed', pageErrors: ['TypeError: x is undefined (at chunk 4411)'] }),
    failedCheck({ id: 'settings/switch-section', label: 'Switch section', status: 'passed', pageErrors: ['TypeError: x is undefined (at chunk 9)'] }),
  ], { instanceProblem: 'FLUJO stopped answering during settings/switch-section: ERR_CONNECTION_REFUSED' }));
  assert.deepEqual(problems.map((problem) => [problem.kind, problem.checks.length]), [['instance', 0], ['page-error', 2]]);
});

test('a sweep FLUJO could not start in becomes one problem that names the reason', () => {
  const [problem] = problemsFromReport({ tool: 'release-sweep', target: { version: '3.48.11' }, result: 'broken', brokenReason: 'FLUJO exited during startup.\nlog', entries: [] });
  assert.equal(problem.kind, 'broken');
  assert.match(renderIssue(problem, { version: '3.48.11' }).body, /could not test FLUJO 3\.48\.11[\s\S]*FLUJO exited during startup\./);
});

test('failures the sweep machine caused are recognised; FLUJO failures are not mistaken for them', () => {
  for (const message of [
    'ENOSPC: no space left on device, write',
    'spawn ENOMEM',
    'EMFILE: too many open files, open report.json',
    'browserType.launch: Executable doesn\'t exist at /home/runner/.cache/ms-playwright/chromium-1200/chrome',
    'browser.newContext: Target page, context or browser has been closed',
    'npm install flujo-ai@3.48.11 failed 3 times (exit 1):\nnpm error code ETARGET\nnpm error notarget No matching version found for flujo-ai@3.48.11.',
    'npm install flujo-ai@3.48.11 failed 3 times (exit 1):\nnpm error code ECONNRESET\nnpm error network aborted',
    'npm installed flujo-ai 3.48.10, not 3.48.11.',
    'npm-cli.js took longer than 900s.',
  ]) assert.ok(runnerCause(message), `should be the sweep machine: ${message}`);
  for (const message of [
    'FLUJO exited during startup. Last log lines:\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'npm install flujo-ai@3.48.11 failed 3 times (exit 1):\nnpm error 404 Not Found - GET https://registry.npmjs.org/flujo-ai-missing-dep - Not found',
    'locator.waitFor: Timeout 60000ms exceeded.',
    'FLUJO shows instead of the page: "Something went wrong"',
    'page.goto: Page crashed',
    'Could not confirm that http://127.0.0.1:5123/ keeps its data in a throwaway folder (/api/cwd: 500).',
  ]) assert.equal(runnerCause(message), undefined, `should be FLUJO: ${message}`);
});

test('the sweep machine\'s failures are never filed, only listed', () => {
  const machine = report([
    failedCheck({ error: 'ENOSPC: no space left on device, open settings/open-the-page-failed.png' }),
    failedCheck({ id: 'settings/b', label: 'B', status: 'runner', reason: "the sweep's browser stopped or would not start", error: 'Browser has been closed' }),
  ]);
  assert.deepEqual(problemsFromReport(machine), []);
  assert.deepEqual(runnerNotes(machine).map((note) => note.cause), ['the sweep machine ran out of disk space', "the sweep's browser stopped or would not start"]);

  const whole = { tool: 'release-sweep', target: { version: '3.48.11' }, result: 'runner', runnerCause: 'npm could not reach the registry', brokenReason: 'npm error network', entries: [] };
  assert.deepEqual(problemsFromReport(whole), []);
  assert.equal(runnerNotes(whole)[0].where, 'the whole sweep');
  const oldBroken = { ...whole, result: 'broken', runnerCause: undefined, brokenReason: 'npm installed flujo-ai 3.48.10, not 3.48.11.' };
  assert.deepEqual(problemsFromReport(oldBroken), []);
  const killed = report([failedCheck({ status: 'passed' })], { instanceProblem: 'FLUJO stopped answering during settings/a: spawn ENOMEM' });
  assert.deepEqual(problemsFromReport(killed), []);
  assert.equal(runnerNotes(killed).length, 1);
});

test('the issue text holds the step, error, proof, snapshot, a way to reproduce and the markers', () => {
  const [problem] = problemsFromReport(report([failedCheck({ retryError: 'locator.waitFor: Timeout 30000ms exceeded.' })]));
  const issue = renderIssue(problem, {
    version: '3.48.11', repo: 'owner/repo', runUrl: 'https://github.com/owner/repo/actions/runs/1',
    evidenceUrl: 'https://github.com/owner/repo/actions/runs/1/artifacts/2',
  });
  assert.equal(issue.title, 'Release sweep: Settings › Open the page fails (element missing)');
  assert.deepEqual(issue.labels, ['release-sweep', 'classification: BUG']);
  for (const expected of [
    'used FLUJO 3.48.11 like a person would',
    'failed twice in a row, each time in a fresh browser',
    '[`docs/feature-map/settings.md`](https://github.com/owner/repo/blob/main/docs/feature-map/settings.md)',
    '**Step:** Open the page (`settings/open-the-page`)',
    '**Failed at:** step 2 of 2, `wait-for heading Settings`',
    '**Error:** `locator.waitFor: Timeout 60000ms exceeded.`',
    '**Second try:** `locator.waitFor: Timeout 30000ms exceeded.`',
    '`settings/open-the-page-failed.png` and `settings/open-the-page-failed.aria.yml` in [the sweep\'s evidence files](https://github.com/owner/repo/actions/runs/1/artifacts/2)',
    '- heading "Something went wrong" [level=1]',
    'npm run release:sweep -- --release 3.48.11 --only settings',
    'Either FLUJO broke here, or the feature map step no longer matches the page.',
    fingerprintMarker(problem.fingerprint),
    seenMarker('3.48.11'),
  ]) assert.ok(issue.body.includes(expected), `missing: ${expected}\n\n${issue.body}`);
  assert.deepEqual(fingerprintsIn(issue.body), [problem.fingerprint]);
});

test('text from the page cannot break the issue layout', () => {
  const [problem] = problemsFromReport(report([failedCheck({ error: 'bad `code` here', ariaExcerpt: '````\nescaped' })]));
  const { body } = renderIssue(problem, { version: '1.0.0' });
  assert.ok(body.includes("`bad 'code' here`"));
  assert.ok(!body.includes('````\nescaped'));
});

test('dedup: a new problem is filed once, an open one gets one comment per release, never twice', () => {
  const problems = problemsFromReport(report([failedCheck(), failedCheck({ id: 'settings/other', label: 'Other' })]));
  const [known, fresh] = problems;
  const issues = [{ number: 7, body: `old text\n${fingerprintMarker(known.fingerprint)}`, comments: [] }];
  const plan = planIssues(problems, issues, { version: '3.48.11' });
  assert.deepEqual(plan.map((action) => [action.type, action.number ?? action.problem.fingerprint]), [['comment', 7], ['create', fresh.fingerprint]]);
  assert.match(plan[0].body, /Seen again in the release sweep of FLUJO 3\.48\.11/);
  const after = applyActions(issues, plan);
  assert.deepEqual(planIssues(problems, after, { version: '3.48.11' }).map((action) => action.type), ['skip', 'skip']);
  assert.deepEqual(planIssues(problems, after, { version: '3.48.12' }).map((action) => action.type), ['comment', 'comment']);
});

test('closed issues: not planned stays quiet, closed after the release gets a comment, closed before it is filed again with a link', () => {
  const problems = problemsFromReport(report([1, 2, 3, 4].map((n) => failedCheck({ id: `settings/c${n}`, label: `C${n}` }))));
  const [quiet, back, tooNew, unknown] = problems;
  const releasedAtDate = '2026-11-20T10:00:00Z';
  const issues = [
    { number: 3, state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-11-01T00:00:00Z', body: fingerprintMarker(quiet.fingerprint) },
    { number: 4, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-11-19T00:00:00Z', body: fingerprintMarker(back.fingerprint) },
    { number: 2, state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-10-01T00:00:00Z', body: fingerprintMarker(back.fingerprint) },
    { number: 5, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-11-21T00:00:00Z', body: fingerprintMarker(tooNew.fingerprint) },
    { number: 6, state: 'CLOSED', stateReason: 'COMPLETED', body: fingerprintMarker(unknown.fingerprint) },
  ];
  const plan = planIssues(problems, issues, { version: '3.48.11', releasedAt: releasedAtDate });
  assert.deepEqual(plan.map((action) => [action.type, action.number]), [['skip', 3], ['create', undefined], ['comment', 5], ['comment', 6]]);
  assert.match(plan[0].reason, /not planned in #3; reopen it/);
  assert.match(plan[1].issue.body, /^This came back after #4 was closed as done\./);
  assert.match(plan[2].body, /made before #5 was closed, so it cannot hold the fix yet/);
  const unknownRelease = planIssues([back], issues, { version: '3.48.11' });
  assert.deepEqual(unknownRelease.map((action) => [action.type, action.number]), [['comment', 4]], 'without a release date nothing is filed twice');
  const again = planIssues(problems, applyActions(issues, plan), { version: '3.48.11', releasedAt: releasedAtDate });
  assert.deepEqual(again.map((action) => action.type), ['skip', 'skip', 'skip', 'skip']);
});

test('the cap: at most MAX_NEW_ISSUES new issues per run, the rest in one summary issue that says how it clears', () => {
  const problems = problemsFromReport(report(manyChecks(MAX_NEW_ISSUES + 3)));
  const plan = planIssues(problems, [], { version: '3.48.11', walkComplete: true });
  const created = plan.filter((action) => action.type === 'create');
  assert.equal(created.length, MAX_NEW_ISSUES + 1);
  assert.equal(created.filter((action) => !action.overflow).length, MAX_NEW_ISSUES);
  assert.equal(plan.filter((action) => action.type === 'defer').length, 3);
  const summary = created.find((action) => action.overflow).issue;
  assert.equal(summary.title, 'Release sweep: 3 more problems in FLUJO 3.48.11 wait for their own issue');
  assert.ok(summary.body.includes(OVERFLOW_MARKER));
  assert.match(summary.body, /each following sweep opens issues for the next 5 problems/);
  assert.equal(fingerprintsIn(summary.body).length, 0, 'the summary issue must not claim the waiting fingerprints');
  for (const problem of problems.slice(MAX_NEW_ISSUES)) assert.ok(summary.body.includes(problem.fingerprint));
  assert.match(renderPlan(plan), /6 new, 0 seen again, 0 already noted, 3 waiting in the summary issue/);
});

test('the cap recovers by itself: later runs file what waits and close the summary issue', () => {
  const problems = problemsFromReport(report(manyChecks(2 * MAX_NEW_ISSUES + 2)));
  let issues = [];
  const run = (version, options = {}) => {
    const plan = planIssues(problems, issues, { version, walkComplete: true, ...options });
    issues = applyActions(issues, plan);
    return plan;
  };
  const types = (plan) => plan.map((action) => `${action.type}${action.overflow ? '-summary' : ''}`).sort();
  const first = run('3.48.11');
  assert.equal(first.filter((action) => action.type === 'create' && !action.overflow).length, MAX_NEW_ISSUES);
  assert.ok(types(first).includes('create-summary'));
  const second = run('3.48.12');
  assert.equal(second.filter((action) => action.type === 'create').length, MAX_NEW_ISSUES);
  assert.ok(types(second).includes('comment-summary'), 'the open summary issue gets a comment, not a twin');
  const incomplete = planIssues(problems.slice(0, 2 * MAX_NEW_ISSUES), issues, { version: '3.48.13', walkComplete: false });
  assert.ok(!incomplete.some((action) => action.type === 'close'), 'a sweep that did not walk every page leaves the summary issue open');
  const third = run('3.48.13');
  assert.equal(third.filter((action) => action.type === 'create').length, 2);
  assert.ok(types(third).includes('close'));
  assert.equal(issues.filter((issue) => issue.state === 'OPEN').length, problems.length);
  assert.equal(new Set(issues.flatMap((issue) => fingerprintsIn(issue.body))).size, problems.length, 'every problem has exactly one issue');
  assert.deepEqual(run('3.48.13').map((action) => action.type).filter((type) => type !== 'skip'), [], 'running the same release again changes nothing');
});

test('the plan does not depend on the order GitHub lists issues in', () => {
  const problems = problemsFromReport(report(manyChecks(4)));
  const issues = [
    { number: 9, state: 'OPEN', body: fingerprintMarker(problems[0].fingerprint) },
    { number: 12, state: 'OPEN', body: fingerprintMarker(problems[0].fingerprint) },
    { number: 4, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-01-01T00:00:00Z', body: fingerprintMarker(problems[1].fingerprint) },
    { number: 8, state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-02-01T00:00:00Z', body: fingerprintMarker(problems[1].fingerprint) },
  ];
  const options = { version: '3.48.11', releasedAt: '2026-11-01T00:00:00Z' };
  const forward = planIssues(problems, issues, options);
  assert.deepEqual(planIssues(problems, [...issues].reverse(), options), forward);
  assert.deepEqual(forward.map((action) => [action.type, action.number]), [['comment', 9], ['skip', 8], ['create', undefined], ['create', undefined]]);
});

test('the reporter is a dry run by default and never calls gh to write', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-sweep-issues-test-'));
  try {
    const file = path.join(folder, 'report.json');
    writeFileSync(file, JSON.stringify(report([failedCheck()])));
    const calls = [];
    const gh = (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'api') return '2026-11-20T10:00:00Z\n';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const lines = [];
    assert.equal(await main(['--report', file, '--repo', 'owner/repo'], { log: (line) => lines.push(line), gh, env: {}, sleep: () => {} }), 0);
    assert.deepEqual(calls, ['issue list', `api repos/owner/repo/commits/v3.48.11`]);
    const plan = readFileSync(path.join(folder, 'issues-plan.md'), 'utf8');
    assert.match(plan, /dry run: nothing was filed/);
    assert.match(plan, /## New issue: Release sweep: Settings › Open the page fails/);

    const written = [];
    const writer = (args, input) => {
      written.push([args.slice(0, 2).join(' '), input ? 'body' : '']);
      if (args[1] === 'list') return '[]';
      if (args[0] === 'api') return '2026-11-20T10:00:00Z\n';
      return args[1] === 'create' ? 'https://github.com/owner/repo/issues/9\n' : '';
    };
    assert.equal(await main(['--report', file, '--repo', 'owner/repo', '--file', '--evidence-url', ''], { log: () => {}, gh: writer, env: {}, sleep: () => {} }), 0);
    assert.deepEqual(written, [['issue list', ''], [`api repos/owner/repo/commits/v3.48.11`, ''], ['label list', ''], ['label create', ''], ['issue create', 'body']]);
    await assert.rejects(main(['--report', file, '--file', '--offline'], { log: () => {}, gh: writer, env: {} }), /only works for a dry run/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('filing stops when the existing issues cannot be read, so it never files duplicates', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-sweep-issues-test-'));
  try {
    const file = path.join(folder, 'report.json');
    writeFileSync(file, JSON.stringify(report([failedCheck()])));
    let reads = 0;
    const gh = () => { reads += 1; throw new Error('gh issue list failed: HTTP 502'); };
    await assert.rejects(main(['--report', file, '--repo', 'owner/repo', '--file'], { log: () => {}, gh, env: {}, sleep: () => {} }), /HTTP 502/);
    assert.equal(reads, 4, 'a GitHub hiccup is asked again before giving up');
    const lines = [];
    assert.equal(await main(['--report', file, '--repo', 'owner/repo'], { log: (line) => lines.push(line), gh, env: {}, sleep: () => {} }), 0);
    assert.match(lines.join('\n'), /Could not read the sweep's issues/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a failed write does not stop the others, and the run says the next sweep finishes the job', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-sweep-issues-test-'));
  try {
    const file = path.join(folder, 'report.json');
    writeFileSync(file, JSON.stringify(report(manyChecks(2))));
    const creates = [];
    const gh = (args) => {
      if (args[1] === 'list') return args[0] === 'label' ? '[{"name":"release-sweep"}]' : '[]';
      if (args[0] === 'api') return '2026-11-20T10:00:00Z';
      creates.push(args[1]);
      if (creates.length === 1) throw new Error('gh issue create failed: HTTP 502');
      return 'https://github.com/owner/repo/issues/10';
    };
    await assert.rejects(main(['--report', file, '--repo', 'owner/repo', '--file'], { log: () => {}, gh, env: {}, sleep: () => {} }),
      /1 of 2 GitHub writes failed; the next sweep does what is missing without filing twice/);
    assert.deepEqual(creates, ['create', 'create'], 'writes are never repeated within a run, but the rest still happen');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('GitHub reads are retried only for transient errors, with growing pauses', () => {
  const pauses = [];
  let calls = 0;
  assert.equal(retryTransient(() => { calls += 1; if (calls < 3) throw new Error('HTTP 503: Service Unavailable'); return 'ok'; }, { sleep: (ms) => pauses.push(ms) }), 'ok');
  assert.deepEqual(pauses, [2000, 4000]);
  assert.throws(() => retryTransient(() => { throw new Error('HTTP 404: Not Found'); }, { sleep: () => assert.fail('no pause for a lasting error') }), /404/);
  assert.ok(isTransientGhError('API rate limit exceeded'));
  assert.ok(!isTransientGhError('HTTP 403: Resource not accessible by integration'));
});

test('the release date comes from the version tag; no tag means unknown, not a failure', () => {
  assert.equal(releasedAt('owner/repo', '3.48.11', () => '2026-11-20T10:00:00Z\n', () => {}), '2026-11-20T10:00:00Z');
  assert.equal(releasedAt('owner/repo', '3.48.11', () => { throw new Error('gh api failed: HTTP 404: No commit found for SHA: v3.48.11'); }, () => {}), undefined);
  assert.equal(releasedAt('owner/repo', '3.48.11+local', () => assert.fail('a local build has no tag')), undefined);
  assert.throws(() => releasedAt('owner/repo', '3.48.11', () => { throw new Error('HTTP 401: Bad credentials'); }, () => {}), /401/);
});

test('nothing is filed for a run the sweep machine spoiled, and an open summary issue stays open', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-sweep-issues-test-'));
  try {
    const file = path.join(folder, 'report.json');
    writeFileSync(file, JSON.stringify({ tool: 'release-sweep', target: { kind: 'release', version: '3.48.11' }, result: 'runner', runnerCause: 'npm could not reach the registry', brokenReason: 'npm error network', entries: [] }));
    const gh = (args) => assert.fail(`no GitHub call expected: gh ${args.join(' ')}`);
    assert.equal(await main(['--report', file, '--repo', 'owner/repo', '--file'], { log: () => {}, gh, env: {}, sleep: () => {} }), 0);
    assert.match(readFileSync(path.join(folder, 'issues-plan.md'), 'utf8'), /Caused by the sweep machine, not filed[\s\S]*npm could not reach the registry/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the summary issue is closed only after a sweep that really reached every step', () => {
  assert.equal(walkedEverything(report([failedCheck(), failedCheck({ id: 'settings/b', status: 'passed' })])), true);
  assert.equal(walkedEverything(report([failedCheck({ status: 'not-run', reason: 'the sweep used its 60 minutes' })])), false);
  assert.equal(walkedEverything(report([failedCheck({ status: 'runner', reason: 'the sweep machine ran out of memory' })])), false);
  assert.equal(walkedEverything(report([failedCheck()], { instanceProblem: 'FLUJO stopped answering during settings/a: x' })), false);
  assert.equal(walkedEverything(report([], { result: 'broken' })), false);
});

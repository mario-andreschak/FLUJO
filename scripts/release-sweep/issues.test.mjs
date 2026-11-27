import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fingerprintMarker, fingerprintsIn, planIssues, renderIssue, renderPlan, seenMarker } from './issues.mjs';
import { errorCategory, normalizeError, problemsFromReport } from './problems.mjs';
import { main } from './report-issues.mjs';

const failedCheck = (overrides = {}) => ({
  id: 'settings/open-the-page', entry: 'settings', file: 'settings.md', entryTitle: 'Settings', label: 'Open the page',
  status: 'failed', error: 'locator.waitFor: Timeout 60000ms exceeded.', url: '/settings',
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

test('errors are normalized so ports, ids, numbers and hosts do not change the fingerprint', () => {
  assert.equal(
    normalizeError('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:53211/flows?x=1\nCall log: ...'),
    'page.goto: net::ERR_CONNECTION_REFUSED at /flows?…',
  );
  assert.equal(normalizeError('Chat 0f8fad5b-d9cb-469f-a165-70867728950e failed after 12 tries'), 'Chat <id> failed after # tries');
  assert.equal(errorCategory('locator.click: Timeout 30000ms exceeded.'), 'element missing');
  assert.equal(errorCategory('"Agent saved." did not appear on the page within 60s.'), 'text missing');
  assert.equal(errorCategory('The check took longer than 180s, the time a sweep gives one check.'), 'too slow');
});

test('the same failure in two runs has the same fingerprint; another step or page does not', () => {
  const first = problemsFromReport(report([failedCheck()]));
  const again = problemsFromReport(report([failedCheck({ error: 'locator.waitFor: Timeout 45000ms exceeded.', url: '/settings?x' })], { target: { version: '3.48.12' } }));
  const otherStep = problemsFromReport(report([failedCheck({ failedStep: { ...failedCheck().failedStep, step: { do: 'click', role: 'button', name: 'Save' } } })]));
  const otherPage = problemsFromReport(report([failedCheck({ id: 'help/open-the-page' })]));
  assert.equal(first.length, 1);
  assert.match(first[0].fingerprint, /^rs-[0-9a-f]{12}$/);
  assert.equal(again[0].fingerprint, first[0].fingerprint);
  assert.notEqual(otherStep[0].fingerprint, first[0].fingerprint);
  assert.notEqual(otherPage[0].fingerprint, first[0].fingerprint);
});

test('one page error seen on several pages is one problem; a dead instance is one problem', () => {
  const problems = problemsFromReport(report([
    failedCheck({ status: 'passed', pageErrors: ['TypeError: x is undefined (at chunk 4411)'] }),
    failedCheck({ id: 'settings/switch-section', label: 'Switch section', status: 'passed', pageErrors: ['TypeError: x is undefined (at chunk 9)'] }),
  ], { instanceProblem: 'FLUJO stopped answering during settings/switch-section: ERR_CONNECTION_REFUSED' }));
  assert.deepEqual(problems.map((problem) => [problem.kind, problem.checks.length]), [['instance', 0], ['page-error', 2]]);
});

test('a broken sweep becomes one problem that names the reason', () => {
  const [problem] = problemsFromReport({ tool: 'release-sweep', target: { version: '3.48.11' }, result: 'broken', brokenReason: 'FLUJO exited during startup.\nlog', entries: [] });
  assert.equal(problem.kind, 'broken');
  assert.match(renderIssue(problem, { version: '3.48.11' }).body, /could not test FLUJO 3\.48\.11[\s\S]*FLUJO exited during startup\./);
});

test('the dry-run issue text holds the step, error, evidence, snapshot, a way to reproduce and the markers', () => {
  const [problem] = problemsFromReport(report([failedCheck()]));
  const issue = renderIssue(problem, { version: '3.48.11', repo: 'owner/repo', runUrl: 'https://github.com/owner/repo/actions/runs/1' });
  assert.equal(issue.title, 'Release sweep: Settings › Open the page fails (element missing)');
  assert.deepEqual(issue.labels, ['release-sweep', 'classification: BUG']);
  for (const expected of [
    'used FLUJO 3.48.11 like a person would',
    '[`docs/feature-map/settings.md`](https://github.com/owner/repo/blob/main/docs/feature-map/settings.md)',
    '**Step:** Open the page (`settings/open-the-page`)',
    '**Failed at:** step 2 of 2, `wait-for heading Settings`',
    '**Error:** `locator.waitFor: Timeout 60000ms exceeded.`',
    '`settings/open-the-page-failed.png` and `settings/open-the-page-failed.aria.yml` in [the sweep\'s files](https://github.com/owner/repo/actions/runs/1)',
    '- heading "Something went wrong" [level=1]',
    'npm run release:sweep -- --only settings',
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
  const openIssues = [{ number: 7, body: `old text\n${fingerprintMarker(known.fingerprint)}`, comments: [] }];
  const plan = planIssues(problems, openIssues, { version: '3.48.11' });
  assert.deepEqual(plan.map((action) => [action.type, action.number ?? action.problem.fingerprint]), [['comment', 7], ['create', fresh.fingerprint]]);
  assert.match(plan[0].body, /Seen again in the release sweep of FLUJO 3\.48\.11/);
  openIssues[0].comments.push({ body: plan[0].body });
  assert.deepEqual(planIssues(problems, openIssues, { version: '3.48.11' }).map((action) => action.type), ['skip', 'create']);
});

test('a problem closed as not planned stays quiet; one closed as done that comes back is filed again with a link', () => {
  const problems = problemsFromReport(report([failedCheck(), failedCheck({ id: 'settings/other', label: 'Other' })]));
  const [quiet, back] = problems;
  const plan = planIssues(problems, [
    { number: 3, state: 'CLOSED', stateReason: 'NOT_PLANNED', body: fingerprintMarker(quiet.fingerprint) },
    { number: 4, state: 'CLOSED', stateReason: 'COMPLETED', body: fingerprintMarker(back.fingerprint) },
    { number: 2, state: 'CLOSED', stateReason: 'NOT_PLANNED', body: fingerprintMarker(back.fingerprint) },
  ], { version: '3.48.11' });
  assert.deepEqual(plan.map((action) => [action.type, action.number]), [['skip', 3], ['create', undefined]]);
  assert.match(plan[0].reason, /not planned in #3; reopen it/);
  assert.match(plan[1].issue.body, /^This came back after #4 was closed as done\./);
});

test('a run with many new problems files up to the cap and leaves the rest for the next run', () => {
  const problems = problemsFromReport(report([1, 2, 3].map((n) => failedCheck({ id: `settings/check-${n}`, label: `Check ${n}` }))));
  const plan = planIssues(problems, [], { version: '3.48.11', maxNew: 2 });
  assert.deepEqual(plan.map((action) => action.type), ['create', 'create', 'defer']);
  assert.match(renderPlan(plan), /2 new, 0 seen again, 0 already noted, 1 left for the next run/);
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
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const lines = [];
    assert.equal(await main(['--report', file, '--repo', 'owner/repo'], { log: (line) => lines.push(line), gh, env: {} }), 0);
    assert.deepEqual(calls, ['issue list']);
    const plan = readFileSync(path.join(folder, 'issues-plan.md'), 'utf8');
    assert.match(plan, /dry run: nothing was filed/);
    assert.match(plan, /## New issue: Release sweep: Settings › Open the page fails/);

    const written = [];
    const writer = (args, input) => {
      written.push([args.slice(0, 2).join(' '), input ? 'body' : '']);
      if (args[1] === 'list') return '[]';
      return args[1] === 'create' ? 'https://github.com/owner/repo/issues/9\n' : '';
    };
    assert.equal(await main(['--report', file, '--repo', 'owner/repo', '--file'], { log: () => {}, gh: writer, env: {} }), 0);
    assert.deepEqual(written, [['issue list', ''], ['label list', ''], ['label create', ''], ['issue create', 'body']]);
    await assert.rejects(main(['--report', file, '--file', '--offline'], { log: () => {}, gh: writer, env: {} }), /only works for a dry run/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('filing stops when the open issues cannot be read, so it never files duplicates', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'release-sweep-issues-test-'));
  try {
    const file = path.join(folder, 'report.json');
    writeFileSync(file, JSON.stringify(report([failedCheck()])));
    const gh = () => { throw new Error('gh issue list failed: HTTP 502'); };
    await assert.rejects(main(['--report', file, '--repo', 'owner/repo', '--file'], { log: () => {}, gh, env: {} }), /HTTP 502/);
    const lines = [];
    assert.equal(await main(['--report', file, '--repo', 'owner/repo'], { log: (line) => lines.push(line), gh, env: {} }), 0);
    assert.match(lines.join('\n'), /Could not read the sweep's issues/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { EVIDENCE_DIRECTORY } from './collect-release-evidence.mjs';
import {
  ACCEPTANCE, ROWS, judge, liveFacts, readLiveFacts, readSoak, readSourceFacts, renderReassessmentPage, securityResponders, summarize,
} from './release-reassessment.mjs';
import { waitForChecks, workflowState } from './wait-for-release-checks.mjs';

// The committed reassessment of 3.48.10 is the fixture: its inputs were read on
// the day it was assessed, so the tests change one input at a time.
const directory = fileURLToPath(new URL(`../${EVIDENCE_DIRECTORY}/`, import.meta.url));
const saved = JSON.parse(readFileSync(`${directory}v3.48.10.reassessment.json`, 'utf8'));
const lf = (text) => text.replace(/\r\n/g, '\n');
const withInputs = (change) => { const inputs = structuredClone(saved.inputs); change(inputs); return inputs; };
const status = (verdicts, id) => verdicts.checks.find((check) => check.id === id).status;
const detail = (verdicts, id) => verdicts.checks.find((check) => check.id === id).evidence;

test('every committed reassessment is judged again from its saved inputs, so none was edited by hand', () => {
  const files = readdirSync(directory).filter((file) => /^v\d+\.\d+\.\d+\.reassessment\.json$/.test(file));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const result = JSON.parse(readFileSync(`${directory}${file}`, 'utf8'));
    assert.deepEqual(judge(result.inputs), result.verdicts, `${file}: the verdicts no longer follow from the inputs`);
    assert.equal(renderReassessmentPage(result), lf(readFileSync(`${directory}${file.replace(/\.json$/, '.md')}`, 'utf8')),
      `${file.replace(/\.json$/, '.md')} differs from what the reviewer writes. Re-run: ${result.inputs.command}`);
  }
});

test('3.48.10 is judged at its own commit: evidence holds, but no row reaches A−', () => {
  const { verdicts, inputs } = saved;
  assert.equal(inputs.source.commit, inputs.evidence.commit, 'files were read at the release commit');
  for (const id of ['evidence-revision-bound', 'evidence-reproducible', 'evidence-redacted', 'release-ci']) assert.equal(status(verdicts, id), 'met', id);
  for (const id of ['alerts-at-release', 'installer-code-signing', 'installed-acceptance', 'offline-soak', 'live-runs']) assert.equal(status(verdicts, id), 'not-met', id);
  assert.equal(verdicts.acceptance.find((point) => point.id === 'evidence').status, 'met');
  assert.equal(verdicts.acceptance.find((point) => point.id === 'nine-rows').status, 'not-met');
  assert.equal(verdicts.rows.filter((row) => row.aMinusShown).length, 0);
  assert.ok(verdicts.rows.every((row) => row.checks.every((id) => verdicts.checks.some((check) => check.id === id))));
});

test('a soak that passed on the assessed commit meets the soak check; one from another commit does not', () => {
  const numbers = { days: 28, activitiesPerDay: 20, measuredDays: 28, maxAppendP95Ms: 12, maxRecallP95Ms: 30, peakRssBytes: 400e6, rssGrowthBytes: 20e6, errors: [] };
  const passed = judge(withInputs((inputs) => { inputs.soak = { commit: inputs.source.commit, passed: true, ...numbers }; }));
  assert.equal(status(passed, 'offline-soak'), 'met');
  assert.match(detail(passed, 'offline-soak'), /worst daily append p95 12 ms/);
  const other = judge(withInputs((inputs) => { inputs.soak = { commit: '1'.repeat(40), passed: true, ...numbers }; }));
  assert.equal(status(other, 'offline-soak'), 'not-met');
  assert.match(detail(other, 'offline-soak'), /ran on another commit/);
  const failed = judge(withInputs((inputs) => { inputs.soak = { commit: inputs.source.commit, passed: false, errors: ['flat-event-append-cost contradicts daily measurements'] }; }));
  assert.match(detail(failed, 'offline-soak'), /Failed .*flat-event-append-cost/);
});

test('people are counted from public data, and a fact that cannot be read is "Not checked", never met', () => {
  const people = judge(withInputs((inputs) => {
    inputs.facts.contributors.outsideHumans = 3;
    inputs.facts.maintainers = { error: 'HTTP 403: Resource not accessible by integration' };
  }));
  assert.equal(status(people, 'outside-contributors'), 'met');
  assert.equal(status(people, 'backup-maintainers'), 'not-checked');
  assert.match(detail(people, 'backup-maintainers'), /HTTP 403/);
  assert.equal(status(judge(withInputs((inputs) => { inputs.facts.criticalIssues = [{ number: 9, title: 'x' }]; })), 'critical-issues'), 'not-met');
});

test('an unsupported claim or a hidden limit fails the #578 points that guard them', () => {
  const claimed = judge(withInputs((inputs) => { inputs.files.docsClaims = [{ id: 'claim-production-ready', file: 'README.md', line: 3, detail: 'README.md:3 claims "production-ready".' }]; }));
  assert.equal(claimed.acceptance.find((point) => point.id === 'preserved').status, 'not-met');
  const hidden = judge(withInputs((inputs) => { inputs.files.docsClaims = []; }));
  assert.equal(hidden.acceptance.find((point) => point.id === 'limits-visible').status, 'met');
  assert.equal(hidden.acceptance.find((point) => point.id === 'preserved').status, 'met');
});

test('a row reaches A− only when every check behind it is met', () => {
  const ids = [...new Set([...ROWS.flatMap((row) => row.checks), ...ACCEPTANCE.flatMap((point) => point.checks ?? []),
    'full-checks', 'offline-soak', 'live-runs', 'status-page-current', 'provenance'])];
  const all = new Map(ids.map((id) => [id, { id, status: 'met' }]));
  const best = summarize(all);
  assert.ok(best.rows.every((row) => row.aMinusShown && row.verdict === 'A− criteria met'));
  assert.equal(best.acceptance.find((point) => point.id === 'nine-rows').status, 'met');
  all.set('backup-maintainers', { id: 'backup-maintainers', status: 'not-met' });
  const one = summarize(all);
  assert.equal(one.rows.find((row) => row.id === 'community').verdict, 'Below A−: held at the audit grade D until every check is met');
  assert.equal(one.rows.filter((row) => row.aMinusShown).length, 8);
  all.set('docs-limits-visible', { id: 'docs-limits-visible', status: 'not-met' });
  assert.match(summarize(all).rows.find((row) => row.id === 'docs').verdict, /^A not confirmed/);
});

test('security responders are GitHub handles on one line; project accounts do not count', () => {
  assert.equal(securityResponders('Security responders: none named yet'), 0);
  assert.equal(securityResponders('Security responders: @someone, @flujo-app and @Mario-Andreschak'), 1);
  assert.equal(securityResponders('Intro\nSecurity responder: @alice and @bob-2\n'), 2);
});

test('files are read at one commit: pilot sheets, hot spots, lint exceptions and core authors', async () => {
  const sheet = 'week,tester,report_received,used_flujo,finished_workflows,failed_workflows,used_connected_app,benefit,help_given,problem_codes,issue_numbers,flujo_version,install_method,stopped,stop_reason\n'
    + '1,p001,yes,yes,2,0,yes,time-saved,0,,,3.48.10,npm,no,\n';
  const firstRun = 'tester,date,minutes,finished,stopped_at,help_given,new_to_flujo,problem_codes\np001,2026-11-20,9,yes,,no,yes,\np002,2026-11-20,30,yes,,no,yes,\n';
  const files = {
    'docs/pilots/product-fit/tracking-sheet.csv': sheet,
    'docs/pilots/product-fit/first-run-sheet.csv': firstRun,
    'eslint-suppressions.json': JSON.stringify({ 'a.ts': { 'r/one': { count: 3 }, 'r/two': { count: 1 } } }),
    'src/backend/execution/flow/runFlow.ts': 'a\nb\n',
    '.github/workflows/publish-npm.yml': 'run: node scripts/packaged-acceptance.mjs --form npm --tarballs x',
    'SECURITY.md': 'Security responders: @alice, @bob',
  };
  const reader = {
    read: async (file) => files[file] ?? null,
    coreAuthors: async () => ['flujo-app', 'FLUJO', 'Someone Else', 'dependabot[bot]'],
  };
  const facts = await readSourceFacts(reader, { now: new Date('2026-11-28T00:00:00Z') });
  assert.deepEqual(facts.pilot, { testers: 1, weeks: 1, activeEveryWeek: 1, novices: 2, fastNovices: 1 });
  assert.equal(facts.lintExceptions, 4);
  assert.equal(facts.hotSpots[0].lines, 2);
  assert.equal(facts.hotSpots[1].lines, null);
  assert.deepEqual(facts.installedChecks.map((check) => check.present), [true, false, false]);
  assert.deepEqual(facts.coreChanges, { since: '2026-08-30', commits: 4, outsideAuthors: 1 });
  assert.equal(facts.securityResponders, 2);
});

test('an outside security review counts only as a list item with a link in its own section', async () => {
  const review = async (security) => (await readSourceFacts({ read: async (file) => (file === 'SECURITY.md' ? security : null), coreAuthors: async () => [] },
    { now: new Date('2026-11-28T00:00:00Z') })).independentSecurityReview;
  const none = '## Independent security review\n\nNone yet ([#578](https://github.com/x/y/issues/578)).\n';
  assert.equal(await review(none), false);
  assert.equal(await review(`${none}- [A reviewer, 2026-12-01](https://example.org/report)\n`), true);
  assert.equal(await review(`${none}\n## Other\n- [Not a review](https://example.org)\n`), false);
});

test('live facts read only through gh GET calls and keep counts, never names', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const target = args.find((arg) => arg.includes('/')) ?? '';
    if (target.startsWith('search/issues')) {
      return ['{"login":"flujo-app","type":"User"}', '{"login":"dependabot[bot]","type":"Bot"}', '{"login":"alice","type":"User"}',
        '{"login":"Alice","type":"User"}', '{"login":"mario-andreschak","type":"User"}'].join('\n');
    }
    if (target.includes('/collaborators')) return '{"login":"mario-andreschak","type":"User"}\n{"login":"flujo-app","type":"User"}\n';
    if (target.includes('/rules/branches/main')) return JSON.stringify([{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }]);
    if (target.includes('/code-scanning/')) throw Object.assign(new Error('exit 1'), { stderr: 'gh: Resource not accessible (HTTP 403)' });
    return '';
  };
  const facts = await readLiveFacts(liveFacts({ run, wait: () => {} }), { now: new Date('2026-11-28T00:00:00Z') });
  assert.deepEqual(facts.contributors, { since: '2026-08-30', mergedPullRequests: 5, outsideHumans: 1 });
  assert.deepEqual(facts.maintainers, { withWriteAccess: 2, outsideHumans: 0 });
  assert.deepEqual(facts.mergeRules, { pullRequest: true, approvals: 0, requiredChecks: 0 });
  assert.deepEqual(facts.criticalIssues, []);
  assert.match(facts.openCodeScanningAlerts.error, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(facts), /alice/i);
  for (const [command, sub, ...rest] of calls) {
    assert.equal(command, 'gh');
    assert.equal(sub, 'api');
    for (const flag of ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']) assert.ok(!rest.includes(flag), flag);
  }
});

test('missing soak artifacts are a failed soak, not a crash', async () => {
  const soak = await readSoak(fileURLToPath(new URL('../.no-such-soak-folder/', import.meta.url)), 'a'.repeat(40));
  assert.equal(soak.passed, false);
  assert.ok(soak.errors.length > 0);
  assert.equal(await readSoak(null, 'a'.repeat(40)), null);
});

test('the wait for release checks is bounded and never fails the release job', async () => {
  let clock = 0;
  const answers = { 'verify-full.yml': ['running', 'running', 'done'], 'scorecard-source.yml': ['none', 'none', 'none'] };
  const result = await waitForChecks({
    commit: 'a'.repeat(40), workflows: ['verify-full.yml', 'scorecard-source.yml'], startMinutes: 2, limitMinutes: 10,
    now: () => clock, wait: async (ms) => { clock += ms; }, state: async ({ workflow }) => answers[workflow].shift() ?? 'none', log: () => {},
  });
  assert.deepEqual(result, { 'verify-full.yml': 'done', 'scorecard-source.yml': 'none' });
  clock = 0;
  const stuck = await waitForChecks({ commit: 'b'.repeat(40), workflows: ['verify-full.yml'], limitMinutes: 3, now: () => clock,
    wait: async (ms) => { clock += ms; }, state: async () => 'running', log: () => {} });
  assert.deepEqual(stuck, { 'verify-full.yml': 'running' });
  assert.equal(clock, 3 * 60_000);
  assert.equal(await workflowState({ workflow: 'x.yml', commit: 'c', run: async () => { throw new Error('HTTP 502'); } }), 'running');
  assert.equal(await workflowState({ workflow: 'x.yml', commit: 'c', run: async () => '["completed","completed"]' }), 'done');
  await assert.rejects(waitForChecks({ commit: 'short', workflows: ['x.yml'] }), /full 40-character commit/);
});

test('the release evidence workflow runs after every npm release and needs nobody', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release-evidence.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Publish npm release'], types: ['completed'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const { release, soak, reassess, attach } = workflow.jobs;
  const text = (job) => job.steps.map((step) => `${step.run ?? ''} ${JSON.stringify(step.with ?? {})}`).join('\n');
  assert.match(text(release), /gh workflow run "\$workflow" --repo "\$GITHUB_REPOSITORY" --ref "v\$VERSION"/);
  assert.match(text(release), /verify-full\.yml scorecard-source\.yml/);
  assert.equal(soak.steps.find((step) => step.uses?.startsWith('actions/checkout')).with.ref, '${{ needs.release.outputs.commit }}');
  assert.match(text(soak), /run-persona-soak\.mjs --days=28 --activities-per-day=20 --with-learning --seed=459 --commit="\$COMMIT"/);
  assert.equal(reassess.if, "always() && needs.release.result == 'success'");
  assert.match(text(reassess), /wait-for-release-checks\.mjs --commit "\$COMMIT"/);
  assert.match(text(reassess), /collect-release-evidence\.mjs --version "\$VERSION"/);
  assert.match(text(reassess), /release-reassessment\.mjs --evidence "\$OUT\/v\$VERSION\.json" --source "\$COMMIT"/);
  assert.equal(reassess.permissions.contents, 'read', 'the reviewer itself can change nothing');
  assert.match(text(attach), /gh release upload "v\$VERSION"/);
  assert.deepEqual(attach.permissions, { contents: 'write', actions: 'read' });
  assert.equal(attach.steps.length, 2, 'the writing job only downloads the pages and attaches them');
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id !== 'attach') assert.notEqual(job.permissions?.contents, 'write', `${id} must not write`);
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40} ?$|@[0-9a-f]{40}$/, `${step.uses} is pinned to a commit`);
  }
});

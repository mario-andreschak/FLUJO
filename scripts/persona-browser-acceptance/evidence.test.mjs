import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { journeyTestTitle, journeySteps, validateJourneyReport } from './evidence.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const embed = (name, value) => ({ name, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)).toString('base64') });
function sample() {
  const identity = { commit: 'a'.repeat(40), runId: '123-1', buildId: 'test-build' };
  const before = { schemaVersion: 1, verdict: 'passed', identity, phase: 'before', observedAt: '2026-09-21T00:00:00Z' };
  const after = { ...before, phase: 'after', observedAt: '2026-09-21T00:01:00Z' };
  const observation = { mode: 'deterministic-browser-journey', qualityReview: 'not_evaluated',
    source: { commit: identity.commit, runId: identity.runId }, buildId: identity.buildId,
    steps: journeySteps.map((name, index) => ({ name, passedAt: `2026-09-21T00:00:${String(20 + index).padStart(2, '0')}Z` })),
    finalState: {
      persona: { id: 'persona-example', composition: { coreFlowRef: 'journey-core', behaviors: [{ name: 'Journey receipt specialist',
        binding: { mode: 'persona_copy', sharedFlowRef: 'journey-specialist', personaFlowRef: 'persona-copy' } }] } },
      appGrants: ['Journey receipt App', 'Journey replacement App'].map(mcpServerName => ({ mcpServerName })),
      memoryItems: [{ content: 'The journey meeting is on Tuesday.', status: 'superseded' }, { content: 'The journey meeting is on Wednesday.', status: 'forgotten' }],
      workItems: [{ title: 'Journey saved receipt', status: 'completed' }],
      activities: [{ kind: 'assignment', status: 'completed', outcome: { resolution: 'succeeded' } }],
    } };
  const cleanup = { epochs: [1, 2].map(pid => ({ pid, exitCode: 0, exitedAt: '2026-09-21T00:00:39Z' })),
    fixtureEvents: ['JOURNEY_CHAT', 'JOURNEY_TASK'].map(token => ({ kind: 'app_completed', token, receipt: `JOURNEY-APP-RECEIPT:${token}` })) };
  const result = { status: 'passed', retry: 0, errors: [], steps: journeySteps.map(title => ({ title })),
    attachments: [embed('journey-observations', observation), embed('journey-final-process-and-effect-record', cleanup)] };
  const run = { expectedStatus: 'passed', status: 'expected', results: [result] };
  const spec = { title: journeyTestTitle, file: 'journey.spec.mjs', ok: true, tests: [run] };
  const report = { errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, startTime: '2026-09-21T00:00:10Z', duration: 30_000 },
    suites: [{ specs: [spec] }] };
  const encode = () => { result.attachments = [embed('journey-observations', observation), embed('journey-final-process-and-effect-record', cleanup)]; };
  return { identity, before, after, observation, cleanup, result, run, spec, report, encode };
}
const validate = s => validateJourneyReport(s.report, s.identity, s.before, s.after);

test('accepts a complete, single-run embedded report with matching bracketed provenance', () => {
  const s = sample();
  assert.equal(validate(s).verdict, 'passed');
  s.report.suites = [{ suites: s.report.suites }];
  assert.equal(validate(s).requiredSteps, 9);
});

for (const [name, change] of [
  ['missing source check', s => { s.after = null; }],
  ['failed source check', s => { s.after.verdict = 'failed'; }],
  ['stale run identity', s => { s.observation.source.runId = 'older-run'; s.encode(); }],
  ['wrong commit', s => { s.observation.source.commit = 'b'.repeat(40); s.encode(); }],
  ['wrong build', s => { s.observation.buildId = 'other-build'; s.encode(); }],
  ['unbracketed run', s => { s.after.observedAt = '2026-09-21T00:00:15Z'; }],
  ['abbreviated commit', s => { s.identity.commit = 'abcdef'; }],
  ['skipped journey', s => { s.report.stats.expected = 0; s.report.stats.skipped = 1; }],
  ['retry', s => { s.result.retry = 1; }],
  ['multiple results', s => { s.run.results.push(s.result); }],
  ['expected failure', s => { s.run.expectedStatus = 'failed'; }],
  ['reporter error', s => { s.report.errors.push({ message: 'teardown failed' }); }],
  ['missing test step', s => { s.result.steps.pop(); }],
  ['swallowed nested step failure', s => { s.result.steps[0].steps = [{ title: 'nested', error: { message: 'failed' } }]; }],
  ['missing step observation', s => { s.observation.steps.pop(); s.encode(); }],
  ['step recorded after the run', s => { s.observation.steps[8].passedAt = '2026-09-21T00:00:55Z'; s.encode(); }],
  ['missing attachment', s => { s.result.attachments.pop(); }],
  ['untrusted attachment path', s => { delete s.result.attachments[0].body; s.result.attachments[0].path = '/private/file.json'; }],
  ['uncreated copy', s => { s.observation.finalState.persona.composition.behaviors[0].binding.mode = 'shared'; s.encode(); }],
  ['forgotten Memory not persisted', s => { s.observation.finalState.memoryItems[1].status = 'active'; s.encode(); }],
  ['unknown Task outcome', s => { s.observation.finalState.activities[0].outcome.resolution = 'unknown'; s.encode(); }],
  ['duplicate Task effect', s => { s.cleanup.fixtureEvents.push(s.cleanup.fixtureEvents[1]); s.encode(); }],
  ['fixture error', s => { s.cleanup.fixtureEvents.push({ kind: 'fixture_error' }); s.encode(); }],
  ['owned process still running', s => { s.cleanup.epochs[1].exitedAt = null; s.encode(); }],
]) test(`rejects ${name}`, () => { const s = sample(); change(s); assert.throws(() => validate(s)); });

function cleanupFixture(cwd) {
  assert.equal(path.dirname(path.resolve(cwd)), path.resolve(tmpdir()));
  assert.match(path.basename(cwd), /^persona-browser-evidence-/);
  rmSync(cwd, { recursive: true, force: true });
}

test('standalone validation fails closed and overwrites a stale passing summary', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'persona-browser-evidence-'));
  try {
    const s = sample();
    for (const [name, data] of [['report', s.report], ['source-before', s.before], ['source-after', s.after]]) writeFileSync(path.join(cwd, `${name}.json`), JSON.stringify(data));
    const args = [path.join(directory, 'validate.mjs'), '--directory', cwd, '--commit', s.identity.commit, '--run-id', s.identity.runId, '--build-id', s.identity.buildId];
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true }).status, 0);
    writeFileSync(path.join(cwd, 'report.json'), '{}');
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true }).status, 1);
    assert.equal(JSON.parse(readFileSync(path.join(cwd, 'acceptance.json'), 'utf8')).verdict, 'failed');
  } finally { cleanupFixture(cwd); }
});

test('source CLI rejects dirty or wrong-commit source and overwrites stale provenance', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'persona-browser-evidence-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    git('init');
    writeFileSync(path.join(cwd, '.gitignore'), '.next/\npersona-browser-artifacts/\n');
    writeFileSync(path.join(cwd, 'source.txt'), 'original');
    git('add', '.');
    git('-c', 'user.name=Persona test', '-c', 'user.email=persona@example.test', 'commit', '-m', 'fixture');
    mkdirSync(path.join(cwd, '.next'));
    writeFileSync(path.join(cwd, '.next/BUILD_ID'), 'test-build');
    const commit = git('rev-parse', 'HEAD');
    const args = [path.join(directory, 'check-source.mjs'), '--phase', 'before', '--commit', commit, '--run-id', '123-1'];
    const run = values => spawnSync(process.execPath, values, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(run(args).status, 0);
    writeFileSync(path.join(cwd, 'source.txt'), 'changed');
    assert.equal(run(args).status, 1);
    assert.equal(JSON.parse(readFileSync(path.join(cwd, 'persona-browser-artifacts/source-before.json'), 'utf8')).verdict, 'failed');
    writeFileSync(path.join(cwd, 'source.txt'), 'original');
    const wrongCommit = [...args]; wrongCommit[4] = 'b'.repeat(40);
    assert.equal(run(wrongCommit).status, 1);
  } finally { cleanupFixture(cwd); }
});

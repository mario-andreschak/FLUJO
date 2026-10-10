import assert from 'node:assert/strict';
import test from 'node:test';
import {assessScorecardCI, closureState, MINIMUM_SCORECARD_TESTS, parseTestCounts, parseValidationClock, scorecardTestArguments} from './scorecard-ci-contract.mjs';

const countText = () => `# tests ${MINIMUM_SCORECARD_TESTS}\n# pass ${MINIMUM_SCORECARD_TESTS}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
function fixture() {
  const source = {sha: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false};
  return {sourceStart: {...source}, sourceEnd: {...source}, workflowSha: source.sha,
    checks: ['tests', 'ledger', 'closure', 'publication'].map(name => ({name, command: name === 'tests' ? ['node', ...scorecardTestArguments()] : ['node'],
      exitCode: name === 'closure' ? 2 : 0, signal: null, errorCode: null,
      startedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:00:01.000Z',
      validationClock: ['ledger', 'closure'].includes(name) ? {source: 'wall-clock', epochMilliseconds: Date.parse('2026-10-04T00:00:00.500Z')} : null,
      testCounts: name === 'tests' ? parseTestCounts(countText()) : null}))};
}
test('complete direct results accept incomplete closure without awarding acceptance', () => {
  assert.equal(assessScorecardCI(fixture()).passed, true);
  assert.equal(closureState(2), 'incomplete');
  assert.equal(closureState(0), 'ledger-declares-closure');
  assert.equal(closureState(null), 'invalid');
  const complete = fixture(); complete.checks[2].exitCode = 0;
  assert.equal(assessScorecardCI(complete).passed, true);
});
test('TAP totals require exactly one safe whole count for every result category', () => {
  assert.equal(parseTestCounts(countText().replaceAll('\n', '\r\n')).tests, MINIMUM_SCORECARD_TESTS);
  for (const text of [countText().replace('# todo 0\n', ''), countText()+'# tests 1\n', countText().replace('# fail 0', '# fail 0.5'), countText().replace('# fail 0', '# fail 9007199254740992')]) assert.equal(parseTestCounts(text), null);
});
test('validation clock requires one retained numeric declaration', () => {
  assert.deepEqual(parseValidationClock('Validation clock: 123 (wall-clock)\r\n'), {epochMilliseconds:123, source:'wall-clock'});
  for (const text of ['', 'Validation clock: 123 (wall-clock)\nValidation clock: 124 (wall-clock)', 'Validation clock: 9007199254740992 (wall-clock)']) assert.equal(parseValidationClock(text), null);
});
for (const category of ['fail', 'cancelled', 'skipped', 'todo']) test(`CI refuses ${category} tests`, () => {
  const input=fixture(); input.checks[0].testCounts[category]=1;
  assert.equal(assessScorecardCI(input).passed,false);
});
test('CI refuses omitted, filtered or duplicated suites and insufficient assertions', () => {
  for (const change of [c => c.command.pop(), c => c.command.push('--test-name-pattern=happy'), c => c.command.push(c.command.at(-1)), c => {c.testCounts.tests=MINIMUM_SCORECARD_TESTS-1;c.testCounts.pass=c.testCounts.tests;}]) {
    const input=fixture();change(input.checks[0]);assert.equal(assessScorecardCI(input).passed,false);
  }
});
test('CI refuses missing or duplicated phases', () => {
  for (const change of [checks => checks.pop(), checks => checks.push({...checks[0]}), checks => {checks[3].name='tests';}]) {
    const input=fixture();change(input.checks);assert.equal(assessScorecardCI(input).passed,false);
  }
});
test('CI refuses signal, null exit, spawn error and closure exit 1', () => {
  for (const change of [c => {c.signal='SIGTERM';}, c => {c.exitCode=null;}, c => {c.errorCode='ETIMEDOUT';}, c => {c.exitCode=1;}]) {
    const input=fixture();change(input.checks[2]);assert.equal(assessScorecardCI(input).passed,false);
  }
});
test('CI refuses dirty, changed and workflow-mismatched source', () => {
  for (const change of [v => {v.sourceStart.dirty=true;}, v => {v.sourceEnd.dirty=true;}, v => {v.sourceEnd.sha='c'.repeat(40);}, v => {v.sourceEnd.tree='c'.repeat(40);}, v => {v.workflowSha='c'.repeat(40);}]) {
    const input=fixture();change(input);assert.equal(assessScorecardCI(input).passed,false);
  }
});
test('CI refuses absent, duplicate, overridden and out-of-window clocks', () => {
  for (const change of [c => {c.validationClock=null;}, c => {c.validationClock=parseValidationClock('Validation clock: 123 (wall-clock)\nValidation clock: 124 (wall-clock)');}, c => {c.validationClock.source='override';}, c => {c.validationClock.epochMilliseconds=Date.parse(c.finishedAt)+1;}, c => {c.validationClock.epochMilliseconds=Date.parse(c.startedAt)-1;}]) {
    const input=fixture();change(input.checks[1]);assert.equal(assessScorecardCI(input).passed,false);
  }
});

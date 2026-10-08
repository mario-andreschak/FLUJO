// Source checks only. These policies never establish external scorecard acceptance.
export const SCORECARD_TEST_SUITES = Object.freeze([
  'scripts/read-scorecard-evidence.test.mjs',
  'scripts/validate-scorecard.test.mjs',
  'scripts/check-scorecard-publication.test.mjs',
  'scripts/scorecard-ci-contract.test.mjs',
]);
export const MINIMUM_SCORECARD_TESTS = 99;
export const SCORECARD_CHECKS = Object.freeze(['tests', 'ledger', 'closure', 'publication']);
export const scorecardTestArguments = () => ['--test', '--test-reporter=tap', ...SCORECARD_TEST_SUITES];
export const closureState = exitCode => ({0: 'ledger-declares-closure', 2: 'incomplete'})[exitCode] ?? 'invalid';

export function parseTestCounts(stdout) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...stdout.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) return null;
    counts[name] = Number(matches[0][1]);
  }
  return counts;
}

export function parseValidationClock(stdout) {
  const matches = [...stdout.matchAll(/^Validation clock: (\d+) \((wall-clock|override)\)\r?$/gm)];
  if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) return null;
  return {epochMilliseconds: Number(matches[0][1]), source: matches[0][2]};
}

export function acceptsCheckExit(check) {
  return check.signal === null && check.errorCode === null && Number.isInteger(check.exitCode)
    && (check.name === 'closure' ? [0, 2] : [0]).includes(check.exitCode);
}

export function assessScorecardCI({sourceStart, sourceEnd, workflowSha = null, checks}) {
  const validSnapshot = snapshot => snapshot?.dirty === false
    && /^[a-f0-9]{40}$/.test(snapshot.sha) && /^[a-f0-9]{40}$/.test(snapshot.tree);
  const sameSource = validSnapshot(sourceStart) && validSnapshot(sourceEnd)
    && sourceStart.sha === sourceEnd.sha && sourceStart.tree === sourceEnd.tree;
  const workflowMatches = workflowSha === null || workflowSha === sourceStart?.sha;
  const completeChecks = Array.isArray(checks) && checks.length === SCORECARD_CHECKS.length
    && SCORECARD_CHECKS.every(name => checks.filter(check => check.name === name).length === 1);
  const tests = checks?.find(check => check.name === 'tests');
  const counts = tests?.testCounts;
  const completeSuiteSet = JSON.stringify(tests?.command?.slice(1)) === JSON.stringify(scorecardTestArguments());
  const allTestsCompleted = counts && Number.isSafeInteger(counts.tests) && counts.tests >= MINIMUM_SCORECARD_TESTS
    && counts.pass === counts.tests && ['fail', 'cancelled', 'skipped', 'todo'].every(name => counts[name] === 0);
  const clocksRetained = ['ledger', 'closure'].every(name => {
    const check = checks?.find(check => check.name === name);
    const clock = check?.validationClock;
    const start = Date.parse(check?.startedAt), end = Date.parse(check?.finishedAt);
    return clock?.source === 'wall-clock' && Number.isSafeInteger(clock.epochMilliseconds)
      && Number.isFinite(start) && Number.isFinite(end) && start <= clock.epochMilliseconds && clock.epochMilliseconds <= end;
  });
  const passed = Boolean(sameSource && workflowMatches && completeChecks && completeSuiteSet
    && allTestsCompleted && clocksRetained && checks.every(acceptsCheckExit));
  return {sameSource, workflowMatches, completeChecks, completeSuiteSet, allTestsCompleted: Boolean(allTestsCompleted), clocksRetained, passed};
}

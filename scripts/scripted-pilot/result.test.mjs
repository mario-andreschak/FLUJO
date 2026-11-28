import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDiagnosticReport, judgeTask, newErrors, plainResult, readReportCounts } from './result.mjs';

const REPORT = `FLUJO diagnostic report (format 1)
Created: 2026-11-27T10:00:00.000Z
Holds versions, counts and error counts only: no names, text, file paths, web addresses or keys.

FLUJO: 3.50.0 (git)
System: windows x64, Node.js 22.23.4, 8 CPU cores, 16 GB memory

AI connections: 1 (ollama 1)
Connected apps: 4, 4 enabled (stdio 4)
App states: connected 4
Agents: 2, 1 use connected apps, 3 steps in total

Last 7 days (2026-11-21 to 2026-11-27, UTC):
  Days with runs: 1
  Runs: 6 (finished 4, failed 0, stopped 0, paused 2, ended at a limit 0, unfinished 0)
  Tool calls: 6 (failed 0)
  AI requests: 9 (failed 0)
  Error types: none
`;

test('a task passes only with the result shown, in time, and without an error message', () => {
  assert.deepEqual(judgeTask({ limitSeconds: 60, seconds: 12 }), { passed: true, reasons: [] });
  const slow = judgeTask({ limitSeconds: 60, seconds: 61.4 });
  assert.equal(slow.passed, false);
  assert.match(slow.reasons[0], /61 seconds; the limit is 60/);
  const noisy = judgeTask({ limitSeconds: 60, seconds: 5, errors: ['Could not save'] });
  assert.deepEqual(noisy.reasons, ['An error message showed up: "Could not save"']);
  assert.equal(judgeTask({ limitSeconds: 60, seconds: 5, failure: 'No answer' }).reasons[0], 'No answer');
});

test('a task only answers for error messages that showed up while it ran', () => {
  assert.deepEqual(newErrors(['old'], ['old', 'new', 'new']), ['new']);
});

test('reads the counts a tester sees in the diagnostic report', () => {
  assert.deepEqual(readReportCounts(REPORT), { aiConnections: 1, apps: 4, agents: 2, agentsUsingApps: 1, runs: 6, toolCalls: 6, aiRequests: 9 });
});

test('the report must be complete, count the tester\'s work, and hold no private value', () => {
  assert.deepEqual(checkDiagnosticReport(REPORT, { expected: { runs: 1, toolCalls: 1 }, privateValues: ['C:\\Temp\\flujo-pilot-x', 'pocket-garden-042'] }), []);
  const leaked = checkDiagnosticReport(`${REPORT}Path: c:/temp/flujo-pilot-x/data\n`, { privateValues: ['C:\\Temp\\flujo-pilot-x'] });
  assert.match(leaked[0], /private value/);
  const partial = checkDiagnosticReport(`${REPORT}\nCould not read: activity\n`.replace('Runs: 6 (finished 4, failed 0, stopped 0, paused 2', 'Runs: 0 (finished 0, failed 0, stopped 0, paused 0'), { expected: { runs: 1 } });
  assert.deepEqual(partial, ['The report could not read: activity.', 'The report counts 0 runs; at least 1 expected.']);
  const uneven = checkDiagnosticReport(REPORT.replace('paused 2', 'paused 0'));
  assert.match(uneven[0], /counts 6 runs, but its parts add up to 4/);
  assert.match(checkDiagnosticReport('Something else')[0], /does not start/);
});

test('the plain-language result names every tester, task and failure reason', () => {
  const task = (id, passed, reasons = []) => ({ id, title: `Task ${id}`, passed, seconds: 30, limitSeconds: 120, reasons });
  const ok = plainResult({
    testers: [{ name: 'Tester p01', description: 'Wide screen.', tasks: [task('a', true)], firstRunSeconds: 200 }],
    version: '1.2.3', mode: 'start', startedAt: 'now', firstRunLimitSeconds: 900,
  });
  assert.equal(ok.passed, true);
  assert.match(ok.text, /^# Scripted pilot: passed/);
  assert.match(ok.text, /Task a: passed in 30 seconds \(limit 2 minutes\)/);
  const bad = plainResult({
    testers: [{ name: 'Tester p02', description: 'Laptop.', tasks: [task('b', false, ['No answer'])], stopped: 'Task b', consoleErrors: ['boom'] }],
    version: '1.2.3', mode: 'dev', startedAt: 'now', firstRunLimitSeconds: 900,
  });
  assert.equal(bad.passed, false);
  assert.match(bad.text, /Task b: FAILED/);
  assert.match(bad.text, / {2}- No answer/);
  assert.match(bad.text, /First run: not finished/);
  assert.match(bad.text, /console logged 1 error/);
  assert.doesNotMatch(ok.text, /console/);
  assert.match(bad.text, /## What to do/);
  const slowFirstRun = plainResult({
    testers: [{ name: 'Tester p03', description: 'Phone.', tasks: [task('c', true)], firstRunSeconds: 1000 }],
    version: '1.2.3', mode: 'start', startedAt: 'now', firstRunLimitSeconds: 900,
  });
  assert.equal(slowFirstRun.passed, false);
  assert.match(slowFirstRun.text, /too slow/);
});

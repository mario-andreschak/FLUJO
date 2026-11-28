// Pass rules and the plain-language result of the scripted pilot. Pure functions, so the rules are
// tested without a browser (result.test.mjs).

/**
 * One task passes when the scripted tester saw the expected result within the task's time limit and
 * no error message showed up meanwhile. Every broken rule becomes one plain sentence.
 */
export function judgeTask({ limitSeconds, seconds, errors = [], failure }) {
  const reasons = [];
  if (failure) reasons.push(failure);
  if (seconds > limitSeconds) reasons.push(`It took ${Math.round(seconds)} seconds; the limit is ${limitSeconds}.`);
  for (const error of errors) reasons.push(`An error message showed up: "${error}"`);
  return { passed: reasons.length === 0, reasons };
}

/** Error text that is not new since `before`, so a task only answers for what showed up during it. */
export function newErrors(before, after) {
  const seen = new Set(before);
  return [...new Set(after)].filter((entry) => !seen.has(entry));
}

const COUNT_LINES = {
  aiConnections: /^AI connections: (\d+)/m,
  apps: /^Connected apps: (\d+)/m,
  agents: /^Agents: (\d+)/m,
  agentsUsingApps: /^Agents: \d+, (\d+) use connected apps/m,
  runs: /^\s*Runs: (\d+)/m,
  toolCalls: /^\s*Tool calls: (\d+)/m,
  aiRequests: /^\s*AI requests: (\d+)/m,
};

/** The counts a tester would read in the diagnostic report text. Missing lines stay undefined. */
export function readReportCounts(report) {
  return Object.fromEntries(Object.entries(COUNT_LINES).map(([key, pattern]) => {
    const match = pattern.exec(report);
    return [key, match ? Number(match[1]) : undefined];
  }));
}

/**
 * What is wrong with the diagnostic report a tester created after the day-one tasks: it must be
 * complete, count what the tester just did, and contain none of the tester's private values.
 */
export function checkDiagnosticReport(report, { privateValues = [], expected = {} } = {}) {
  const problems = [];
  if (!report.startsWith('FLUJO diagnostic report')) problems.push('The report does not start with "FLUJO diagnostic report".');
  const missing = /^Could not read: (.+)$/m.exec(report);
  if (missing) problems.push(`The report could not read: ${missing[1]}.`);
  const counts = readReportCounts(report);
  const runLine = /^\s*Runs: (\d+) \(([^)]*)\)/m.exec(report);
  const parts = runLine ? [...runLine[2].matchAll(/\d+/g)].reduce((sum, [number]) => sum + Number(number), 0) : undefined;
  if (runLine && parts !== Number(runLine[1])) problems.push(`The report counts ${runLine[1]} runs, but its parts add up to ${parts}: "${runLine[0].trim()}".`);
  for (const [key, minimum] of Object.entries(expected)) {
    if (!(counts[key] >= minimum)) problems.push(`The report counts ${counts[key] ?? 'no'} ${key}; at least ${minimum} expected.`);
  }
  const lower = report.toLowerCase();
  for (const value of privateValues.filter((entry) => typeof entry === 'string' && entry.length >= 4)) {
    const variants = new Set([value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')]);
    if ([...variants].some((variant) => lower.includes(variant.toLowerCase()))) problems.push(`The report contains a private value: "${value}".`);
  }
  return problems;
}

function minutes(seconds) {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  return `${Number.isInteger(seconds / 60) ? seconds / 60 : (seconds / 60).toFixed(1)} minutes`;
}

/** The short result a person reads first: who did what, what passed, and why anything failed. */
export function plainResult({ testers, version, mode, startedAt, firstRunLimitSeconds }) {
  const tasks = testers.flatMap((tester) => tester.tasks);
  const failed = tasks.filter((task) => !task.passed);
  const firstRunFailures = testers.filter((tester) => tester.firstRunSeconds === undefined || tester.firstRunSeconds > firstRunLimitSeconds);
  const passed = failed.length === 0 && firstRunFailures.length === 0 && testers.every((tester) => !tester.stopped);
  const lines = [
    `# Scripted pilot: ${passed ? 'passed' : 'failed'}`,
    '',
    `${testers.length} scripted first-time users each opened a fresh FLUJO ${version} `
      + `(${mode === 'start' ? 'production build' : 'development server'}) with an empty data folder, and worked through `
      + 'the day-one tasks of the tester guide (docs/pilots/product-fit/tester-guide.md) with a local stand-in AI model.',
    `Started ${startedAt}. ${tasks.length - failed.length} of ${tasks.length} tasks passed.`,
    '',
    'Every task has a fixed rule: the expected result shows on screen, within the time limit, and no error message appears.',
    `The first run (tasks 1 to 3, from opening FLUJO to the agent's first answer) must take less than ${minutes(firstRunLimitSeconds)}.`,
    '',
  ];
  for (const tester of testers) {
    lines.push(`## ${tester.name}`, '', tester.description, '');
    for (const task of tester.tasks) {
      const verdict = task.passed ? 'passed' : 'FAILED';
      lines.push(`- ${task.title}: ${verdict} in ${minutes(task.seconds)} (limit ${minutes(task.limitSeconds)}).`);
      for (const reason of task.reasons) lines.push(`  - ${reason}`);
    }
    if (tester.stopped) lines.push(`- Stopped after a failed task, so the remaining tasks were not tried: ${tester.stopped}.`);
    if (tester.consoleErrors?.length) lines.push(`- The browser console logged ${tester.consoleErrors.length} error(s); they are listed in result.json.`);
    lines.push(tester.firstRunSeconds === undefined
      ? '- First run: not finished.'
      : `- First run: ${minutes(tester.firstRunSeconds)}${tester.firstRunSeconds > firstRunLimitSeconds ? ' (too slow)' : ''}.`);
    lines.push('');
  }
  if (!passed) {
    lines.push('## What to do', '', 'Open the screenshot and page snapshot named after each failed task in this folder, fix the cause in FLUJO, and run `npm run pilot:scripted` again.', '');
  }
  return { passed, text: `${lines.join('\n').trimEnd()}\n` };
}

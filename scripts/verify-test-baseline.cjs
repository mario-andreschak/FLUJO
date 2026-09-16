/**
 * Test-execution baseline gate (issue #457).
 *
 * A test file that stops executing — because it no longer parses, because a
 * glob stopped matching it, or because someone quietly `.skip`ped a suite —
 * is invisible in a green "all tests passed" report: the run simply contains
 * fewer tests than before. This script closes that hole by comparing the
 * machine-readable result of a Jest run (`jest --json --outputFile=...`)
 * against a checked-in baseline and failing when the executed suite/test count
 * drops below the recorded minimum, or when a suite fails outside the
 * quarantine allowlist.
 *
 * Usage:
 *   node scripts/verify-test-baseline.cjs --stage=ci --results=jest-results.json
 *   node scripts/verify-test-baseline.cjs --stage=isolated --results=... --update
 *
 * `--update` rewrites the stage entry in test-baseline.json with the observed
 * counts (used to record the first known-good run); it never lowers a value
 * unless `--allow-lower` is also passed.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.join(REPOSITORY_ROOT, 'test-baseline.json');

function parseArgs(argv) {
  const options = {
    stage: undefined,
    results: undefined,
    baseline: DEFAULT_BASELINE_PATH,
    update: false,
    allowLower: false,
  };
  for (const arg of argv) {
    if (arg === '--update') options.update = true;
    else if (arg === '--allow-lower') options.allowLower = true;
    else if (arg.startsWith('--stage=')) options.stage = arg.slice('--stage='.length);
    else if (arg.startsWith('--results=')) options.results = arg.slice('--results='.length);
    else if (arg.startsWith('--baseline=')) options.baseline = arg.slice('--baseline='.length);
    else throw baselineError(`Unsupported argument: ${arg}`);
  }
  if (!options.stage) throw baselineError('A --stage=<name> argument is required.');
  if (!options.results) throw baselineError('A --results=<path> argument is required.');
  return options;
}

function baselineError(message) {
  const error = new Error(message);
  error.code = 'FLUJO_TEST_BASELINE';
  return error;
}

function toPosixRelative(absolutePath, root = REPOSITORY_ROOT) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

/**
 * Reduce a Jest `--json` payload to the handful of numbers the gate needs,
 * plus the list of suites that failed, split by *how* they failed. A suite
 * that never ran ("Test suite failed to run": syntax error, bad import,
 * failing top-level code) reports zero individual test results, which is the
 * exact signature of the non-executing test files this guard exists for.
 */
function summarizeJestResults(results, root = REPOSITORY_ROOT) {
  if (!results || typeof results !== 'object') {
    throw baselineError('Jest results JSON is empty or not an object.');
  }
  if (!Array.isArray(results.testResults)) throw baselineError('Jest results must contain per-suite testResults.');
  const suiteResults = results.testResults;
  const failedToRun = [];
  const failedTests = [];
  const skippedTests = [];
  const invalidResults = results.wasInterrupted ? ['Jest run was interrupted.'] : [];
  const suites = { total: suiteResults.length, passed: 0, failed: 0, executed: 0 };
  const tests = { total: 0, passed: 0, failed: 0, executed: 0 };
  for (const suite of suiteResults) {
    const relative = suite.name ? toPosixRelative(suite.name, root) : '<unknown suite>';
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    const completed = assertions.filter((assertion) => ['passed', 'failed'].includes(assertion.status));
    tests.total += assertions.length;
    tests.passed += completed.filter((assertion) => assertion.status === 'passed').length;
    tests.failed += completed.filter((assertion) => assertion.status === 'failed').length;
    tests.executed += completed.length;
    for (const assertion of assertions) {
      if (['pending', 'todo', 'skipped', 'disabled'].includes(assertion.status)) {
        skippedTests.push({ suite: relative, name: assertion.fullName || assertion.title || '<unnamed test>', status: assertion.status });
      } else if (!['passed', 'failed'].includes(assertion.status)) {
        invalidResults.push(`Unknown assertion status in ${relative}: ${assertion.status}`);
      }
    }
    if (suite.testExecError || (suite.status === 'failed' && completed.length === 0)) {
      failedToRun.push(relative);
      suites.failed += 1;
    } else if (completed.length > 0) {
      suites.executed += 1;
      if (suite.status === 'failed' || completed.some((assertion) => assertion.status === 'failed')) {
        suites.failed += 1;
        failedTests.push(relative);
      } else {
        suites.passed += 1;
      }
    } else if (assertions.length === 0) {
      invalidResults.push(`Suite contains no assertion results: ${relative}`);
    }
  }
  return {
    suites,
    tests,
    failedToRun,
    failedTests,
    skippedTests,
    invalidResults,
  };
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw baselineError(`${label} could not be read at ${filePath}: ${detail}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw baselineError(`${label} at ${filePath} is not valid JSON: ${detail}`);
  }
}

function stageBaseline(baseline, stage) {
  const stages = baseline && typeof baseline === 'object' ? baseline.stages : undefined;
  const entry = stages && typeof stages === 'object' ? stages[stage] : undefined;
  if (!entry) {
    throw baselineError(
      `Stage "${stage}" is not declared in the baseline. Known stages: ${
        stages ? Object.keys(stages).join(', ') || '(none)' : '(none)'
      }.`,
    );
  }
  return entry;
}

/**
 * Apply the gate. Returns a structured verdict rather than exiting so the unit
 * tests can drive it with fixtures.
 */
function compareToBaseline({ stage, baseline, summary }) {
  const entry = stageBaseline(baseline, stage);
  const quarantined = new Set([
    ...(Array.isArray(baseline.quarantined) ? baseline.quarantined : []),
    ...(Array.isArray(entry.quarantined) ? entry.quarantined : []),
  ]);
  const failures = [];
  const warnings = [];
  const executedSuites = summary.suites.executed ?? summary.suites.passed + summary.suites.failed;
  const executedTests = summary.tests.executed ?? summary.tests.passed + summary.tests.failed;
  failures.push(...(summary.invalidResults || []));
  for (const skip of summary.skippedTests || []) {
    const allowed = (entry.intentionalSkips || []).some((expected) =>
      expected.suite === skip.suite && expected.name === skip.name && expected.reason
      && (!expected.platforms || expected.platforms.includes(process.platform)));
    if (!allowed) failures.push(`Unapproved skipped test: ${skip.suite} — ${skip.name}`);
  }

  if (!Number.isInteger(entry.minSuites) || entry.minSuites < 1 || !Number.isInteger(entry.minTests) || entry.minTests < 1) {
    failures.push(`Stage "${stage}" must declare positive minSuites and minTests for executed work.`);
  }
  if (typeof entry.minSuites === 'number' && executedSuites < entry.minSuites) {
    failures.push(
      `Executed suite count dropped: ${executedSuites} < ${entry.minSuites} recorded for stage "${stage}". `
      + 'A test file stopped being collected or stopped existing.',
    );
  }
  if (typeof entry.minTests === 'number' && executedTests < entry.minTests) {
    failures.push(
      `Executed test count dropped: ${executedTests} < ${entry.minTests} recorded for stage "${stage}". `
      + 'Tests were removed, skipped, or a suite failed to run.',
    );
  }

  for (const suite of summary.failedToRun) {
    failures.push(`Test suite failed to run (never executed): ${suite}`);
  }
  for (const suite of summary.failedTests) {
    if (quarantined.has(suite)) {
      warnings.push(`Quarantined suite has failing tests: ${suite}`);
      continue;
    }
    failures.push(`Test suite failed: ${suite}`);
  }

  return {
    stage,
    ok: failures.length === 0,
    failures,
    warnings,
    observed: summary,
    expected: { minSuites: entry.minSuites ?? null, minTests: entry.minTests ?? null },
  };
}

function formatReport(verdict) {
  const lines = [
    `### Test baseline — stage \`${verdict.stage}\`: ${verdict.ok ? 'PASS' : 'FAIL'}`,
    '',
    '| Metric | Observed | Baseline minimum |',
    '| --- | --- | --- |',
    `| Suites executed | ${verdict.observed.suites.executed ?? verdict.observed.suites.passed + verdict.observed.suites.failed} | ${verdict.expected.minSuites ?? '—'} |`,
    `| Suites failed | ${verdict.observed.suites.failed} | 0 outside quarantine |`,
    `| Tests executed | ${verdict.observed.tests.executed ?? verdict.observed.tests.passed + verdict.observed.tests.failed} | ${verdict.expected.minTests ?? '—'} |`,
    `| Tests failed | ${verdict.observed.tests.failed} | 0 outside quarantine |`,
  ];
  if (verdict.failures.length > 0) {
    lines.push('', '**Failures**', ...verdict.failures.map((failure) => `- ${failure}`));
  }
  if (verdict.warnings.length > 0) {
    lines.push('', '**Warnings**', ...verdict.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join('\n')}\n`;
}

function updatedBaseline(baseline, stage, summary, { allowLower = false } = {}) {
  const entry = { ...stageBaseline(baseline, stage) };
  const nextSuites = summary.suites.executed ?? summary.suites.passed + summary.suites.failed;
  const nextTests = summary.tests.executed ?? summary.tests.passed + summary.tests.failed;
  entry.minSuites = allowLower || typeof entry.minSuites !== 'number'
    ? nextSuites
    : Math.max(entry.minSuites, nextSuites);
  entry.minTests = allowLower || typeof entry.minTests !== 'number'
    ? nextTests
    : Math.max(entry.minTests, nextTests);
  return { ...baseline, stages: { ...baseline.stages, [stage]: entry } };
}

function writeStepSummary(report) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${report}\n`, 'utf8');
  } catch {
    // A missing summary file must never mask the actual verdict.
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const results = readJson(path.resolve(REPOSITORY_ROOT, options.results), 'Jest results JSON');
  const baselinePath = path.resolve(REPOSITORY_ROOT, options.baseline);
  const baseline = readJson(baselinePath, 'test-baseline.json');
  const summary = summarizeJestResults(results);
  const verdict = compareToBaseline({ stage: options.stage, baseline, summary });
  const report = formatReport(verdict);
  process.stdout.write(report);
  writeStepSummary(report);

  if (options.update) {
    if (!verdict.ok) throw baselineError('Refusing to record a failed or unapproved test run as the new baseline.');
    const next = updatedBaseline(baseline, options.stage, summary, { allowLower: options.allowLower });
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    process.stdout.write(`Recorded stage "${options.stage}" baseline in ${baselinePath}.\n`);
  }

  if (!verdict.ok) process.exitCode = 1;
  return verdict;
}

module.exports = {
  DEFAULT_BASELINE_PATH,
  compareToBaseline,
  formatReport,
  main,
  parseArgs,
  summarizeJestResults,
  toPosixRelative,
  updatedBaseline,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Unit tests for the CI baseline gate (issue #457).
 *
 * Mirrors __tests__/scripts/localTestDependencies.test.ts: the script is a
 * CommonJS pre-Jest bootstrap module, so it is exercised through require().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  compareToBaseline,
  formatReport,
  parseArgs,
  summarizeJestResults,
  updatedBaseline,
} = require('../../scripts/verify-test-baseline.cjs') as {
  compareToBaseline(input: {
    stage: string;
    baseline: Baseline;
    summary: Summary;
  }): Verdict;
  formatReport(verdict: Verdict): string;
  parseArgs(argv: string[]): {
    stage?: string;
    results?: string;
    baseline: string;
    update: boolean;
    allowLower: boolean;
  };
  summarizeJestResults(results: unknown, root?: string): Summary;
  updatedBaseline(
    baseline: Baseline,
    stage: string,
    summary: Summary,
    options?: { allowLower?: boolean },
  ): Baseline;
};

interface Baseline {
  stages: Record<string, { minSuites?: number | null; minTests?: number | null; quarantined?: string[]; intentionalSkips?: Array<{ suite: string; name: string; reason: string; platforms?: string[] }> }>;
  quarantined?: string[];
}

interface Summary {
  suites: { total: number; passed: number; failed: number; executed?: number };
  tests: { total: number; passed: number; failed: number; executed?: number };
  failedToRun: string[];
  failedTests: string[];
  skippedTests?: Array<{ suite: string; name: string; status: string }>;
  invalidResults?: string[];
}

interface Verdict {
  stage: string;
  ok: boolean;
  failures: string[];
  warnings: string[];
  observed: Summary;
  expected: { minSuites: number | null; minTests: number | null };
}

const ROOT = path.resolve(__dirname, '..', '..');

function jestResults(root: string) {
  return {
    numTotalTestSuites: 3,
    numPassedTestSuites: 1,
    numFailedTestSuites: 2,
    numTotalTests: 40,
    numPassedTests: 39,
    numFailedTests: 1,
    testResults: [
      {
        name: path.join(root, '__tests__', 'ok', 'green.test.ts'),
        status: 'passed',
        assertionResults: [{ status: 'passed' }],
      },
      {
        // The signature of a file that never executed: failed, zero assertions.
        name: path.join(root, '__tests__', 'broken', 'unparseable.test.ts'),
        status: 'failed',
        message: 'Test suite failed to run',
        assertionResults: [],
      },
      {
        name: path.join(root, '__tests__', 'flaky', 'quarantined.test.ts'),
        status: 'failed',
        assertionResults: [{ status: 'failed' }],
      },
    ],
  };
}

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    stages: { ci: { minSuites: 3, minTests: 40 } },
    quarantined: ['__tests__/flaky/quarantined.test.ts'],
    ...overrides,
  };
}

describe('verify-test-baseline argument parsing', () => {
  it('requires a stage and a results file', () => {
    expect(() => parseArgs([])).toThrow(/--stage/);
    expect(() => parseArgs(['--stage=ci'])).toThrow(/--results/);
    expect(() => parseArgs(['--stage=ci', '--nope'])).toThrow(/Unsupported argument/);
  });

  it('reads the optional flags', () => {
    const options = parseArgs(['--stage=ci', '--results=out.json', '--update', '--allow-lower']);
    expect(options.stage).toBe('ci');
    expect(options.results).toBe('out.json');
    expect(options.update).toBe(true);
    expect(options.allowLower).toBe(true);
    expect(options.baseline).toContain('test-baseline.json');
  });
});

describe('verify-test-baseline summary', () => {
  it('separates suites that never ran from suites with failing tests', () => {
    const summary = summarizeJestResults(jestResults(ROOT), ROOT);

    expect(summary.suites).toEqual({ total: 3, passed: 1, failed: 2, executed: 2 });
    // Aggregate counters are untrusted: only individual completed assertions count.
    expect(summary.tests).toEqual({ total: 2, passed: 1, failed: 1, executed: 2 });
    expect(summary.failedToRun).toEqual(['__tests__/broken/unparseable.test.ts']);
    expect(summary.failedTests).toEqual(['__tests__/flaky/quarantined.test.ts']);
  });

  it('rejects an empty payload instead of reporting a false pass', () => {
    expect(() => summarizeJestResults(null)).toThrow(/not an object/);
  });
});

describe('verify-test-baseline gate', () => {
  const summaryOf = (overrides: Partial<Summary> = {}): Summary => ({
    suites: { total: 3, passed: 3, failed: 0 },
    tests: { total: 40, passed: 40, failed: 0 },
    failedToRun: [],
    failedTests: [],
    ...overrides,
  });

  it('passes a clean run that matches the baseline', () => {
    const verdict = compareToBaseline({ stage: 'ci', baseline: baseline(), summary: summaryOf() });

    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('fails when fewer suites executed than the recorded minimum', () => {
    const verdict = compareToBaseline({
      stage: 'ci',
      baseline: baseline(),
      summary: summaryOf({ suites: { total: 2, passed: 2, failed: 0 } }),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/Executed suite count dropped: 2 < 3/);
  });

  it('fails when fewer tests executed than the recorded minimum', () => {
    const verdict = compareToBaseline({
      stage: 'ci',
      baseline: baseline(),
      summary: summaryOf({ tests: { total: 24, passed: 24, failed: 0 } }),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/Executed test count dropped: 24 < 40/);
  });

  it('fails on a suite that never ran, and only warns for quarantined suites', () => {
    const verdict = compareToBaseline({
      stage: 'ci',
      baseline: baseline(),
      summary: summaryOf({
        failedToRun: ['__tests__/broken/unparseable.test.ts'],
        failedTests: ['__tests__/flaky/quarantined.test.ts'],
      }),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([
      'Test suite failed to run (never executed): __tests__/broken/unparseable.test.ts',
    ]);
    expect(verdict.warnings.join('\n')).toMatch(/Quarantined suite has failing tests/);
  });

  it('fails closed when executed-test minima have not been recorded', () => {
    const verdict = compareToBaseline({
      stage: 'ci',
      baseline: { stages: { ci: { minSuites: 3, minTests: null } } },
      summary: summaryOf(),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/positive minSuites and minTests/);
  });

  it('rejects a fully skipped run even if aggregate collected counts meet the baseline', () => {
    const summary = summarizeJestResults({
      numTotalTestSuites: 682, numTotalTests: 9000, numPassedTests: 9000,
      testResults: Array.from({ length: 682 }, (_, index) => ({
        name: path.join(ROOT, `skipped-${index}.test.ts`), status: 'pending',
        assertionResults: [{ status: 'pending', fullName: 'hidden regression' }],
      })),
    }, ROOT);
    const verdict = compareToBaseline({ stage: 'ci', baseline: baseline(), summary });
    expect(verdict.ok).toBe(false);
    expect(summary.tests.executed).toBe(0);
    expect(summary.suites.executed).toBe(0);
    expect(verdict.failures.join('\n')).toMatch(/Unapproved skipped test/);
  });

  it('permits only the exact documented skip and never counts it as execution', () => {
    const skipped = { suite: 'opt-in.test.ts', name: 'controlled benchmark', status: 'pending' };
    const allowed = baseline();
    allowed.stages.ci.intentionalSkips = [{ ...skipped, reason: 'Dedicated performance job', platforms: [process.platform] }];
    expect(compareToBaseline({ stage: 'ci', baseline: allowed, summary: summaryOf({ skippedTests: [skipped] }) }).ok).toBe(true);
    expect(compareToBaseline({ stage: 'ci', baseline: allowed, summary: summaryOf({ skippedTests: [{ ...skipped, name: 'another regression' }] }) }).ok).toBe(false);
  });

  it('does not quarantine parse failures or allow interrupted runs', () => {
    const verdict = compareToBaseline({ stage: 'ci', baseline: baseline(), summary: summaryOf({
      failedToRun: ['__tests__/flaky/quarantined.test.ts'], invalidResults: ['Jest run was interrupted.'],
    }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(2);
  });

  it('rejects an unknown stage', () => {
    expect(() => compareToBaseline({ stage: 'nope', baseline: baseline(), summary: summaryOf() }))
      .toThrow(/Stage "nope" is not declared/);
  });

  it('renders a markdown report with the observed and expected numbers', () => {
    const report = formatReport(
      compareToBaseline({ stage: 'ci', baseline: baseline(), summary: summaryOf() }),
    );

    expect(report).toContain('stage `ci`: PASS');
    expect(report).toContain('| Suites executed | 3 | 3 |');
    expect(report).toContain('| Tests executed | 40 | 40 |');
  });
});

describe('verify-test-baseline recording', () => {
  it('raises the recorded minimums but never lowers them silently', () => {
    const summary: Summary = {
      suites: { total: 5, passed: 5, failed: 0 },
      tests: { total: 60, passed: 60, failed: 0 },
      failedToRun: [],
      failedTests: [],
    };

    const raised = updatedBaseline(baseline(), 'ci', summary);
    expect(raised.stages.ci).toEqual({ minSuites: 5, minTests: 60 });

    const lowerSummary: Summary = { ...summary, suites: { total: 1, passed: 1, failed: 0 } };
    expect(updatedBaseline(raised, 'ci', lowerSummary).stages.ci.minSuites).toBe(5);
    expect(updatedBaseline(raised, 'ci', lowerSummary, { allowLower: true }).stages.ci.minSuites).toBe(1);
  });

  it('records a stage whose minimums were never measured', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-baseline-'));
    try {
      const file = path.join(tempRoot, 'test-baseline.json');
      const next = updatedBaseline(
        { stages: { isolated: { minSuites: null, minTests: null } } },
        'isolated',
        {
          suites: { total: 4, passed: 4, failed: 0 },
          tests: { total: 21, passed: 21, failed: 0 },
          failedToRun: [],
          failedTests: [],
        },
      );
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');

      expect(JSON.parse(fs.readFileSync(file, 'utf8')).stages.isolated)
        .toEqual({ minSuites: 4, minTests: 21 });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('checked-in test-baseline.json', () => {
  it('declares both CI stages and a quarantine allowlist of real files', () => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test-baseline.json'), 'utf8'),
    ) as Baseline;

    expect(Object.keys(parsed.stages).sort()).toEqual(['ci', 'isolated']);
    expect(parsed.stages.ci.minSuites).toBeGreaterThan(0);
    expect(parsed.stages.isolated.minSuites).toBeGreaterThan(0);
    for (const quarantined of parsed.quarantined ?? []) {
      expect(fs.existsSync(path.join(ROOT, quarantined))).toBe(true);
    }
  });
});

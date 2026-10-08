/**
 * Guard for the isolated (process-boundary) CI stage — issue #457.
 *
 * The child-process suites are excluded from the main CI run and handed to a
 * dedicated serial job. That split is only safe if the exclusion list and the
 * dedicated job's file list stay identical: otherwise a suite silently runs
 * nowhere, which is exactly the class of bug #457 is about.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXCLUDE_ISOLATED_SUITES_ENV,
  ISOLATED_TEST_FILES,
  isolatedTestPathIgnorePatterns,
  shouldExcludeIsolatedSuites,
} from '../../jest.testMatch.mjs';

const {
  EXCLUDE_ISOLATED_SUITES_ENV: RUNNER_ENV,
  EXCLUDE_ISOLATED_SUITES_FLAG,
  partitionRunnerFlags,
} = require('../../scripts/run-local-jest.cjs') as {
  EXCLUDE_ISOLATED_SUITES_ENV: string;
  EXCLUDE_ISOLATED_SUITES_FLAG: string;
  partitionRunnerFlags(argv: string[]): { jestArgs: string[]; env: Record<string, string> };
};

const ROOT = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const verifyWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');

describe('isolated test stage', () => {
  it('lists only files that exist', () => {
    expect(ISOLATED_TEST_FILES.length).toBeGreaterThan(0);
    for (const file of ISOLATED_TEST_FILES) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
  });

  it('runs every excluded suite in the dedicated serial script', () => {
    const isolatedScript = packageJson.scripts['test:isolated'];
    expect(isolatedScript).toBeDefined();
    expect(isolatedScript).toContain('--runInBand');
    for (const file of ISOLATED_TEST_FILES) {
      expect(isolatedScript).toContain(file);
    }
  });

  it('builds standalone MCP artifacts before running the isolated suites', () => {
    const isolatedJob = verifyWorkflow.slice(verifyWorkflow.indexOf('  test-isolated:'));
    const buildIndex = isolatedJob.indexOf('run: npm run build:mcp');
    const testIndex = isolatedJob.indexOf('run: npm run test:isolated');

    expect(buildIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(buildIndex);
  });

  it('excludes them from the main CI run', () => {
    expect(packageJson.scripts['test:ci']).toContain(EXCLUDE_ISOLATED_SUITES_FLAG);
  });

  it('keeps the runner and the Jest config agreeing on the switch', () => {
    expect(RUNNER_ENV).toBe(EXCLUDE_ISOLATED_SUITES_ENV);

    const { jestArgs, env } = partitionRunnerFlags(['--ci', EXCLUDE_ISOLATED_SUITES_FLAG, '--json']);
    expect(jestArgs).toEqual(['--ci', '--json']);
    expect(env[EXCLUDE_ISOLATED_SUITES_ENV]).toBe('1');
    expect(shouldExcludeIsolatedSuites(env as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldExcludeIsolatedSuites({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('produces ignore patterns that match exactly those files', () => {
    const rootDir = '/repo';
    for (const [index, pattern] of isolatedTestPathIgnorePatterns.entries()) {
      const regex = new RegExp(pattern.replace('<rootDir>', rootDir));
      expect(regex.test(`${rootDir}/${ISOLATED_TEST_FILES[index]}`)).toBe(true);
      expect(regex.test(`${rootDir}/__tests__/meta/isolatedTestStage.test.ts`)).toBe(false);
    }
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { testPatternsForRoot } from '../jest.testMatch.mjs';

const require = createRequire(import.meta.url);
const { globsToMatcher, replacePathSepForGlob } = require('jest-util');
const { selectionContract, assertTestExecution, EXPECTED_TEST_FILES_ENV, partitionRunnerFlags } = require('./run-local-jest.cjs');
const repo = fileURLToPath(new URL('../', import.meta.url));
const jest = path.join(repo, 'node_modules/jest/bin/jest.js');

test('rooted globs preserve dotted and space-containing Windows/Linux roots', () => {
  for (const root of ['C:\\Users\\Moe\\.codex\\worktrees\\space checkout\\FLUJO', '/tmp/.codex/space checkout/FLUJO']) {
    const patterns = testPatternsForRoot(root);
    const nodeMatches = globsToMatcher(patterns.nodeTestMatch.map(replacePathSepForGlob));
    const jsdomMatches = globsToMatcher(patterns.jsdomTestMatch.map(replacePathSepForGlob));
    assert.equal(nodeMatches(`${root}/__tests__/mcp/server.test.ts`), true);
    assert.equal(jsdomMatches(`${root}/__tests__/frontend/components/form.test.tsx`), true);
    assert.equal(nodeMatches(`${root}/userdata/__tests__/unexpected.test.ts`), false);
  }
  const nativeRoot = 'C:\\Users\\Moe\\.codex\\worktrees\\space checkout\\FLUJO';
  const broken = replacePathSepForGlob(`${nativeRoot}/__tests__/**/*.test.{ts,tsx}`);
  assert.equal(globsToMatcher([broken])(`${nativeRoot}/__tests__/mcp/server.test.ts`), false,
    'negative control reproduces the native <rootDir> separator loss');
});

test('runner retains selected files, normal/isolated options and explicitly fails zero-test bypasses', () => {
  const separated = partitionRunnerFlags(['--exclude-isolated-suites', '--runInBand', '__tests__/mcp/server.test.ts']);
  assert.equal(separated.env.FLUJO_JEST_EXCLUDE_ISOLATED_SUITES, '1');
  const selection = selectionContract(separated.jestArgs, repo);
  assert.deepEqual(selection.expectedFiles, [path.join(repo, '__tests__/mcp/server.test.ts')]);
  assert.ok(selection.args.includes('--runInBand'));
  assert.ok(selection.args.includes('--reporters=default'));
  assert.equal(selectionContract(['--listTests'], repo).args.length, 1);
  for (const flag of ['--passWithNoTests', '--passWithNoTests=true', '--pass-with-no-tests']) {
    assert.throws(() => selectionContract([flag], repo), /zero execution must fail/);
  }
});

test('execution accounting rejects missing/duplicate/fully skipped selected suites', () => {
  const file = path.join(repo, '__tests__/mcp/selected.test.ts');
  const result = { testFilePath: file, numPassingTests: 1, numFailingTests: 0 };
  const results = { numPassedTests: 1, numFailedTests: 0, testResults: [result] };
  assertTestExecution(results, [file]);
  assert.throws(() => assertTestExecution({ ...results, testResults: [] }, [file]), /did not run exactly once/);
  assert.throws(() => assertTestExecution({ ...results, testResults: [result, result] }, [file]), /did not run exactly once/);
  assert.throws(() => assertTestExecution({ ...results, testResults: [{ ...result, numPassingTests: 0 }] }, [file]), /no assertions/);
  assert.throws(() => assertTestExecution({ numPassedTests: 0, numFailedTests: 0, numPendingTests: 4, testResults: [] }), /zero-execution/);
});

function fixture(t) {
  const tempRoot = realpathSync.native(os.tmpdir());
  const parent = realpathSync.native(mkdtempSync(path.join(tempRoot, 'flujo-jest-discovery-')));
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `fixture path must stay within its owned directory: ${target}`);
  };
  inside(tempRoot, parent);
  t.after(() => {
    assert.equal(realpathSync.native(parent), parent, 'cleanup target must still be the owned physical directory');
    inside(tempRoot, parent);
    rmSync(parent, { recursive: true, force: true });
  });
  const realRoot = path.join(parent, 'physical root', '.codex', 'space checkout', 'FLUJO');
  const root = path.join(parent, 'checkout alias');
  inside(parent, realRoot);
  inside(parent, root);
  const files = [
    '__tests__/ordinary.test.ts',
    '__tests__/frontend/components/form.test.tsx',
    '__tests__/mcp/processBoundary.test.ts',
    '__tests__/mcp/stdioServers.test.ts',
  ];
  for (const file of files) {
    const target = path.join(realRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "test('synthetic discovery witness', () => expect(1 + 1).toBe(2));\n");
  }
  symlinkSync(realRoot, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync.native(root), realRoot);
  return { root, realRoot, files };
}

function executeFixture(f, { exclude = false, selected = [], project, patterns = testPatternsForRoot(f.root) } = {}) {
  const config = {
    rootDir: f.root,
    projects: [
      { rootDir: f.root, displayName: 'node', testEnvironment: 'node', transform: {}, testMatch: patterns.nodeTestMatch,
        testPathIgnorePatterns: [...patterns.nodeTestPathIgnorePatterns, ...(exclude ? patterns.isolatedTestPathIgnorePatterns : [])] },
      { rootDir: f.root, displayName: 'jsdom', testEnvironment: 'node', transform: {}, testMatch: patterns.jsdomTestMatch },
    ],
  };
  const output = path.join(f.root, 'results.json');
  const selection = selectionContract(['--config', JSON.stringify(config),
    ...(project ? ['--selectProjects', project] : []), '--runInBand', '--no-cache', '--json', `--outputFile=${output}`, ...selected], f.root);
  const child = spawnSync(process.execPath, [jest, ...selection.args], { cwd: f.root, encoding: 'utf8', windowsHide: true,
    timeout: 30_000, env: { ...process.env, [EXPECTED_TEST_FILES_ENV]: JSON.stringify(selection.expectedFiles) } });
  assert.ifError(child.error);
  let results;
  try { results = JSON.parse(readFileSync(output, 'utf8')); } catch { /* no report on discovery failure */ }
  return { ...child, results };
}

test('actual Jest discovers every ordinary and isolated fixture exactly once under a managed-path shape', (t) => {
  const f = fixture(t);
  const run = executeFixture(f);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.results.numPassedTests, f.files.length);
  assert.deepEqual(run.results.testResults.map((item) => path.relative(f.realRoot, item.name).replaceAll('\\', '/')).sort(), [...f.files].sort());
});

test('real directory alias reproduces the pre-canonicalization zero-discovery failure', (t) => {
  const f = fixture(t);
  const patterns = testPatternsForRoot(f.root);
  const physical = f.realRoot.replaceAll('\\', '/');
  const alias = f.root.replaceAll('\\', '/');
  const run = executeFixture(f, { patterns: { ...patterns,
    nodeTestMatch: patterns.nodeTestMatch.map((glob) => glob.replace(physical, alias)),
    jsdomTestMatch: patterns.jsdomTestMatch.map((glob) => glob.replace(physical, alias)),
  } });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /No tests found/);
});

test('selected existing and missing file identities use the physical root across directory aliases', (t) => {
  const f = fixture(t);
  const selected = [path.join(f.root, f.files[0]), path.join(f.root, '__tests__/missing.test.ts')];
  const selection = selectionContract(selected, f.root);
  assert.deepEqual(selection.expectedFiles, [path.join(f.realRoot, f.files[0]), path.join(f.realRoot, '__tests__/missing.test.ts')]);
  for (const file of selection.expectedFiles) assert.ok(selection.args.includes(file.replaceAll('\\', '/')));
  const results = { numPassedTests: 1, numFailedTests: 0, testResults: [
    { testFilePath: path.join(f.realRoot, f.files[0]), numPassingTests: 1, numFailingTests: 0 },
  ] };
  assertTestExecution(results, [selected[0]]);
  assert.throws(() => assertTestExecution(results, selection.expectedFiles), /did not run exactly once/);
});

test('ordinary CI exclusions preserve node/jsdom ownership and the isolated stage selects both requested files', (t) => {
  const f = fixture(t);
  const ordinary = executeFixture(f, { exclude: true });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.results.numPassedTests, 2);
  const selected = f.files.slice(2);
  const isolated = executeFixture(f, { selected, project: 'node' });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.results.numPassedTests, selected.length);
});

test('actual Jest cannot silently succeed after omitting one explicitly selected suite', (t) => {
  const f = fixture(t);
  const run = executeFixture(f, { selected: f.files.slice(0, 2), project: 'node' });
  assert.equal(run.results.numPassedTests, 1, 'one valid selected suite ran');
  assert.notEqual(run.status, 0, 'missing selected jsdom suite must still fail the run');
  assert.match(run.stderr, /Explicitly selected suite did not run exactly once/);
});

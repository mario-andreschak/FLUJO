import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Linter } from 'eslint';

const require = createRequire(import.meta.url);
const nextPlugin = require('@next/eslint-plugin-next');
const pluginRequire = createRequire(require.resolve('@next/eslint-plugin-next'));
const { getRootDirs } = pluginRequire('./utils/get-root-dirs.js');
// Next accepts relative roots too. Compare the actual filesystem identities,
// including implementations that return directory paths with trailing slashes.
const normalize = paths => paths.map(value => path.resolve(value)).sort();

test('the locked graph has only the reviewed Next lint consumer of the private adapter', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const consumers = Object.entries(lock.packages)
    .filter(([, metadata]) => metadata.dependencies?.['fast-glob'])
    .map(([location]) => location);
  assert.deepEqual(consumers, ['node_modules/@next/eslint-plugin-next']);
  assert.equal(lock.packages[consumers[0]].version, '16.3.8');
});

function fixture(t) {
  const owned = mkdtempSync(path.join(os.tmpdir(), 'flujo-next-lint-glob-'));
  t.after(() => {
    const target = path.resolve(owned);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('flujo-next-lint-glob-'));
    rmSync(target, { recursive: true, force: true });
  });
  const root = path.join(owned, '.codex', 'space containing');
  const alpha = path.join(root, 'apps', 'alpha');
  const beta = path.join(root, 'apps', 'beta');
  mkdirSync(path.join(alpha, 'pages'), { recursive: true });
  mkdirSync(path.join(beta, 'src', 'app', 'settings'), { recursive: true });
  writeFileSync(path.join(alpha, 'pages', 'dashboard.jsx'), 'export default function Page() { return null; }');
  writeFileSync(path.join(beta, 'src', 'app', 'settings', 'page.jsx'), 'export default function Page() { return null; }');
  writeFileSync(path.join(root, 'apps', 'not-a-directory.txt'), 'fixture');
  return { root, alpha, beta, expected: normalize([alpha, beta]) };
}

test('Next resolves the pinned maintained glob implementation with the required API', () => {
  const entry = pluginRequire.resolve('fast-glob');
  const metadata = JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'fast-glob');
  assert.equal(metadata.version, '0.0.0-flujo.1');
  assert.equal(metadata.peerDependencies.tinyglobby, '0.2.17');
  assert.equal(typeof pluginRequire('fast-glob').globSync, 'function');
  assert.throws(() => pluginRequire('fast-glob').globSync('*', { onlyFiles: true }), /only supports/);
});

test('the real Next root-directory caller keeps cwd and excludes files from globbed roots', t => {
  const { root, expected } = fixture(t);
  assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
  assert.deepEqual(normalize(getRootDirs({ cwd: root,
    settings: { next: { rootDir: path.join(root, 'apps', '*') } } })), expected);
});

test('the real caller handles dotted and space-containing Windows paths, braces and root arrays', t => {
  const { root, alpha, beta, expected } = fixture(t);
  for (const rootDir of [
    path.join(root, 'apps', '*').replaceAll('/', '\\'),
    path.join(root, 'apps', '{alpha,beta}'),
    [alpha, beta, null],
  ]) {
    assert.deepEqual(normalize(getRootDirs({ cwd: root, settings: { next: { rootDir } } })), expected);
  }
});

test('the real Next lint rule still catches internal page navigation through globbed roots', t => {
  const { root } = fixture(t);
  const linter = new Linter({ cwd: root });
  const configuration = [{
    files: ['**/*.jsx'],
    plugins: { next: nextPlugin },
    settings: { next: { rootDir: path.join(root, 'apps', '*') } },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'next/no-html-link-for-pages': 'error' },
  }];
  const filename = path.join(root, 'navigation.jsx');
  const errors = linter.verify('<><a href="/dashboard">Dashboard</a><a href="https://example.invalid/">External</a></>',
    configuration, { filename });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ruleId, 'next/no-html-link-for-pages');
  assert.match(errors[0].message, /dashboard/);
  assert.deepEqual(linter.verify('<Link href="/dashboard">Dashboard</Link>', configuration, { filename }), []);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseReleaseArguments } from './release-arguments.mjs';
import { readReleaseState, writeReleaseState } from './release-state.mjs';

const entrypoint = fileURLToPath(new URL('./release.mjs', import.meta.url));
const stubs = new URL('./fixtures/release-command-stubs.mjs', import.meta.url).href;

function runRelease(t, args, overrides = {}) {
  const tempRoot = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, 'flujo-release-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('flujo-release-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  const commandLog = path.join(directory, 'commands.jsonl');
  writeFileSync(commandLog, '');
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(name)) env[name] = value;
  }
  const result = spawnSync(process.execPath, ['--import', stubs, entrypoint, ...args], {
    cwd: directory,
    env: { ...env, ...overrides, RELEASE_TEST_COMMAND_LOG: commandLog },
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  const commands = readFileSync(commandLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, commands };
}

const attemptedPublish = (command) => /^(npm (version|publish)|git push|npm run dockerbuild|gh workflow run)/.test(command);

function stateFixture(t) {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'flujo-release-state-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('flujo-release-state-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, 'pending.json') };
}

test('pending release records read absence directly and reject malformed content without exposing it', t => {
  const { filename } = stateFixture(t);
  assert.equal(readReleaseState(filename), null);
  writeFileSync(filename, 'private malformed content');
  assert.throws(() => readReleaseState(filename), { message: 'The pending release record is invalid; resolve it before continuing.' });
  writeFileSync(filename, 'null');
  assert.throws(() => readReleaseState(filename), /pending release record is invalid/);
});

test('first release record cannot overwrite one created after the absence read', t => {
  const { directory, filename } = stateFixture(t);
  assert.equal(readReleaseState(filename), null);
  const previous = { sha: 'a'.repeat(40), version: '1.2.3' };
  writeReleaseState(filename, previous, { createOnly: true });
  assert.throws(() => writeReleaseState(filename, { sha: 'b'.repeat(40), version: '1.2.4' }, { createOnly: true }), { code: 'EEXIST' });
  assert.deepEqual(readReleaseState(filename), previous);
  assert.deepEqual(readdirSync(directory), ['pending.json']);
});

test('atomic release updates preserve a linked target instead of truncating its contents', t => {
  const { directory, filename } = stateFixture(t);
  const victim = path.join(directory, 'other-record.json');
  const original = { version: 'keep-me' };
  writeFileSync(victim, JSON.stringify(original));
  linkSync(victim, filename);
  const replacement = { sha: 'a'.repeat(40), version: '1.2.3', runId: 123 };
  writeReleaseState(filename, replacement);
  assert.deepEqual(readReleaseState(filename), replacement);
  assert.deepEqual(JSON.parse(readFileSync(victim, 'utf8')), original);
  assert.deepEqual(readdirSync(directory).sort(), ['other-record.json', 'pending.json']);
});

test('failed release record replacement leaves the destination and cleans its owned temporary directory', t => {
  const { directory, filename } = stateFixture(t);
  mkdirSync(filename);
  assert.throws(() => writeReleaseState(filename, { version: '1.2.3' }));
  assert.deepEqual(readdirSync(directory), ['pending.json']);
});

for (const setting of ['true', 'TRUE', '1']) {
  test(`npm environment dry-run ${setting} cannot version, push, or publish`, (t) => {
    const result = runRelease(t, [], { npm_config_dry_run: setting });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run passed/);
    const buildIndex = result.commands.indexOf('npm run build');
    assert.ok(buildIndex >= 0);
    assert.ok(result.commands.indexOf('npm run validate:mcp-release') > buildIndex);
    assert.ok(!result.commands.some(attemptedPublish));
    assert.ok(!result.commands.some((command) => /^(npm whoami|npm view .* maintainers|gh auth|git fetch)/.test(command)));
  });
}

test('explicit dry-run remains safe when npm environment is false', (t) => {
  const result = runRelease(t, ['patch', '--dry-run'], { npm_config_dry_run: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would version 'patch'/);
  assert.ok(!result.commands.some(attemptedPublish));
});

test('dry-run stops on an app build failure without validating stale artifacts', (t) => {
  const result = runRelease(t, ['--dry-run'], { RELEASE_TEST_FAIL_BUILD: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Synthetic app build failed/);
  assert.ok(!result.commands.includes('npm run validate:mcp-release'));
  assert.ok(!result.commands.some(attemptedPublish));
});

for (const args of [['--dryrun'], ['--unknown'], ['--dry-run=true'], ['patch', 'minor'], ['patch', '1.2.3'], ['nope']]) {
  test(`invalid arguments ${args.join(' ')} invoke no commands`, (t) => {
    const result = runRelease(t, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|Specify only one|Unknown bump/);
    assert.deepEqual(result.commands, []);
  });
}

for (const argument of ['--help', '-h']) {
  test(`${argument} invokes no commands`, (t) => {
    const result = runRelease(t, [argument]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.deepEqual(result.commands, []);
  });
}

test('invalid npm dry-run setting fails before any command', (t) => {
  const result = runRelease(t, [], { npm_config_dry_run: 'tru' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.commands, []);
  assert.match(result.stderr, /Invalid npm_config_dry_run setting/);
});

test('an intentional release reaches the intercepted version boundary without running it', (t) => {
  const result = runRelease(t, ['patch'], { npm_config_dry_run: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected release command blocked by test: npm version patch/);
  assert.ok(result.commands.includes('npm run build:mcp'));
  assert.ok(!result.commands.includes('npm run build'));
  assert.ok(!result.commands.includes('npm run validate:mcp-release'));
  assert.deepEqual(result.commands.filter(attemptedPublish), ['npm version patch --no-git-tag-version']);
  assert.ok(!result.commands.some((command) => /^npm (whoami|view .* maintainers)/.test(command)));
});

for (const side of ['RELEASE_TEST_FETCH_ORIGIN', 'RELEASE_TEST_PUSH_ORIGIN']) {
  test(`unofficial ${side} stops release before authentication, fetch, build or publication`, (t) => {
    const result = runRelease(t, ['patch'], { [side]: 'https://github.com/other/FLUJO.git' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /official FLUJO repository/);
    assert.ok(!result.commands.some((command) => /^(npm |git fetch|git push|gh )/.test(command)));
  });
}

test('default and explicit releases retain version selection', () => {
  assert.deepEqual(parseReleaseArguments([], {}), { bump: 'minor', dryRun: false, help: false, resume: null });
  for (const bump of ['patch', 'minor', 'major', '1.2.3']) assert.equal(parseReleaseArguments([bump], {}).bump, bump);
  for (const setting of ['', 'false', 'FALSE', '0']) {
    assert.equal(parseReleaseArguments([], { npm_config_dry_run: setting }).dryRun, false);
  }
  assert.equal(parseReleaseArguments([], { NPM_CONFIG_DRY_RUN: 'true' }).dryRun, true);
});

test('resume selects the original workflow run without selecting a new version', () => {
  assert.deepEqual(parseReleaseArguments(['--resume', '123456'], {}), {
    bump: 'minor', dryRun: false, help: false, resume: '123456',
  });
});

for (const args of [
  ['--resume'],
  ['--resume', '0'],
  ['--resume', '-1'],
  ['--resume', 'NaN'],
  ['--resume', '1.5'],
  ['--resume', '123', '--resume', '456'],
  ['patch', '--resume', '123'],
  ['--resume', '123', '3.40.1'],
  ['--resume', '123', '--dry-run'],
]) {
  test(`invalid resume arguments ${args.join(' ')} invoke no commands`, (t) => {
    assert.throws(() => parseReleaseArguments(args, {}));
    const result = runRelease(t, args);
    assert.equal(result.status, 1);
    assert.deepEqual(result.commands, []);
  });
}

test('npm environment dry-run cannot be combined with a resume request', () => {
  assert.throws(() => parseReleaseArguments(['--resume', '123'], { npm_config_dry_run: 'true' }));
});

for (const [label, overrides] of [
  ['local revision differs', { RELEASE_TEST_LOCAL_HEAD: 'b'.repeat(40) }],
  ['local version differs', { RELEASE_TEST_RUN_VERSION: '0.0.2' }],
  ['official main advanced', { RELEASE_TEST_MAIN_HEAD: 'b'.repeat(40) }],
  ['run belongs to a fork', { RELEASE_TEST_RUN_REPOSITORY: 'fork/FLUJO' }],
]) {
  test(`resume with ${label} cannot rerun jobs, version, push or publish`, (t) => {
    const result = runRelease(t, ['--resume', '123'], overrides);
    assert.equal(result.status, 1);
    assert.ok(!result.commands.some((command) => command.startsWith('gh run rerun')));
    assert.ok(!result.commands.some(attemptedPublish));
  });
}

test('failed release resume reruns only failed jobs of the original run without a new version', (t) => {
  const result = runRelease(t, ['--resume', '123']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Resume the same tested artifacts.*--resume 123/);
  assert.deepEqual(result.commands.filter((command) => command.startsWith('gh run rerun')), [
    'gh run rerun 123 --repo mario-andreschak/FLUJO --failed',
  ]);
  assert.ok(!result.commands.some(attemptedPublish));
});

test('an already successful release can be confirmed without rerunning or changing versions', (t) => {
  const result = runRelease(t, ['--resume', '123'], { RELEASE_TEST_RUN_CONCLUSION: 'success' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Released FLUJO 0\.0\.1/);
  assert.ok(!result.commands.some((command) => command.startsWith('gh run rerun')));
  assert.ok(!result.commands.some(attemptedPublish));
});

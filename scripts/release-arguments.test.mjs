import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseReleaseArguments } from './release-arguments.mjs';

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

for (const setting of ['true', 'TRUE', '1']) {
  test(`npm environment dry-run ${setting} cannot version, push, or publish`, (t) => {
    const result = runRelease(t, [], { npm_config_dry_run: setting });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run passed/);
    assert.ok(result.commands.includes('npm run validate:mcp-release'));
    assert.ok(!result.commands.some(attemptedPublish));
  });
}

test('explicit dry-run remains safe when npm environment is false', (t) => {
  const result = runRelease(t, ['patch', '--dry-run'], { npm_config_dry_run: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would version 'patch'/);
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
  assert.deepEqual(result.commands.filter(attemptedPublish), ['npm version patch -m "Bump version to %s"']);
});

test('default and explicit releases retain version selection', () => {
  assert.deepEqual(parseReleaseArguments([], {}), { bump: 'minor', dryRun: false, help: false });
  for (const bump of ['patch', 'minor', 'major', '1.2.3']) assert.equal(parseReleaseArguments([bump], {}).bump, bump);
  for (const setting of ['', 'false', 'FALSE', '0']) {
    assert.equal(parseReleaseArguments([], { npm_config_dry_run: setting }).dryRun, false);
  }
  assert.equal(parseReleaseArguments([], { NPM_CONFIG_DRY_RUN: 'true' }).dryRun, true);
});

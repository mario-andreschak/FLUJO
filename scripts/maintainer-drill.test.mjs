import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RECOVERY_SUITES, drillEnvironment, evaluateRecovery, evaluateTap, runDrill } from './maintainer-drill.mjs';

const tap = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const recovery = root => ({
  success: true, numTotalTestSuites: 4, numPassedTestSuites: 4, numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: RECOVERY_SUITES.map(file => ({ name: path.resolve(root, file), status: 'passed',
    assertionResults: [{ status: 'passed' }] })),
});
const removeOwned = directory => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('flujo-maintainer-'));
  rmSync(directory, { recursive: true, force: true });
};

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flujo-maintainer-test-'));
  t.after(() => removeOwned(root));
  for (const file of [...RECOVERY_SUITES, 'scripts/release-verification.test.mjs', 'scripts/require-release-verification.test.mjs']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '// fixture input\n');
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  writeFileSync(path.join(root, '.gitignore'), '.env*\n');
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Automated fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL',
    'commit', '-m', 'synthetic drill fixture']);
  return root;
}

test('rejects empty, failed, skipped and incomplete release TAP summaries', () => {
  assert.equal(evaluateTap(tap).tests, 2);
  for (const output of ['', tap.replace('tests 2', 'tests 0'), tap.replace('pass 2', 'pass 1'),
    tap.replace('skipped 0', 'skipped 1'), tap.replace('cancelled 0', 'cancelled 1'), tap.replace('# todo 0\n', '')]) {
    assert.throws(() => evaluateTap(output), /completed assertions/);
  }
});

test('requires exact recovery suites and completed assertions rather than a green aggregate', () => {
  const root = path.resolve('fixture-root');
  assert.equal(evaluateRecovery(recovery(root), root).tests, 4);
  for (const mutate of [
    result => { result.numPendingTests = 1; },
    result => { result.numPassedTests = 3; },
    result => { result.numTotalTests = 100; result.numPassedTests = 100; },
    result => { result.testResults[0].assertionResults = []; },
    result => { result.testResults[0].assertionResults[0].status = 'pending'; },
    result => { result.testResults[0].name = path.join(root, 'different.test.ts'); },
    result => { result.testResults[0] = result.testResults[1]; },
    result => { delete result.numTodoTests; },
  ]) {
    const result = recovery(root); mutate(result);
    assert.throws(() => evaluateRecovery(result, root), /all four exact suites/);
  }
});

test('child environment retains platform necessities and isolates all private/runtime inputs', () => {
  const sandbox = path.resolve('disposable');
  const env = drillEnvironment({ Path: 'system-bin', SystemRoot: 'windows', OPENAI_API_KEY: 'private',
    GH_TOKEN: 'private', FLUJO_DATA_DIR: 'personal', FLUJO_WORKER_MODE: '1', CODEX_HOME: 'personal',
    NODE_OPTIONS: '--require=private', NODE_PATH: 'foreign-deps' }, sandbox);
  assert.equal(env.Path, 'system-bin'); assert.equal(env.SystemRoot, 'windows');
  assert.equal(env.FLUJO_DATA_DIR, path.join(sandbox, 'data'));
  assert.equal(env.CODEX_HOME, path.join(sandbox, 'home', '.codex'));
  for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'FLUJO_WORKER_MODE', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.equal(env[key], undefined);
  }
});

test('serial fixed commands retain revision, raw checksums and explicit human/release gaps', t => {
  const root = fixture(t); const commands = [];
  const { directory, receipt } = runDrill({ root, run: (command, args, options) => {
    commands.push(args);
    assert.equal(command, process.execPath); assert.equal(options.cwd, root);
    assert.equal(options.shell, undefined);
    if (args[0] === '--test') return { status: 0, stdout: tap, stderr: '' };
    assert.ok(args.includes('--testMatch=**/__tests__/**/*.test.ts'));
    assert.ok(args.includes('--runTestsByPath'));
    const file = args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    writeFileSync(file, JSON.stringify(recovery(root)));
    return { status: 0, stdout: '', stderr: 'fixture diagnostics' };
  } });
  t.after(() => removeOwned(directory));
  assert.equal(commands.length, 2); assert.equal(receipt.result, 'passed');
  assert.match(receipt.revision, /^[a-f0-9]{40}$/); assert.equal(receipt.sourceCleanAfter, true);
  assert.ok(receipt.pending.includes('90-day-observation'));
  for (const gate of receipt.gates) {
    const bytes = readFileSync(path.join(directory, gate.stdout.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), gate.stdout.sha256);
  }
  const bytes = readFileSync(path.join(directory, 'receipt.json'));
  assert.equal(readFileSync(path.join(directory, 'receipt.sha256'), 'utf8').split(' ')[0],
    createHash('sha256').update(bytes).digest('hex'));
});

test('failure retains raw diagnostics and prevents subsequent gates; partial mode never passes', t => {
  const root = fixture(t); let calls = 0;
  const failed = runDrill({ root, run: () => { calls++; return { status: 1, stdout: 'failure', stderr: 'detail' }; } });
  t.after(() => removeOwned(failed.directory));
  assert.equal(calls, 1); assert.equal(failed.receipt.result, 'failed');
  assert.equal(readFileSync(path.join(failed.directory, 'release-guards.stderr.txt'), 'utf8'), 'detail');
  const partial = runDrill({ root, releaseOnly: true, run: () => ({ status: 0, stdout: tap }) });
  t.after(() => removeOwned(partial.directory));
  assert.equal(partial.receipt.result, 'partial'); assert.equal(partial.receipt.gates[1].result, 'not-run');
});

test('dirty source and private dotenv files are refused before invoking gates', t => {
  const root = fixture(t); const run = () => { throw new Error('must not execute'); };
  writeFileSync(path.join(root, 'untracked.txt'), 'uncommitted');
  assert.throws(() => runDrill({ root, run }), /clean committed checkout/);
  rmSync(path.join(root, 'untracked.txt'));
  writeFileSync(path.join(root, '.env.local'), 'SYNTHETIC_SECRET=example');
  assert.throws(() => runDrill({ root, run }), /private .env.local/);
});

test('a mid-drill source change invalidates an otherwise green rehearsal', t => {
  const root = fixture(t);
  const { directory, receipt } = runDrill({ root, releaseOnly: true, run: () => {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    return { status: 0, stdout: tap };
  } });
  t.after(() => removeOwned(directory));
  assert.equal(receipt.result, 'failed'); assert.match(receipt.failure, /Source changed/);
});

test('timeouts, signals and missing recovery JSON never create a passing receipt', t => {
  const root = fixture(t);
  for (const result of [{ status: null, error: { code: 'ETIMEDOUT' } }, { status: 0, signal: 'SIGTERM' }]) {
    const output = runDrill({ root, run: () => result });
    t.after(() => removeOwned(output.directory));
    assert.equal(output.receipt.result, 'failed');
    assert.equal(output.receipt.gates.length, 1);
  }
  const missing = runDrill({ root, run: (_command, args) => ({ status: 0, stdout: args[0] === '--test' ? tap : '' }) });
  t.after(() => removeOwned(missing.directory));
  assert.equal(missing.receipt.result, 'failed'); assert.match(missing.receipt.failure, /ENOENT/);
});

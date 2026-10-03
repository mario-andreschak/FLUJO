import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RECOVERY_SUITES, drillEnvironment, evaluateRecovery, evaluateTap, runDrill, verifyDrillEvidence } from './maintainer-drill.mjs';

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

function evidenceFixture(t, { status = 0 } = {}) {
  const root = fixture(t);
  const output = runDrill({ root, run: (_command, args) => {
    if (args[0] === '--test') return { status: 0, stdout: tap };
    writeFileSync(args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length), JSON.stringify(recovery(root)));
    return { status, stdout: '', stderr: 'synthetic recovery report' };
  } });
  t.after(() => removeOwned(output.directory));
  const verify = () => verifyDrillEvidence({ directory: output.directory, revision: output.receipt.revision, version: '0.0.0' });
  const save = receipt => {
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    writeFileSync(path.join(output.directory, 'receipt.json'), bytes);
    writeFileSync(path.join(output.directory, 'receipt.sha256'),
      `${createHash('sha256').update(bytes).digest('hex')}  receipt.json\n`);
  };
  return { ...output, verify, save };
}

test('read-only evidence verification checks raw bytes and rejects a different trusted revision/version', t => {
  const output = evidenceFixture(t);
  assert.equal(output.verify().result, 'verified-source-rehearsal');
  for (const change of [{ revision: 'f'.repeat(40) }, { version: '1.0.0' }]) {
    assert.throws(() => verifyDrillEvidence({ directory: output.directory,
      revision: output.receipt.revision, version: '0.0.0', ...change }), /stale, incomplete/);
  }
  writeFileSync(path.join(output.directory, 'release-guards.stdout.txt'), tap + 'edited output');
  assert.throws(output.verify, /checksum\/size mismatch/);
});

test('recomputed receipt checksums cannot hide missing gates, fabricated counts or changed commands', t => {
  const output = evidenceFixture(t);
  for (const mutate of [
    receipt => { receipt.pending = []; },
    receipt => { receipt.gates[1].exitCode = 1; },
    receipt => { receipt.gates[1].assertions.tests = 999; },
    receipt => { receipt.gates[0].command.push('--test-name-pattern=skip-everything'); },
    receipt => { receipt.gates[1].stdout.path = '../outside'; },
    receipt => { receipt.result = 'partial'; },
    receipt => { receipt.sourceCleanAfter = null; },
  ]) {
    const receipt = structuredClone(output.receipt); mutate(receipt); output.save(receipt);
    assert.throws(output.verify);
  }
});

test('v1 source-root inference and Windows path verification work after copying evidence across platforms', t => {
  const output = evidenceFixture(t); delete output.receipt.sourceRoot;
  output.save(output.receipt); assert.equal(output.verify().recovery.suites, 4);
  const receipt = structuredClone(output.receipt);
  receipt.platform = 'win32'; receipt.gates.forEach(gate => { gate.command[0] = 'C:\\node\\node.exe'; });
  receipt.gates[1].command[7] = '--outputFile=C:\\original\\evidence\\recovery-results.json';
  const result = recovery('unused');
  result.testResults = RECOVERY_SUITES.map(file => ({ name: path.win32.resolve('C:\\source\\.codex\\FLUJO', file),
    status: 'passed', assertionResults: [{ status: 'passed' }] }));
  const bytes = JSON.stringify(result);
  writeFileSync(path.join(output.directory, 'recovery-results.json'), bytes);
  receipt.recoveryResults.sha256 = createHash('sha256').update(bytes).digest('hex');
  receipt.recoveryResults.bytes = Buffer.byteLength(bytes); output.save(receipt);
  assert.equal(output.verify().result, 'verified-source-rehearsal');
});

test('failed recovery subprocess reports remain hashed and incomplete evidence cannot verify', t => {
  const output = evidenceFixture(t, { status: 1 });
  assert.equal(output.receipt.result, 'failed');
  assert.match(output.receipt.recoveryResults.sha256, /^[a-f0-9]{64}$/);
  assert.throws(output.verify, /stale, incomplete/);
});

test('evidence verification refuses linked files and directory junctions', t => {
  const output = evidenceFixture(t);
  const target = path.join(output.directory, 'release-guards.stdout.txt');
  const original = path.join(output.directory, 'original-output.txt');
  writeFileSync(original, readFileSync(target)); rmSync(target); linkSync(original, target);
  assert.throws(output.verify, /Unsafe or oversized/);
  rmSync(target); writeFileSync(target, tap);
  const linkedRoot = path.join(output.directory, 'linked-root');
  symlinkSync(output.directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyDrillEvidence({ directory: linkedRoot, revision: output.receipt.revision, version: '0.0.0' }), /ordinary directory/);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readBoundedFileSync } from './read-bounded-file.cjs';

export const RECOVERY_SUITES = Object.freeze([
  '__tests__/settings/backupRestoreLinkSafety.test.ts',
  '__tests__/settings/backupRestoreRoutes.test.ts',
  '__tests__/workspace/snapshotArchive.test.ts',
  '__tests__/workspace/snapshotRestore.test.ts',
]);
const RELEASE_SUITES = [
  'scripts/release-verification.test.mjs',
  'scripts/require-release-verification.test.mjs',
];
const PENDING_GATES = Object.freeze([
  'independent-human-review', 'human-operated-drill', 'private-triage-tabletop',
  'installed-artifact-release-upgrade-recovery', 'verified-backup-access', '90-day-observation', 'independent-reassessment',
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function evaluateTap(output) {
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'))?.[1] ?? NaN);
  const tests = count('tests');
  if (!(tests > 0) || count('pass') !== tests
      || ['fail', 'cancelled', 'skipped', 'todo'].some(name => count(name) !== 0)) {
    throw new Error('Release rehearsal requires completed assertions with no failures, skips or cancellations.');
  }
  return { tests, passed: tests, skipped: 0 };
}

export function evaluateRecovery(results, root, sourcePath = path) {
  const expected = RECOVERY_SUITES.map(file => sourcePath.resolve(root, file)).sort();
  const suites = results.testResults;
  if (!results.success || !Array.isArray(suites)
      || JSON.stringify(suites.map(suite => sourcePath.resolve(suite.name)).sort()) !== JSON.stringify(expected)
      || results.numTotalTestSuites !== expected.length
      || results.numPassedTestSuites !== expected.length
      || !(results.numTotalTests > 0) || results.numPassedTests !== results.numTotalTests
      || ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']
        .some(key => results[key] !== 0)
      || suites.some(suite => suite.status !== 'passed' || !suite.assertionResults?.length
        || suite.assertionResults.some(assertion => assertion.status !== 'passed'))
      || suites.reduce((count, suite) => count + suite.assertionResults.length, 0) !== results.numTotalTests) {
    throw new Error('Recovery rehearsal requires all four exact suites and every assertion to pass without skips.');
  }
  return { suites: expected.length, tests: results.numTotalTests, passed: results.numPassedTests, skipped: 0 };
}

/** Check copied evidence without executing its commands or following embedded paths. */
export function verifyDrillEvidence({ directory, revision, version }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || typeof version !== 'string' || !version) {
    throw new Error('Supply the trusted exact source revision and package version.');
  }
  const rootStats = lstatSync(directory);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Evidence root must be an ordinary directory.');
  const readMember = (name, limit = 20 * 1024 * 1024) => {
    // The caller and receipt can never select arbitrary paths: all names below
    // are fixed single components, and links/hard links are refused.
    const filename = path.join(directory, name);
    try {
      return readBoundedFileSync(filename, limit);
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new Error(`Unsafe or oversized evidence member: ${name}`);
    }
  };
  const bytes = readMember('receipt.json', 1024 * 1024);
  const expectedDigest = readMember('receipt.sha256', 128).toString('utf8');
  if (expectedDigest !== `${digest(bytes)}  receipt.json\n`) throw new Error('Receipt checksum mismatch.');
  const receipt = JSON.parse(bytes);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'automated-source-rehearsal'
      || receipt.revision !== revision || receipt.version !== version || receipt.result !== 'passed'
      || receipt.sourceCleanBefore !== true || receipt.sourceCleanAfter !== true
      || !Array.isArray(receipt.pending) || PENDING_GATES.some(gate => !receipt.pending.includes(gate))
      || !Array.isArray(receipt.gates) || receipt.gates.length !== 2) {
    throw new Error('Receipt is stale, incomplete or missing its explicit acceptance gaps.');
  }
  const sourcePath = receipt.platform === 'win32' ? path.win32 : path.posix;
  const assertCommands = (actual, expected) => {
    if (!Array.isArray(actual) || !['node', 'node.exe'].includes(sourcePath.basename(actual[0] ?? ''))
        || JSON.stringify(actual.slice(1)) !== JSON.stringify(expected)) throw new Error('Unexpected recorded drill command.');
  };
  const evidence = (reference, name) => {
    if (reference?.path !== name) throw new Error(`Unexpected evidence reference for ${name}.`);
    const content = readMember(name);
    if (reference.sha256 !== digest(content) || reference.bytes !== content.length) {
      throw new Error(`Evidence checksum/size mismatch: ${name}`);
    }
    return content;
  };
  for (const [index, name] of ['release-guards', 'recovery-fixtures'].entries()) {
    const gate = receipt.gates[index];
    if (gate?.name !== name || gate.result !== 'passed' || gate.exitCode !== 0 || gate.signal !== null
        || !Number.isFinite(gate.elapsedMs) || gate.elapsedMs < 0) throw new Error(`Incomplete subprocess evidence: ${name}`);
    evidence(gate.stdout, `${name}.stdout.txt`);
    evidence(gate.stderr, `${name}.stderr.txt`);
  }
  assertCommands(receipt.gates[0].command, ['--test', '--test-reporter=tap', ...RELEASE_SUITES]);
  const release = evaluateTap(evidence(receipt.gates[0].stdout, 'release-guards.stdout.txt').toString('utf8'));
  const results = JSON.parse(evidence(receipt.recoveryResults, 'recovery-results.json'));
  // v1 receipts initially omitted sourceRoot. Infer it only from a known exact
  // suite suffix; evaluateRecovery then requires all four paths under that root.
  const suffix = RECOVERY_SUITES[0];
  const first = results.testResults?.find(suite => typeof suite.name === 'string'
    && suite.name.replaceAll('\\', '/').endsWith(`/${suffix}`))?.name.replaceAll('\\', '/');
  const sourceRoot = receipt.sourceRoot ?? first?.slice(0, -suffix.length - 1);
  if (typeof sourceRoot !== 'string' || !sourcePath.isAbsolute(sourceRoot)) throw new Error('Missing absolute source root in recovery evidence.');
  const recovery = evaluateRecovery(results, sourceRoot, sourcePath);
  const recoveryCommand = receipt.gates[1].command;
  const outputFlag = recoveryCommand?.[7];
  if (typeof outputFlag !== 'string' || !outputFlag.startsWith('--outputFile=')
      || !sourcePath.isAbsolute(outputFlag.slice('--outputFile='.length))
      || sourcePath.basename(outputFlag.slice('--outputFile='.length)) !== 'recovery-results.json') {
    throw new Error('Unexpected recovery results command path.');
  }
  assertCommands(recoveryCommand, ['scripts/run-local-jest.cjs', '--selectProjects', 'node', '--runInBand',
    '--testMatch=**/__tests__/**/*.test.ts', '--json', outputFlag, '--runTestsByPath', ...RECOVERY_SUITES]);
  for (const [actual, expected] of [[receipt.gates[0].assertions, release], [receipt.gates[1].assertions, recovery]]) {
    if (Object.entries(expected).some(([key, value]) => actual?.[key] !== value)) {
      throw new Error('Recorded assertion counts disagree with raw evidence.');
    }
  }
  return { result: 'verified-source-rehearsal', revision, version, release, recovery, pending: receipt.pending };
}

// Do not inherit provider credentials, worker flags, npm hooks or NODE_OPTIONS.
export function drillEnvironment(inherited, sandbox) {
  const keep = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'systemdrive']);
  const env = Object.fromEntries(Object.entries(inherited).filter(([key, value]) =>
    keep.has(key.toLowerCase()) && typeof value === 'string'));
  return {
    ...env, CI: 'true', NO_COLOR: '1', NODE_ENV: 'test',
    HOME: path.join(sandbox, 'home'), USERPROFILE: path.join(sandbox, 'home'),
    TEMP: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'), TMPDIR: path.join(sandbox, 'tmp'),
    FLUJO_DATA_DIR: path.join(sandbox, 'data'), CODEX_HOME: path.join(sandbox, 'home', '.codex'),
  };
}

export function runDrill({ root, releaseOnly = false, run = spawnSync }) {
  root = path.resolve(root);
  const git = args => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Start from a clean committed checkout; dirty source cannot produce revision-bound evidence.');
  }
  // next/jest loads dotenv files even when child environment variables are isolated.
  for (const name of ['.env', '.env.local', '.env.test', '.env.test.local']) {
    if (existsSync(path.join(root, name))) throw new Error(`Remove private ${name} from this disposable checkout first.`);
  }
  for (const file of [...RELEASE_SUITES, ...(releaseOnly ? [] : RECOVERY_SUITES)]) {
    if (!existsSync(path.join(root, file))) throw new Error(`Missing required drill input: ${file}`);
  }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-maintainer-drill-'));
  for (const name of ['home', 'tmp', 'data']) mkdirSync(path.join(directory, name));
  const env = drillEnvironment(process.env, directory);
  const receipt = {
    schemaVersion: 1, kind: 'automated-source-rehearsal', revision, version, sourceRoot: root,
    startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    sourceCleanBefore: true, sourceCleanAfter: null, result: 'failed', gates: [],
    pending: [...PENDING_GATES],
  };
  const capture = (name, bytes) => {
    writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
    return { path: name, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const gate = (name, args, evaluate, collect = () => undefined) => {
    const started = Date.now();
    const result = run(process.execPath, args, {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 20 * 1024 * 1024,
    });
    const record = { name, command: [process.execPath, ...args], elapsedMs: Date.now() - started,
      exitCode: result.status ?? null, signal: result.signal ?? null, result: 'failed',
      stdout: capture(`${name}.stdout.txt`, result.stdout ?? ''),
      stderr: capture(`${name}.stderr.txt`, result.stderr ?? '') };
    receipt.gates.push(record);
    // Retain the raw recovery report on failed subprocess exits as well.
    collect();
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error(`${name} did not complete successfully (${result.error?.code ?? result.signal ?? result.status}).`);
    }
    record.assertions = evaluate(result.stdout ?? '');
    record.result = 'passed';
  };
  try {
    gate('release-guards', ['--test', '--test-reporter=tap', ...RELEASE_SUITES], evaluateTap);
    if (releaseOnly) {
      receipt.gates.push({ name: 'recovery-fixtures', result: 'not-run', reason: '--release-only selected' });
    } else {
      const resultsPath = path.join(directory, 'recovery-results.json');
      gate('recovery-fixtures', ['scripts/run-local-jest.cjs', '--selectProjects', 'node', '--runInBand',
        // Root-relative matching avoids Jest's Windows escaping of dotted absolute
        // checkout paths (for example .codex). runTestsByPath still selects only
        // these exact files, and evaluateRecovery independently verifies them.
        '--testMatch=**/__tests__/**/*.test.ts',
        '--json', `--outputFile=${resultsPath}`, '--runTestsByPath', ...RECOVERY_SUITES], () => {
        return evaluateRecovery(JSON.parse(readFileSync(resultsPath)), root);
      }, () => {
        if (!existsSync(resultsPath)) return;
        const bytes = readFileSync(resultsPath);
        receipt.recoveryResults = { path: 'recovery-results.json', sha256: digest(bytes), bytes: bytes.length };
      });
    }
    if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=normal'])) {
      receipt.sourceCleanAfter = false;
      throw new Error('Source changed during the drill; do not reuse this evidence.');
    }
    receipt.sourceCleanAfter = true;
    receipt.result = releaseOnly ? 'partial' : 'passed';
  } catch (error) {
    receipt.failure = error.message;
  }
  receipt.completedAt = new Date().toISOString();
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  capture('receipt.json', bytes);
  capture('receipt.sha256', `${digest(bytes)}  receipt.json\n`);
  return { directory, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0].startsWith('--verify=')
      && args[1].startsWith('--expected-revision=') && args[2].startsWith('--expected-version=')) {
    try {
      console.log(JSON.stringify(verifyDrillEvidence({ directory: args[0].slice('--verify='.length),
        revision: args[1].slice('--expected-revision='.length), version: args[2].slice('--expected-version='.length) }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (args.some(arg => arg !== '--release-only') || args.length > 1) {
    console.error('Usage: node scripts/maintainer-drill.mjs [--release-only]\n'
      + '       node scripts/maintainer-drill.mjs --verify=DIR --expected-revision=SHA --expected-version=VERSION');
    process.exitCode = 1;
  } else {
    try {
      const { directory, receipt } = runDrill({
        root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        releaseOnly: args.includes('--release-only'),
      });
      console.log(`${receipt.result}: ${directory}`);
      if (receipt.failure) console.error(receipt.failure);
      if (receipt.result !== 'passed') process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

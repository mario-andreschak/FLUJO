import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptsCheckExit, assessScorecardCI, closureState, parseTestCounts, parseValidationClock, scorecardTestArguments } from './scorecard-ci-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-scorecard-ci.mjs <new-output-directory>');
const output = resolve(process.argv[2]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const snapshot = () => ({ sha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: Boolean(git(['status', '--porcelain'])) });
const sourceStart = snapshot();
if (sourceStart.dirty) throw new Error('Scorecard CI requires a clean committed source');
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceStart.sha) throw new Error('Checkout differs from workflow SHA');
mkdirSync(output, { recursive: true });
const checks = [];
for (const [name, args] of [
  ['tests', scorecardTestArguments()],
  ['ledger', ['scripts/validate-scorecard.mjs']],
  ['closure', ['scripts/validate-scorecard.mjs', '--closure']],
  ['publication', ['scripts/check-scorecard-publication.mjs', '--source', sourceStart.sha, '--repository', root]],
]) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, timeout: 180_000, maxBuffer: 12 * 1024 * 1024 });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  writeFileSync(resolve(output, name + '.stdout.log'), stdout, { flag: 'wx' });
  writeFileSync(resolve(output, name + '.stderr.log'), stderr, { flag: 'wx' });
  const check = { name, command: [process.execPath, ...args], startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
    validationClock: parseValidationClock(stdout.toString()),
    testCounts: name === 'tests' ? parseTestCounts(stdout.toString()) : null,
    closureState: name === 'closure' ? closureState(result.status) : null };
  checks.push({ ...check, acceptedExit: acceptsCheckExit(check) });
}
const sourceEnd = snapshot();
const tests = checks.find(check => check.name === 'tests').testCounts;
const assessment = assessScorecardCI({ sourceStart, sourceEnd, workflowSha: process.env.GITHUB_SHA ?? null, checks });
const { sameSource, passed } = assessment;
const report = { schemaVersion: 1, startedAt: checks[0].startedAt, finishedAt: new Date().toISOString(),
  sourceStart, sourceEnd, sameSource, platform: process.platform, node: process.version,
  workflowSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  result: passed ? 'source-checks-passed' : 'source-checks-failed', assessment, checks,
  scope: 'Dedicated source/synthetic Docs tests, current-clock ledger consistency and exact-Git file targets. Closure exit 2 is valid incomplete evidence; exit 0 is a ledger declaration, not external grade acceptance. No installed, human, live, security-disposition or release acceptance.' };
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceSha: sourceStart.sha, result: report.result, testCounts: tests, exits: checks.map(({ name, exitCode }) => ({ name, exitCode })) }));
if (!passed) process.exitCode = 1;

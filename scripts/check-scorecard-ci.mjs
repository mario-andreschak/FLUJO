import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
for (const [name, args, acceptedExits] of [
  ['tests', ['--test', '--test-reporter=tap', 'scripts/read-scorecard-evidence.test.mjs', 'scripts/validate-scorecard.test.mjs', 'scripts/check-scorecard-publication.test.mjs'], [0]],
  ['ledger', ['scripts/validate-scorecard.mjs'], [0]],
  ['closure', ['scripts/validate-scorecard.mjs', '--closure'], [0, 2]],
  ['publication', ['scripts/check-scorecard-publication.mjs', '--source', sourceStart.sha, '--repository', root], [0]],
]) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, timeout: 180_000, maxBuffer: 12 * 1024 * 1024 });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  writeFileSync(resolve(output, name + '.stdout.log'), stdout, { flag: 'wx' });
  writeFileSync(resolve(output, name + '.stderr.log'), stderr, { flag: 'wx' });
  const clock = stdout.toString().match(/^Validation clock: (\d+) \((wall-clock|override)\)\r?$/m);
  checks.push({ name, command: [process.execPath, ...args], startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    acceptedExit: acceptedExits.includes(result.status), stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
    validationClock: clock ? { epochMilliseconds: Number(clock[1]), source: clock[2] } : null,
    testCounts: name === 'tests' ? Object.fromEntries([...stdout.toString().matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)].map(match => [match[1], Number(match[2])])) : null,
    closureState: name === 'closure' ? ({ 0: 'ledger-declares-closure', 2: 'incomplete' })[result.status] ?? 'invalid' : null });
}
const sourceEnd = snapshot();
const tests = checks.find(check => check.name === 'tests').testCounts;
const sameSource = sourceStart.sha === sourceEnd.sha && sourceStart.tree === sourceEnd.tree && !sourceEnd.dirty;
const clocksRetained = checks.filter(check => ['ledger', 'closure'].includes(check.name)).every(check => check.validationClock?.source === 'wall-clock');
const allTestsCompleted = tests.tests > 0 && tests.pass === tests.tests
  && ['fail', 'cancelled', 'skipped', 'todo'].every(name => tests[name] === 0);
const passed = sameSource && clocksRetained && checks.every(check => check.acceptedExit) && allTestsCompleted;
const report = { schemaVersion: 1, startedAt: checks[0].startedAt, finishedAt: new Date().toISOString(),
  sourceStart, sourceEnd, sameSource, platform: process.platform, node: process.version,
  workflowSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  result: passed ? 'source-checks-passed' : 'source-checks-failed', checks,
  scope: 'Dedicated source/synthetic Docs tests, current-clock ledger consistency and exact-Git file targets. Closure exit 2 is valid incomplete evidence; exit 0 is a ledger declaration, not external grade acceptance. No installed, human, live, security-disposition or release acceptance.' };
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ sourceSha: sourceStart.sha, result: report.result, testCounts: tests, exits: checks.map(({ name, exitCode }) => ({ name, exitCode })) }));
if (!passed) process.exitCode = 1;

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { compareToBaseline, summarizeJestResults } = createRequire(import.meta.url)('./verify-test-baseline.cjs');
export const cases = Object.freeze([
  ['app-server', '__tests__/model/codexAppServerProcess.live.test.ts', 'source-owned-app-server-live-qualification'],
  ['catalogue', '__tests__/model/codexNativeQualification.live.test.ts', 'live-source-native-codex-qualification'],
  ['original', '__tests__/flow/nativeOriginalHost.live.test.ts', 'live-source-persona-original-qualification'],
]);

export function requirePrivatePath(value, checkout = root) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Absolute private live qualification paths required.');
  const relative = path.relative(checkout, value);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Live qualification inputs and receipts must stay outside the checkout.');
  }
  return value;
}

export function verifyLiveResult(result, receipt, selected, checkout = root) {
  const [name, filename, kind] = selected;
  const suites = result?.testResults;
  if (result?.wasInterrupted || result?.success !== true || !Array.isArray(suites) || suites.length !== 1
      || path.relative(checkout, suites[0].name).split(path.sep).join('/') !== filename
      || suites[0].status !== 'passed' || suites[0].testExecError
      || suites[0].assertionResults?.length !== 1 || suites[0].assertionResults[0].status !== 'passed') {
    throw new Error(`Live ${name} qualification did not execute and pass its exact test.`);
  }
  if (receipt?.kind !== kind || receipt.model !== 'gpt-6-luna' || (receipt.effort ?? receipt.reasoningEffort) !== 'medium'
      || !Number.isFinite(Date.parse(receipt.observedAt))
      || (name === 'app-server' ? receipt.countsAsRequestedSwarm !== false || receipt.billedSpendUsd !== null
        : receipt.countsAsBusinessWork !== false || receipt.billedCostUsd !== null)) {
    throw new Error(`Live ${name} qualification receipt is missing or invalid.`);
  }
}

/** Explicit account-backed qualification; ordinary CI has no account profile.
 * Existing private profiles are read in place. Never import them into Git or
 * Workers. All results/logs stay private; nothing here qualifies a swarm. */
export async function qualifyLiveCodex(env = process.env) {
  for (const key of ['FLUJO_LIVE_CODEX_PATH', 'FLUJO_LIVE_CODEX_HOME', 'CODEX_HOME', 'FLUJO_LIVE_CODEX_CATALOG', 'FLUJO_LIVE_CODEX_OUTPUT_DIR']) {
    requirePrivatePath(env[key]);
    requirePrivatePath(await fs.realpath(env[key]));
  }
  const directory = await fs.mkdtemp(path.join(env.FLUJO_LIVE_CODEX_OUTPUT_DIR, 'source-live-codex-'));
  const childEnv = { CI: 'true', NEXT_TELEMETRY_DISABLED: '1', FLUJO_DATA_DIR: path.join(directory, 'data') };
  for (const [key, value] of Object.entries(env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?|ssl_cert_file|ssl_cert_dir)$/i.test(key)
        || ['CODEX_HOME', 'FLUJO_LIVE_CODEX_PATH', 'FLUJO_LIVE_CODEX_HOME', 'FLUJO_LIVE_CODEX_CATALOG'].includes(key)) childEnv[key] = value;
  }
  const testHome = path.join(directory, 'test-home');
  await fs.mkdir(testHome, { mode: 0o700 });
  Object.assign(childEnv, { HOME: testHome, USERPROFILE: testHome, APPDATA: testHome, LOCALAPPDATA: testHome, TEMP: testHome, TMP: testHome });
  // Each case gets a different receipt: the first two historically shared an
  // environment variable and otherwise overwrite one another's evidence.
  const completed = [];
  const executed = [];
  for (const selected of cases) {
    const [name, filename] = selected;
    const receiptFile = path.join(directory, `${name}-receipt.json`);
    const resultFile = path.join(directory, `${name}-jest.json`);
    const log = await fs.open(path.join(directory, `${name}.log`), 'wx', 0o600);
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/run-local-jest.cjs', '--ci', '--selectProjects', 'node',
          '--runInBand', '--runTestsByPath', filename, '--json', `--outputFile=${resultFile}`], {
          cwd: root, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd],
          env: { ...childEnv, FLUJO_LIVE_CODEX_RECEIPT: receiptFile, FLUJO_LIVE_CODEX_ORIGINAL_RECEIPT: receiptFile },
        });
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve(signal ? -1 : exitCode));
      });
      if (code !== 0) throw new Error(`Live ${name} qualification failed; private evidence retained in ${directory}.`);
      const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      verifyLiveResult(result, receipt, selected);
      executed.push(...result.testResults);
      completed.push({ name, filename, receipt: path.basename(receiptFile), result: path.basename(resultFile) });
    } finally { await log.close(); }
  }
  const combined = { success: true, wasInterrupted: false, testResults: executed };
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'test-baseline.json'), 'utf8'));
  const verdict = compareToBaseline({ stage: 'live-codex', baseline, summary: summarizeJestResults(combined, root) });
  await fs.writeFile(path.join(directory, 'jest-results.json'), JSON.stringify(combined), { flag: 'wx', mode: 0o600 });
  if (!verdict.ok) throw new Error('Live Codex execution baseline refused; private evidence retained.');
  const summary = { kind: 'source-live-codex-stage', observedAt: new Date().toISOString(), model: 'gpt-6-luna', effort: 'medium',
    executedSuites: completed.length, executedTests: completed.length, skippedTests: 0, completed,
    countsAsRequestedSwarm: false, countsAsBusinessWork: false, billedSpendUsd: null };
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`Live Codex qualification passed; private evidence: ${await qualifyLiveCodex()}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

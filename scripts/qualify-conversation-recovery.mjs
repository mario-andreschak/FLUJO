import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = '__tests__/model/conversationRecovery.live.test.ts';
const routes = ['codex', 'openrouter'];
const { compareToBaseline, summarizeJestResults } = createRequire(import.meta.url)('./verify-test-baseline.cjs');

export function verifyRecoveryQualification(result, receipts) {
  const suites = result?.testResults;
  if (result?.success !== true || result.wasInterrupted || suites?.length !== 1
      || path.relative(root, suites[0].name).split(path.sep).join('/') !== suite
      || suites[0].status !== 'passed' || suites[0].testExecError
      || suites[0].assertionResults?.length !== routes.length) {
    throw new Error('Recovery qualification must execute the complete live suite.');
  }
  for (const route of routes) {
    const cases = suites[0].assertionResults.filter(test => test.fullName === `continues through an oversized tool result on ${route}`);
    const receipt = receipts?.[route];
    if (cases.length !== 1 || cases[0].status !== 'passed' || receipt?.status !== 'passed'
        || receipt.route !== route || receipt.model !== (route === 'codex' ? 'gpt-6-luna' : 'openrouter/free')
        || receipt.exactTailRecovered !== true || receipt.canonicalOriginalPreserved !== true
        || !(receipt.inputCharacters > 1_100_000)) {
      throw new Error(`Live ${route} recovery did not pass its exact-source assertions on the approved route.`);
    }
  }
}

async function main() {
  const directory = process.env.FLUJO_RECOVERY_ACCEPTANCE_ROOT;
  const source = process.env.FLUJO_RECOVERY_SOURCE_ROOT;
  const relative = directory && path.relative(root, directory);
  if (!directory || !path.isAbsolute(directory) || !relative
      || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      || !source || !path.isAbsolute(source)) {
    throw new Error('Set a private absolute FLUJO_RECOVERY_ACCEPTANCE_ROOT outside the checkout and FLUJO_RECOVERY_SOURCE_ROOT.');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const resultFile = path.join(directory, 'jest-results.json');
  const log = await fs.open(path.join(directory, 'qualification.log'), 'wx', 0o600);
  const env = { ...process.env, FLUJO_RECOVERY_ACCEPTANCE: '1', FLUJO_CODEX_AUTO_UPDATE: '0' };
  delete env.OPENAI_API_KEY;
  delete env.FLUJO_PARENT_DATA_DIR;
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/run-local-jest.cjs', '--ci', '--selectProjects', 'node',
        '--runInBand', '--runTestsByPath', suite, '--json', `--outputFile=${resultFile}`],
      { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? -1 : code));
    });
    if (status !== 0) throw new Error(`Live recovery failed; private evidence retained in ${directory}.`);
  } finally { await log.close(); }
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  const receipts = Object.fromEntries(await Promise.all(routes.map(async route =>
    [route, JSON.parse(await fs.readFile(path.join(directory, `${route}-receipt.json`), 'utf8'))])));
  verifyRecoveryQualification(result, receipts);
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'test-baseline.json'), 'utf8'));
  const verdict = compareToBaseline({ stage: 'conversation-recovery-live', baseline, summary: summarizeJestResults(result, root) });
  if (!verdict.ok) throw new Error('Live recovery execution baseline refused.');
  console.log(`Both real recovery routes passed with zero skips. Private evidence: ${directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validatePersonaGoalAcceptance } from './validate-persona-goal-acceptance.mjs';

const options = new Map();
const allowed = new Set(['mode', 'model', 'output', 'timeout-seconds', 'preflight', 'tools']);
for (const value of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(value);
  if (!match || !allowed.has(match[1]) || options.has(match[1])) throw new Error(`Unknown, duplicate or malformed argument: ${value}. Use --name=value.`);
  options.set(match[1], match[2]);
}
const mode = options.get('mode') ?? 'offline';
const toolsMode = options.get('tools') ?? 'structured';
if (!['structured', 'terminal-only'].includes(toolsMode)) throw new Error('--tools must be structured or terminal-only.');
if (toolsMode === 'terminal-only' && mode !== 'live') throw new Error('Terminal-only acceptance requires --mode=live: browser installation/use must be real and model-driven.');
if (options.has('preflight') && options.get('preflight') !== 'true') throw new Error('--preflight only accepts true.');
if (!['offline', 'live'].includes(mode)) throw new Error('Mode must be offline or live. Live mode invokes the configured Codex account.');
if (mode === 'live' && typeof (await import('@openai/codex-sdk')).Codex !== 'function') throw new Error('The genuine Codex SDK could not be loaded.');
const timeoutSeconds = Number(options.get('timeout-seconds') ?? 600);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) throw new Error('Timeout must be 30–3600 seconds.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runId = `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const output = path.resolve(options.get('output') ?? path.join('goal-acceptance-artifacts', runId));
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error(`Output directory must be empty to preserve prior evidence: ${output}`);
const sourceHash = createHash('sha256').update(execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--binary', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] }));
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(name => /^(?:src|scripts|__tests__|docs|\.github)\//.test(name));
for (const name of untracked.sort()) sourceHash.update(name).update(await fs.readFile(name));
const sourceDiffSha256 = sourceHash.digest('hex');
process.stdout.write(`Goal acceptance ${runId}\nMode: ${mode}; tools: ${toolsMode}; model: ${options.get('model') ?? 'gpt-6-astra'}; commit: ${commit}\nEvidence: ${output}\n`);
const child = spawn(process.execPath, [
  path.resolve('scripts/run-local-jest.cjs'), '--selectProjects', 'node', '--runInBand', '--runTestsByPath',
  `--env=${path.resolve('scripts/persona-goal-acceptance/jest-environment.cjs')}`,
  ...(options.get('preflight') === 'true' ? ['--testNamePattern=loads the native SDK'] : []),
  '__tests__/enduringAgents/goalAcceptance.test.ts',
], {
  stdio: 'inherit',
  env: { ...process.env,
    PERSONA_GOAL_ACCEPTANCE_MODE: mode,
    PERSONA_GOAL_ACCEPTANCE_TOOLS: toolsMode,
    PERSONA_GOAL_ACCEPTANCE_MODEL: options.get('model') ?? 'gpt-6-astra',
    PERSONA_GOAL_ACCEPTANCE_OUTPUT: output,
    PERSONA_GOAL_ACCEPTANCE_TIMEOUT_MS: String(timeoutSeconds * 1000),
    PERSONA_GOAL_ACCEPTANCE_COMMIT: commit,
    PERSONA_GOAL_ACCEPTANCE_DIFF_SHA256: sourceDiffSha256,
    PERSONA_GOAL_ACCEPTANCE_RUN_ID: runId,
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', exitCode => resolve(exitCode ?? 1)); });
process.exitCode = code;
if (code === 0 && options.get('preflight') !== 'true') {
  await validatePersonaGoalAcceptance({ directory: output, expectedCommit: commit, expectedMode: mode, expectedSourceDiffSha256: sourceDiffSha256 });
  process.stdout.write(`Validated goal evidence: ${path.join(output, 'persona-goal-acceptance.json')}\n`);
}

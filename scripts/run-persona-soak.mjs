import { spawn, execFileSync } from 'child_process';
import path from 'path';
import process from 'process';

const VALUE_OPTIONS = new Set([
  'days',
  'activities-per-day',
  'seed',
  'output',
  'commit',
  'run-id',
]);
const FLAG_OPTIONS = new Set(['quick', 'infrastructure', 'with-learning']);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const [, key, inlineValue] = match;
    if (!VALUE_OPTIONS.has(key) && !FLAG_OPTIONS.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    if (FLAG_OPTIONS.has(key)) {
      if (inlineValue !== undefined) {
        throw new Error(`Flag --${key} does not accept a value.`);
      }
      values.set(key, '1');
      continue;
    }
    const separateValue = inlineValue === undefined ? argv[index + 1] : undefined;
    const value = inlineValue ?? separateValue;
    if (!value || value.startsWith('--')) {
      throw new Error(`Option --${key} requires a value.`);
    }
    values.set(key, value);
    if (inlineValue === undefined) index += 1;
  }
  return values;
}

const values = parseArguments(process.argv.slice(2));

const days = values.get('days') ?? '28';
const activities = values.get('activities-per-day') ?? '20';
const seed = values.get('seed') ?? '459';
const output = path.resolve(values.get('output') ?? 'soak-artifacts');
const quick = values.has('quick');
if (quick && values.has('infrastructure')) throw new Error('--quick and --infrastructure are mutually exclusive.');
const mode = quick ? 'smoke' : values.has('infrastructure') ? 'infrastructure' : 'acceptance';
const learningEnabled = values.has('with-learning');
if (!quick && (days !== '28' || activities !== '20')) {
  throw new Error('Acceptance mode requires exactly --days=28 --activities-per-day=20; use --quick for a smoke run.');
}
if (!quick && !learningEnabled) {
  throw new Error('Acceptance mode requires --with-learning.');
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const expectedCommit = values.get('commit')
  ?? process.env.FLUJO_SOAK_COMMIT
  ?? process.env.GITHUB_SHA
  ?? head;
if (expectedCommit !== head) {
  throw new Error(`Requested soak commit ${expectedCommit} does not match checked-out HEAD ${head}.`);
}
const runId = values.get('run-id')
  ?? process.env.FLUJO_SOAK_RUN_ID
  ?? process.env.GITHUB_RUN_ID
  ?? `local-${process.pid}-${Date.now()}`;

const env = {
  ...process.env,
  PERSONA_SOAK_DAYS: days,
  PERSONA_SOAK_ACTIVITIES_PER_DAY: activities,
  PERSONA_SOAK_SEED: seed,
  PERSONA_SOAK_OUTPUT: output,
  PERSONA_SOAK_QUICK: quick ? '1' : '0',
  PERSONA_SOAK_FULL: quick ? '0' : '1',
  PERSONA_SOAK_WITH_LEARNING: learningEnabled ? '1' : '0',
  PERSONA_SOAK_COMMIT: expectedCommit,
  PERSONA_SOAK_RUN_ID: runId,
  PERSONA_SOAK_MODE: mode,
};

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const jestCode = await run(process.execPath, [
  path.resolve('scripts/run-local-jest.cjs'),
  '--selectProjects', 'node', '--runInBand',
  '__tests__/enduringAgents/runtimeClock.test.ts',
  '__tests__/enduringAgents/soak/evidence.test.ts',
  '__tests__/enduringAgents/soak/personaSoak.test.ts',
], { env });

if (jestCode !== 0) {
  process.exitCode = jestCode;
} else {
  process.exitCode = await run(process.execPath, [
    path.resolve('scripts/validate-persona-soak-artifacts.mjs'),
    '--directory', output,
    '--commit', expectedCommit,
    '--mode', mode,
  ], { env });
}

import { spawn } from 'child_process';
import path from 'path';
import process from 'process';

const values = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
  if (!match) throw new Error(`Unknown argument: ${argument}`);
  values.set(match[1], match[2] ?? '1');
}
const days = values.get('days') ?? '28';
const activities = values.get('activities-per-day') ?? '20';
const seed = values.get('seed') ?? '459';
const output = path.resolve(values.get('output') ?? 'soak-artifacts');
const quick = values.has('quick') || Number(days) <= 3;
const env = {
  ...process.env,
  PERSONA_SOAK_DAYS: days,
  PERSONA_SOAK_ACTIVITIES_PER_DAY: activities,
  PERSONA_SOAK_SEED: seed,
  PERSONA_SOAK_OUTPUT: output,
  PERSONA_SOAK_QUICK: quick ? '1' : '0',
  PERSONA_SOAK_FULL: quick ? '0' : '1',
  PERSONA_SOAK_WITH_LEARNING: values.has('with-learning') ? '1' : '0',
};
const child = spawn(process.execPath, [
  path.resolve('scripts/run-local-jest.cjs'),
  '--selectProjects', 'node', '--runInBand',
  '__tests__/enduringAgents/runtimeClock.test.ts',
  '__tests__/enduringAgents/soak/personaSoak.test.ts',
], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

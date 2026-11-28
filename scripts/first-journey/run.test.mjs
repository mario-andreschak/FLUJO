import assert from 'node:assert/strict';
import test from 'node:test';
import { NAMES, STAGES, TARGET_SECONDS, main, verdict } from './run.mjs';

test('the journey covers the first-use path in order', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), [
    'home', 'connect-ai', 'test-ai', 'app-tool', 'build-agent', 'run-with-approval', 'inspect-steps', 'reuse-api', 'reuse-mcp',
  ]);
  for (const stage of STAGES) assert.ok(stage.title && typeof stage.run === 'function', stage.id);
  assert.match(NAMES.question, new RegExp(NAMES.tool));
});

test('never drives the everyday FLUJO on port 4200', async () => {
  await assert.rejects(main(['--base-url', 'http://127.0.0.1:4200/'], () => {}), /port 4200/);
});

test('prints help without starting anything', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /npm run drive -- launch/);
  assert.match(lines.join('\n'), /npm run build/);
});

test('keeps --out a plain folder name, because the run clears that folder first', async () => {
  for (const out of ['..', '../evidence', 'a/b', 'a\\b', '.hidden..x']) {
    await assert.rejects(main(['--base-url', 'http://127.0.0.1:4317/', '--out', out], () => {}), /plain folder name/);
  }
});

test('rejects a malformed viewport before a browser starts', async () => {
  await assert.rejects(main(['--base-url', 'http://127.0.0.1:4317/', '--viewport', 'wide'], () => {}), /1280x720/);
});

const passedStages = () => STAGES.map((stage) => ({ id: stage.id, ok: true, seconds: 10 }));

test('a run passes only with every stage, no crash on the page and, on the production build, inside the time target', () => {
  assert.deepEqual(verdict({ server: 'production build', stages: passedStages(), problems: ['console error: noisy'] }).reasons, []);
  assert.match(verdict({ server: 'given', stages: passedStages().slice(1), problems: [] }).reasons.join(), /stage/);
  assert.match(verdict({ server: 'given', stages: passedStages(), problems: ['page error: boom'] }).reasons.join(), /crashed/);
  const slow = passedStages().map((stage) => ({ ...stage, seconds: TARGET_SECONDS }));
  assert.match(verdict({ server: 'production build', stages: slow, problems: [] }).reasons.join(), /target is under 15/);
  assert.equal(verdict({ server: 'given', stages: slow, problems: [] }).passed, true);
});

test('without a running instance it starts its own from the production build', async () => {
  const calls = [];
  const start = async ({ logFile }) => {
    calls.push(logFile);
    throw new Error('No production build');
  };
  await assert.rejects(main(['--out', 'wide'], () => {}, { start }), /No production build/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /first-journey.wide.flujo[.]log$/);
});

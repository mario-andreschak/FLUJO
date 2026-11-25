import assert from 'node:assert/strict';
import test from 'node:test';
import { NAMES, STAGES, main } from './run.mjs';

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
});

test('rejects a malformed viewport before a browser starts', async () => {
  await assert.rejects(main(['--base-url', 'http://127.0.0.1:4317/', '--viewport', 'wide'], () => {}), /1280x720/);
});

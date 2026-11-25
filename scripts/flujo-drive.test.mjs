import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { evidencePath, main, parseArgs, parseViewport, routeUrl, validateSteps } from './flujo-drive.mjs';

test('arguments split into command, positional values and options', () => {
  assert.deepEqual(parseArgs(['click', '/flows', '--role', 'button', '--name', 'New agent', '--full', '--viewport=360x800']), {
    command: 'click',
    positional: ['/flows'],
    options: { role: 'button', name: 'New agent', full: true, viewport: '360x800' },
  });
});

test('viewports and routes are checked before a browser starts', () => {
  assert.deepEqual(parseViewport('360x800'), { width: 360, height: 800 });
  assert.throws(() => parseViewport('wide'), /1280x720/);
  assert.equal(routeUrl('http://127.0.0.1:4317/', '/roles/new'), 'http://127.0.0.1:4317/roles/new');
  assert.equal(routeUrl('http://127.0.0.1:4317/', 'chat'), 'http://127.0.0.1:4317/chat');
  assert.throws(() => routeUrl('http://127.0.0.1:4317/', 'https://example.com/'), /Pass a route/);
  assert.throws(() => routeUrl('http://127.0.0.1:4317/', 'C:/Program Files/Git/flows'), /Git Bash rewrites/);
});

test('relative evidence paths land in the evidence folder outside the repository', () => {
  assert.equal(evidencePath('flows/after.png', '/tmp/evidence'), path.join('/tmp/evidence', 'flows/after.png'));
  const absolute = path.resolve('/elsewhere/after.png');
  assert.equal(evidencePath(absolute, '/tmp/evidence'), absolute);
});

test('steps files are validated with a message that names the step', () => {
  assert.doesNotThrow(() => validateSteps([{ do: 'goto', route: '/flows' }, { do: 'click', role: 'button', name: 'Save' }, { do: 'shot', out: 'a.png' }]));
  assert.throws(() => validateSteps([]), /non-empty/);
  assert.throws(() => validateSteps([{ do: 'hover' }]), /step 1: "do" must be one of/);
  assert.throws(() => validateSteps([{ do: 'goto', route: '/' }, { do: 'fill', label: 'Name' }]), /step 2 \(fill\) needs "value"/);
});

test('commands with missing options fail before launching a browser', async () => {
  await assert.rejects(main(['shot', '/flows'], () => {}), /--out/);
  await assert.rejects(main(['click', '/flows', '--role', 'button'], () => {}), /--role and --name/);
  const lines = [];
  assert.equal(await main([], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /Usage: node scripts\/flujo-drive\.mjs/);
});

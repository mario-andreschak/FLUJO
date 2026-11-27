import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { EXIT, assertThrowawayData, chooseTarget, countResults, isInside, main, renderReport, throwawayRoots } from './run.mjs';

const answer = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

test('exit codes stay fixed: 0 passed, 1 problems found, 2 the sweep could not run', () => {
  assert.deepEqual(EXIT, { passed: 0, problems: 1, broken: 2 });
});

test('a target is chosen explicitly, never port 4200, and never two at once', () => {
  assert.deepEqual(chooseTarget({ release: '3.48.11' }, undefined), { kind: 'release', version: '3.48.11' });
  assert.equal(chooseTarget({ launch: true }, undefined).mode, 'dev');
  assert.equal(chooseTarget({ launch: true, mode: 'start', 'app-dir': 'x' }, undefined).appDir, path.resolve('x'));
  assert.deepEqual(chooseTarget({}, { baseUrl: 'http://127.0.0.1:5123/' }), { kind: 'url', baseUrl: 'http://127.0.0.1:5123/', fromDrive: true });
  assert.throws(() => chooseTarget({}, undefined), /npm run drive -- launch/);
  assert.throws(() => chooseTarget({ 'base-url': 'http://127.0.0.1:4200/' }, undefined), /4200/);
  assert.throws(() => chooseTarget({ release: 'latest' }, undefined), /version such as/);
  assert.throws(() => chooseTarget({ release: '1.0.0', launch: true }, undefined), /Pick one target/);
  assert.throws(() => chooseTarget({ launch: true, mode: 'prod' }, undefined), /dev or start/);
});

test('only an instance whose data sits in a temporary folder may be swept', async () => {
  const roots = ['/tmp'];
  assert.equal(await assertThrowawayData('http://127.0.0.1:5123/', roots, answer({ success: true, mcpServersDir: '/tmp/flujo-drive-data-abc123/mcp-servers' })),
    '/tmp/flujo-drive-data-abc123/mcp-servers');
  await assert.rejects(assertThrowawayData('http://127.0.0.1:5123/', roots, answer({ success: true, mcpServersDir: '/home/me/.flujo/mcp-servers' })), /outside a throwaway folder/);
  await assert.rejects(assertThrowawayData('http://127.0.0.1:5123/', roots, answer({}, 423)), /Could not confirm[\s\S]*423/);
  await assert.rejects(assertThrowawayData('http://127.0.0.1:5123/', roots, async () => { throw new Error('refused'); }), /Could not confirm/);
});

test('folder checks: inside means below, not equal or beside; Windows ignores case', () => {
  assert.equal(isInside('/tmp/a/b', '/tmp', 'linux'), true);
  assert.equal(isInside('/tmp', '/tmp', 'linux'), false);
  assert.equal(isInside('/tmpfoo/a', '/tmp', 'linux'), false);
  if (process.platform === 'win32') assert.equal(isInside('C:\\USERS\\me\\Temp\\x', 'c:\\users\\me\\temp', 'win32'), true);
  assert.ok(throwawayRoots({ RUNNER_TEMP: path.resolve('runner-temp') }, path.resolve('tmp')).includes(path.resolve('runner-temp')));
});

test('counts and the readable report cover every status', () => {
  const entries = [{
    title: 'Settings', checks: [
      { label: 'A', status: 'passed', pageErrors: ['TypeError'] },
      { label: 'B', status: 'failed', error: 'Timeout' },
      { label: 'C', status: 'manual', reason: 'prose' },
      { label: 'D', status: 'needs', reason: 'needs a model' },
      { label: 'E', status: 'not-run', reason: 'FLUJO had stopped answering' },
    ],
  }];
  const counts = countResults(entries);
  assert.deepEqual(counts, { passed: 1, failed: 1, pageErrors: 1, needs: 1, manual: 1, unsafe: 0, notRun: 1 });
  const text = renderReport({
    target: { kind: 'release', version: '3.48.11' }, result: 'problems', exitCode: 1, counts, entries, startedAt: 's', finishedAt: 'f',
    problems: [{ fingerprint: 'rs-0123456789ab', title: 'Release sweep: Settings › B fails', checks: [{ evidence: { screenshot: 'settings/b-failed.png' } }] }],
  });
  assert.match(text, /Result: \*\*problems\*\* \(exit 1\)\. 1 passed, 1 failed, 1 with page errors, 1 not run/);
  assert.match(text, /`rs-0123456789ab` Release sweep: Settings › B fails \(settings\/b-failed\.png\)/);
  assert.match(text, /- failed · B: Timeout/);
});

test('the command line refuses bad input with exit 2 and starts nothing', async () => {
  const lines = [];
  assert.equal(await main(['--base-url', 'http://127.0.0.1:4200/'], (line) => lines.push(line)), EXIT.broken);
  assert.match(lines.join('\n'), /Refusing port 4200/);
  assert.equal(await main(['--release', '1.0.0', '--only', 'no-such-page'], () => {}), EXIT.broken);
  const help = [];
  assert.equal(await main(['--help'], (line) => help.push(line)), EXIT.passed);
  assert.match(help.join('\n'), /--release VERSION/);
});

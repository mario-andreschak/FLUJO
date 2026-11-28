import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { EXIT, assertThrowawayData, chooseTarget, countResults, isInside, main, renderReport, sweep, throwawayRoots } from './run.mjs';

const answer = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

test('exit codes stay fixed: 0 passed, 1 problems found, 2 FLUJO could not start, 3 the sweep machine failed', () => {
  assert.deepEqual(EXIT, { passed: 0, problems: 1, broken: 2, runner: 3 });
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
  assert.deepEqual(counts, { passed: 1, failed: 1, pageErrors: 1, needs: 1, manual: 1, unsafe: 0, notRun: 1, runner: 0, secondTry: 0 });
  const text = renderReport({
    target: { kind: 'release', version: '3.48.11' }, result: 'problems', exitCode: 1, counts, entries, startedAt: 's', finishedAt: 'f',
    problems: [{ fingerprint: 'rs-0123456789ab', title: 'Release sweep: Settings › B fails', checks: [{ evidence: { screenshot: 'settings/b-failed.png' } }] }],
  });
  assert.match(text, /Result: \*\*problems\*\* \(exit 1\)\. 1 passed \(0 only on the second try\), 1 failed, 1 with page errors, 0 stopped by the sweep machine, 1 not run/);
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
  assert.match(help.join('\n'), /--total-timeout SECONDS/);
});

const plan = (labels) => [{
  entry: 'settings', file: 'settings.md', title: 'Settings',
  checks: labels.map((label) => ({ id: `settings/${label.toLowerCase()}`, label, status: 'auto', steps: [{ do: 'goto', route: '/settings' }] })),
}];
const failed = (error) => ({ status: 'failed', error, pageErrors: [], consoleErrors: [] });
const passed = () => ({ status: 'passed', pageErrors: [], consoleErrors: [] });

/** Runs sweep() with scripted check results, one list per check label, and records every try. */
async function scripted(results, extra = {}) {
  const tries = [];
  const browsers = { current: extra.browser ?? { isConnected: () => true, close: async () => {} }, launch: extra.launch };
  const result = await sweep(plan(Object.keys(results)), {
    baseUrl: 'http://127.0.0.1:5123/', viewport: { width: 1280, height: 720 }, out: 'unused', log: () => {},
    checkTimeoutMs: 180_000, pageTimeoutMs: 600_000, browsers, pid: undefined, pause: async () => {},
    stillAnsweringImpl: extra.stillAnswering ?? (async () => true),
    runCheckImpl: async (current, check, options) => {
      tries.push([check.label, options.attempt]);
      const next = results[check.label].shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(current) : next;
    },
    ...extra.options,
  });
  return { ...result, tries, browsers, checks: result.entries[0].checks };
}

test('a failed step runs again in a fresh browser and is a problem only when it fails twice; the first failure is kept', async () => {
  const { checks, tries } = await scripted({
    Broken: [failed('locator.waitFor: Timeout 60000ms exceeded.'), failed('The check took longer than 12s, the time a sweep gives one check.')],
    Flaky: [failed('locator.click: Timeout 30000ms exceeded.'), passed()],
    Fine: [passed()],
  });
  assert.deepEqual(tries, [['Broken', 1], ['Broken', 2], ['Flaky', 1], ['Flaky', 2], ['Fine', 1]]);
  assert.equal(checks[0].status, 'failed');
  assert.equal(checks[0].confirmed, true);
  assert.equal(checks[0].error, 'locator.waitFor: Timeout 60000ms exceeded.', 'the full-time first failure decides the fingerprint');
  assert.match(checks[0].retryError, /took longer than 12s/);
  assert.deepEqual([checks[1].status, checks[1].firstError], ['passed', 'locator.click: Timeout 30000ms exceeded.']);
  assert.equal(countResults([{ checks }]).secondTry, 1);
});

test('a failure the sweep machine caused is retried, and if it persists it is marked "runner", never "failed"', async () => {
  const { checks, tries } = await scripted({
    Disk: [failed('ENOSPC: no space left on device'), failed('ENOSPC: no space left on device'), failed('ENOSPC: no space left on device')],
    Blip: [failed('EMFILE: too many open files'), passed()],
  });
  assert.deepEqual(tries, [['Disk', 1], ['Disk', 2], ['Disk', 3], ['Blip', 1], ['Blip', 2]]);
  assert.deepEqual([checks[0].status, checks[0].reason], ['runner', 'the sweep machine ran out of disk space']);
  assert.deepEqual([checks[1].status, checks[1].firstError], ['passed', undefined]);
});

test("when the sweep's browser dies it is started again before the next try", async () => {
  let launches = 0;
  const fresh = { isConnected: () => true, close: async () => {} };
  const { checks, browsers } = await scripted({
    A: [failed('browser.newContext: Target page, context or browser has been closed'), (current) => (current === fresh ? passed() : failed('wrong browser'))],
  }, { browser: { isConnected: () => false, close: async () => {} }, launch: async () => { launches += 1; return fresh; } });
  assert.equal(launches, 1);
  assert.equal(browsers.current, fresh);
  assert.equal(checks[0].status, 'passed');
});

test('a check that throws is a failure like any other, not the end of the sweep', async () => {
  const { checks } = await scripted({ A: [new Error('page.goto: Page crashed'), new Error('page.goto: Page crashed')], B: [passed()] });
  assert.deepEqual(checks.map((check) => check.status), ['failed', 'passed']);
  assert.equal(checks[0].error, 'page.goto: Page crashed');
});

test('the time limit is kept: steps it does not reach are listed as not run', async () => {
  const { checks, tries } = await scripted({ A: [passed()], B: [passed()] }, { options: { deadline: Date.now() - 1, totalTimeoutMs: 3_600_000 } });
  assert.deepEqual(tries, []);
  assert.deepEqual(checks.map((check) => [check.status, check.reason]), [['not-run', 'the sweep used its 60 minutes'], ['not-run', 'the sweep used its 60 minutes']]);
});

test('when FLUJO stops answering the rest is not run and no retry is spent on it', async () => {
  const { checks, tries, instanceProblem } = await scripted({ A: [failed('page.goto: net::ERR_CONNECTION_REFUSED')], B: [passed()] }, { stillAnswering: async () => false });
  assert.deepEqual(tries, [['A', 1]]);
  assert.match(instanceProblem, /FLUJO stopped answering during settings\/a/);
  assert.deepEqual(checks.map((check) => check.status), ['failed', 'not-run']);
});

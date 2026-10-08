import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The native .test.mjs file is outside ordinary Jest discovery. Run its pure
// parser/correlation controls here; this starts no app, server, MCP client or model.
test('live journey observer native controls execute without missing or skipped cases', () => {
  const root = path.resolve(__dirname, '../..');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL|LC_CTYPE|TZ)$/i.test(name)));
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    'scripts/feature-surface-acceptance/live-journey-observer.test.mjs',
  ], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...environment, NODE_ENV: 'test', NODE_PATH: '', NO_COLOR: '1' } });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  for (const name of [
    'complete synthetic correlations pass only the component, never full acceptance',
    'rejects saved model without actual dispatch',
    'rejects tool result absent from later model input',
    'rejects approval for another call',
    'rejects missing debugger observation',
    'rejects same call ID with wrong archived content',
    'rejects missing full runtime content binding',
    'failed tool results cannot qualify with omitted full binding',
    'failed tool results cannot qualify with matching full binding',
    'full UTF-8 result binding matches archived content despite a truncated event preview',
    'equal event previews cannot hide different full archived tails',
    'one correctly bound call cannot hide another call with wrong content',
    'one fixture receipt cannot satisfy two equal runtime calls',
    'archive projection removes raw tool results and rejects another conversation',
    'SSE rejects reordered sequences and truncated runs',
    'bounded JSON counts UTF-8 bytes and rejects overflow',
    'fixture receipt projection omits unexpected fields before report retention',
    'invalid fixture receipts never enter partial failure reports',
    'SSE refuses the preserved nested pause marker before its output callback',
    'archive metadata rejects the preserved nested marker before report retention',
    'aggregate projection budget refuses accumulation before append',
    'evidence report output budget counts final UTF-8 serialization',
    'fixture discovery refuses extra or private metadata before accumulation',
  ]) expect(result.stdout).toContain(name);
  const tests = Number(result.stdout.match(/^# tests (\d+)\s*$/m)?.[1]);
  const passed = Number(result.stdout.match(/^# pass (\d+)\s*$/m)?.[1]);
  expect(tests).toBeGreaterThanOrEqual(48);
  expect(passed).toBe(tests);
  for (const counter of ['fail', 'cancelled', 'skipped', 'todo']) {
    expect(result.stdout).toMatch(new RegExp(`^# ${counter} 0\\s*$`, 'm'));
  }
  expect(result.stdout).not.toMatch(/^\s*(?:ok|not ok)\b.*#\s*(?:SKIP|TODO)\b/im);
}, 35000);

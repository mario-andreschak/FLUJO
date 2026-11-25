import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Keeps the pilot sheet summary's native node:test suite in normal Jest CI discovery.
test('product-fit pilot sheet summary suite passes without skips', () => {
  const root = path.resolve(__dirname, '../..');
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', 'scripts/product-fit-pilot/sheets.test.mjs',
  ], { cwd: root, encoding: 'utf8', timeout: 40000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_PATH: '' } });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('summarizes weekly use, benefit, problems, drop-outs and missing reports');
  expect(result.stdout).toMatch(/# tests [1-9]\d*/);
  expect(result.stdout).toContain('# fail 0');
  expect(result.stdout).toContain('# skipped 0');
}, 45000);

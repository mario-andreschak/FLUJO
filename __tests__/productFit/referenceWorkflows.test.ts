import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Keep the native data/CLI and real-SDK suites in normal Jest CI discovery.
// The guarded repository runner requires a complete local lockfile installation.
test('product-fit reference workflow boundary suites execute without skips', () => {
  const root = path.resolve(__dirname, '../..');
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    'scripts/product-fit-pilot/reference.test.mjs',
    'scripts/product-fit-pilot/reference-server.test.mjs',
  ], { cwd: root, encoding: 'utf8', timeout: 40000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_PATH: '' } });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('reference data: three read-only tools');
  expect(result.stdout).toContain('installed MCP SDK in-memory protocol:');
  expect(result.stdout).toContain('installed MCP SDK stdio process:');
  expect(result.stdout).toMatch(/# tests [1-9]\d*/);
  expect(result.stdout).toContain('# fail 0');
  expect(result.stdout).toContain('# skipped 0');
  expect(result.stdout).toContain('# cancelled 0');
}, 45000);

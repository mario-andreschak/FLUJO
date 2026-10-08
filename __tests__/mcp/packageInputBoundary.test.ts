import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CI builds the standalone packages before Jest. Import their emitted APIs in
// a disposable child: a synchronous regex regression must hit a process
// deadline, rather than hanging Jest's event loop and its own timeout.
function runPackageCheck(relativeModule: string, check: string): void {
  const moduleUrl = pathToFileURL(path.resolve(relativeModule)).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const api = await import(${JSON.stringify(moduleUrl)});
    ${check}
  `], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
    .toEqual({ error: undefined, status: 0, stderr: '' });
}

describe('compiled MCP input boundaries', () => {
  it('handles long slash runs before validating a worker URL', () => {
    runPackageCheck('mcp-servers/flujo/dist/client.js', `
      const suffix = '/'.repeat(500_000);
      assert.equal(api.flujoBaseUrl({ FLUJO_BASE_URL: 'http://127.0.0.1:4200' + suffix,
        FLUJO_WORKER_MODE: '1' }), 'http://127.0.0.1:4200');
      const pathUrl = 'http://127.0.0.1:4200/' + suffix + 'path';
      assert.equal(api.flujoBaseUrl({ FLUJO_BASE_URL: pathUrl + '/',
        FLUJO_WORKER_MODE: '1' }), pathUrl);
      assert.throws(() => api.flujoBaseUrl({ FLUJO_BASE_URL: 'https://outside.example' + suffix,
        FLUJO_WORKER_MODE: '1' }), /loopback/);
    `);
  });

  it('handles malformed escaped quotes in both advisory entrypoints', () => {
    runPackageCheck('mcp-servers/bash/dist/tools.js', `
      const malformed = 'echo "' + String.fromCharCode(92, 34).repeat(200_000) + " tail ' && next";
      assert.equal(api.commandUsesPosixChaining(malformed), true);
      assert.ok(api.detectDialectMismatch(malformed, 'cmd', () => true)
        .some(warning => warning.includes('single quotes')));
    `);
  });
});

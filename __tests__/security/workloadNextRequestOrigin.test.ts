import { spawnSync } from 'node:child_process';

test('installed NextRequest preserves exact workload URL through the supported application configuration', () => {
  // A genuine Node module load keeps the application .mjs config and installed
  // Next implementation intact. The define is derived from the actual supported
  // config, matching Next's build-time wiring; compiled smoke remains required.
  const script = `
    import config from './next.config.mjs';
    import { NextRequest } from 'next/server.js';
    delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    const source = 'http://127.0.0.1:4200/api/mcp/flujo/tools';
    const normalized = new NextRequest(source).url;
    if (config.skipProxyUrlNormalize !== true) throw new Error('Exact proxy URL configuration missing');
    process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = 'true';
    const urls = [source, 'http://[::1]:4200/api/mcp/flujo/tools',
      'http://127.0.0.1:4201/api/mcp/flujo/tools',
      'http://127.0.0.1:4200/api/mcp/flujo/%74ools',
      'http://127.0.0.1:4200/api/mcp/flujo/tools?workspace=other'];
    console.log(JSON.stringify({ normalized, originals: urls.map(url => new NextRequest(url).url) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const value = JSON.parse(result.stdout.trim());
  expect(value.normalized).toBe('http://localhost:4200/api/mcp/flujo/tools');
  expect(value.originals).toEqual([
    'http://127.0.0.1:4200/api/mcp/flujo/tools',
    'http://[::1]:4200/api/mcp/flujo/tools',
    'http://127.0.0.1:4201/api/mcp/flujo/tools',
    'http://127.0.0.1:4200/api/mcp/flujo/%74ools',
    'http://127.0.0.1:4200/api/mcp/flujo/tools?workspace=other',
  ]);
}, 15_000);

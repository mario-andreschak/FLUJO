import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserInstallFailure,
  runBrowserInstall,
  sanitizeInstallOutput,
} from './install-browser.mjs';

test('sanitizes credentials, tokens, query secrets, and explicit CA paths', () => {
  const secretCa = '/private/corporate/root-ca.pem';
  const output = sanitizeInstallOutput(
    [
      'https://proxy-user:proxy-password@proxy.example.test:8443',
      'Authorization: Bearer sentinel-bearer',
      '//registry.example.test/:_authToken=sentinel-npm-token',
      'https://download.example.test/file?token=sentinel-query-token',
      'API_SECRET=sentinel-env-secret',
      secretCa,
    ].join('\n'),
    {
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example.test:8443',
      NODE_EXTRA_CA_CERTS: secretCa,
    },
  );

  for (const secret of [
    'proxy-user',
    'proxy-password',
    'sentinel-bearer',
    'sentinel-npm-token',
    'sentinel-query-token',
    'sentinel-env-secret',
    secretCa,
  ]) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /\[REDACTED\]/);
});

test('classifies corporate-network browser download failures', () => {
  assert.equal(classifyBrowserInstallFailure('self signed certificate in certificate chain').category, 'TLS_TRUST');
  assert.equal(classifyBrowserInstallFailure('HTTP 407 Proxy Authentication Required').category, 'PROXY_AUTH');
  assert.equal(classifyBrowserInstallFailure('getaddrinfo ENOTFOUND download.example.test').category, 'DNS');
  assert.equal(classifyBrowserInstallFailure('request ETIMEDOUT').category, 'TIMEOUT');
});

test('preserves the browser installer exit code and emits a retryable structured result', () => {
  let diagnostic = '';
  const result = runBrowserInstall({
    env: {},
    spawn: () => ({
      status: 37,
      stdout: '',
      stderr: 'HTTP 407 Proxy Authentication Required',
    }),
    stderr: { write: (chunk) => { diagnostic += chunk; } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 37);
  assert.equal(result.stage, 'patchright-chromium');
  assert.equal(result.code, 'BROWSER_UNAVAILABLE');
  assert.equal(result.retryable, true);
  assert.equal(result.category, 'PROXY_AUTH');
  assert.match(diagnostic, /retry/i);
  assert.match(diagnostic, /node mcp-servers\/browser\/scripts\/install-browser\.mjs/);
  assert.doesNotMatch(diagnostic, /npm run install/);
});

test('dependency installation can defer only managed Chromium provisioning', () => {
  const result = runBrowserInstall({
    env: { FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1' },
    spawn: () => {
      throw new Error('spawn should not be called');
    },
    stderr: { write: () => {} },
  });

  assert.deepEqual(result, {
    ok: true,
    stage: 'patchright-chromium',
    skipped: true,
    exitCode: 0,
  });
});

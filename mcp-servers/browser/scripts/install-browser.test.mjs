import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserInstallFailure,
  installBrowserDependencies,
  runBrowserInstall,
  sanitizeInstallOutput,
  verifyBrowser,
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

test('system dependency installation uses the pinned CLI and propagates apt failure', () => {
  let invocation;
  const code = installBrowserDependencies({
    env: { NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: 'https://proxy.example.test' },
    spawn: (...args) => { invocation = args; return { status: 100 }; },
  });
  assert.equal(code, 100);
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1].slice(1), ['install-deps', 'chromium']);
  assert.equal(invocation[2].stdio, 'inherit');
  assert.equal(invocation[2].env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(invocation[2].env.HTTPS_PROXY, 'https://proxy.example.test');
});

test('browser verification launches full headless Chromium and closes it', async () => {
  let options;
  let closed = false;
  let content;
  await verifyBrowser({ loadChromium: async () => ({ launch: async (value) => {
    options = value;
    return {
      newPage: async () => ({ setContent: async (html) => { content = html; }, title: async () => 'FLUJO browser verification' }),
      close: async () => { closed = true; },
    };
  } }) });
  assert.equal(options.channel, 'chromium');
  assert.equal(options.headless, true);
  assert.match(content, /FLUJO browser verification/);
  assert.equal(closed, true);
});

test('browser verification fails on missing libraries rather than accepting a downloaded binary', async () => {
  const error = new Error('error while loading shared libraries: libglib-2.0.so.0');
  await assert.rejects(verifyBrowser({ loadChromium: async () => ({ launch: async () => { throw error; } }) }), error);
  assert.equal(classifyBrowserInstallFailure(error.message).category, 'OS_DEPENDENCY');
});

test('browser verification closes the process when rendering fails', async () => {
  let closed = false;
  await assert.rejects(verifyBrowser({ loadChromium: async () => ({ launch: async () => ({
    newPage: async () => { throw new Error('page failed'); },
    close: async () => { closed = true; },
  }) }) }), /page failed/);
  assert.equal(closed, true);
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

#!/usr/bin/env node
// Focused #1093 source-production OAuth check. Run through flujo-bash MCP.
// The browser completes the real provider login/consent; no grant is fabricated.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';
import { writePrivateJson } from './local-instance.mjs';
import { retainOAuthAcceptance } from './mcp-oauth-credentials.mjs';

const args = process.argv.slice(2).join(' ');
assert.ok(['--production --banking', '--production --slack'].includes(args),
  'Usage: smoke-mcp-oauth.mjs --production --banking|--slack (build first; explicit provider opt-in)');
const slack = args.endsWith('--slack');
const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issuer = slack ? 'https://mcp.slack.com' : 'https://banking-mcp.com';
const resource = slack ? issuer : issuer + '/api/mcp', name = slack ? 'oauth-live-slack' : 'oauth-live-banking';
let existingSlack;
let configuredInputFilesUnchanged;
let credentialFormat, originalRing, originalMetadataPath;
const credentialReceipt = process.env.FLUJO_OAUTH_CREDENTIAL_RECEIPT;
if (slack) {
  assert.ok(process.env.FLUJO_OAUTH_SLACK_CONFIG && path.isAbsolute(process.env.FLUJO_OAUTH_SLACK_CONFIG),
    'An explicit existing Slack configuration path is required');
  const configuredPath = process.env.FLUJO_OAUTH_SLACK_CONFIG;
  const configuredBytes = await fs.readFile(configuredPath);
  existingSlack = JSON.parse(configuredBytes)['mcp-slack-com'];
  assert.ok(credentialReceipt && path.isAbsolute(credentialReceipt), 'An explicit private credential destination is required');
  assert.ok(existingSlack.oauthClientId && existingSlack.oauthClientSecret && existingSlack.oauthTokens?.scope,
    'An existing client and granted scope record are required; legacy tokens are never copied or stamped');
  if (existingSlack.oauthClientSecret.startsWith('encrypted:')) {
    const metadataPath = path.join(path.dirname(configuredPath), 'encryption_key.json');
    const metadataBytes = await fs.readFile(metadataPath), metadata = JSON.parse(metadataBytes);
    assert.equal(metadata.encryption_version, 2);
    assert.equal(metadata.encryption_type, 'default', 'Private passphrase profiles require their ordinary unlock flow');
    assert.ok(!metadata.key_protection, 'This read-only route does not read an operator/private keyring');
    const filename = path.join(application, 'src/utils/encryption/format.ts');
    const require = createRequire(import.meta.url), ts = require('typescript');
    const loaded = new Module(filename); loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, filename);
    const format = loaded.exports, ring = await format.unwrapKeyring(metadata, format.DEFAULT_PASSWORD);
    credentialFormat = format; originalRing = ring; originalMetadataPath = metadataPath;
    const ciphertext = existingSlack.oauthClientSecret.slice('encrypted:'.length);
    existingSlack.oauthClientSecret = ciphertext.startsWith('v2:')
      ? format.open(ciphertext, ring.activeKey, 'flujo:secret:v2') : format.decryptLegacy(ciphertext, ring.legacyKey);
    assert.ok(existingSlack.oauthClientSecret && !existingSlack.oauthClientSecret.startsWith('encrypted:'));
    assert.deepEqual(await fs.readFile(metadataPath), metadataBytes);
  }
  assert.deepEqual(await fs.readFile(configuredPath), configuredBytes);
  assert.ok(credentialFormat && originalRing, 'Only the selected existing encrypted Slack client is supported');
  configuredInputFilesUnchanged = true;
}
const existingScopes = slack ? existingSlack.oauthTokens.scope.split(/[ ,]+/).filter(Boolean) : ['accounts:read'];
const finishFile = process.env.FLUJO_OAUTH_FINISH_FILE;
assert.ok(finishFile && path.isAbsolute(finishFile), 'An owned finish marker path is required');
const password = randomBytes(32).toString('hex');
const receipt = { schemaVersion: 1, provider: issuer, externalModelCalls: 0,
  configuredInputFilesUnchanged,
  buildId: (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim(),
  sourceHashes: {}, equipmentHashes: {}, wire: [], callbacks: [], limitations: [
    'Source production application; not installed, hosted or combined release qualification',
    'Constructed negative callbacks are not provider-generated responses',
    'No connected banking account, financial operation or model inference is requested',
  ] };
for (const file of ['src/backend/services/mcp/oauth.ts', 'src/app/api/oauth/initiate/route.ts',
  'src/app/api/oauth/callback/route.ts', 'src/backend/services/mcp/oauthCredentialStorage.ts', 'src/utils/encryption/format.ts', 'package-lock.json']) {
  receipt.sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(application, file))).digest('hex');
}
for (const file of ['scripts/smoke-mcp-oauth.mjs', 'scripts/mcp-oauth-observer.cjs',
  'scripts/mcp-oauth-credentials.mjs', 'scripts/smoke-bundled-operator.mjs']) {
  receipt.equipmentHashes[file] = createHash('sha256').update(await fs.readFile(path.join(application, file))).digest('hex');
}
let operator, child, closed, base, root, authorizationUrl, failure;
let logs = '';
const browserEntry = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/begin' && authorizationUrl) {
    response.writeHead(302, { location: authorizationUrl, 'cache-control': 'no-store' }); response.end();
  } else { response.writeHead(404); response.end(); }
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() {
  const server = http.createServer(), port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}
async function api(endpoint, body) {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', 'default-workspace');
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const result = await response.json();
  if (!response.ok) receipt.failedApi = { endpoint, status: response.status,
    authMethodError: /token.endpoint.auth.method|client authentication method/i.test(result.error ?? ''),
    issuerError: /issuer/i.test(result.error ?? ''), registrationError: /registration|client.metadata/i.test(result.error ?? ''),
    diagnosticTerms: ['credential', 'unavailable', 'locked', 'global', 'decrypt', 'mismatch', 'network', 'invalid', 'scope',
      'resource', 'authorization', 'client', 'secret', 'issuer', 'fetch', 'timeout', 'registration'].filter(word => String(result.error).toLowerCase().includes(word)) };
  assert.ok(response.ok, `OAuth application route ${endpoint} returned ${response.status}`);
  return result;
}
async function config() {
  const stored = JSON.parse(await fs.readFile(path.join(root, 'data/workspaces/default-workspace/db/mcp_servers.json'), 'utf8'));
  return stored[name];
}
async function preserveAuthorization() {
  if (!slack) return;
  let current;
  try { current = await config(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!current.oauthTokens) return;
  Object.assign(receipt, await retainOAuthAcceptance({ format: credentialFormat, originalRing, originalMetadataPath,
    privateDatabase: path.join(root, 'data/workspaces/default-workspace/db'), password, tokens: current.oauthTokens,
    issuer, destination: credentialReceipt }));
}
async function initiate() {
  const result = await api('/api/oauth/initiate', { serverName: name });
  assert.equal(typeof result.authorizationUrl, 'string');
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, slack ? 'https://slack.com' : issuer);
  assert.equal(url.pathname, slack ? '/oauth/v2_user/authorize' : '/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(url.searchParams.get('redirect_uri')).origin, base);
  assert.equal(url.searchParams.get('resource'), resource);
  assert.ok((url.searchParams.get('scope') ?? '').split(' ').every(scope => existingScopes.includes(scope)),
    'The authorization must not request permissions outside the existing grant');
  const saved = await config();
  assert.equal(saved.oauthStateDiscovery.authorizationServerMetadata.issuer, issuer);
  assert.equal(saved.oauthState, url.searchParams.get('state'));
  if (slack) assert.ok(saved.oauthClientSecret.startsWith('encrypted:'));
  else assert.equal(saved.oauthClientInformation.format, 'flujo-oauth-v1');
  assert.equal(saved.oauthCodeVerifier.format, 'flujo-oauth-v1');
  authorizationUrl = result.authorizationUrl;
  return url;
}
async function callback(method, state, params, expected) {
  const url = new URL('/api/oauth/callback', base); url.searchParams.set('workspace', 'default-workspace');
  const body = new URLSearchParams({ state, ...params });
  if (method === 'GET') for (const [key, value] of body) url.searchParams.set(key, value);
  const before = receipt.wire.filter(value => value.operation === 'token').length;
  const response = await fetch(url, { method, redirect: 'manual',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } : {}) });
  assert.equal(response.status, 307);
  const actual = new URL(response.headers.get('location')).searchParams.get('oauth_error');
  assert.equal(actual, expected);
  assert.equal(receipt.wire.filter(value => value.operation === 'token').length, before);
  receipt.callbacks.push({ method, case: params.error ? 'error-issuer' : expected === 'invalid_state' ? 'invalid-state' : 'code-issuer',
    result: actual, tokenRequests: 0 });
}

try {
  operator = await createSmokeOperator(); root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
  for (const directory of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, directory));
  const port = slack ? 4200 : await unusedPort(), sandbox = await unusedPort();
  base = `http://${slack ? 'localhost' : '127.0.0.1'}:${port}`;
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(key)));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--require', path.join(application, 'scripts/mcp-oauth-observer.cjs')],
      env: { ...safe, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_APP_ROOT: application, FLUJO_BASE_URL: base,
        FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_PORT: String(port),
        FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandbox) },
    });
    child.once('error', reject); child.once('exit', () => reject(new Error('App exited before readiness')));
    child.on('message', message => {
      if (message?.type === 'journey-server-ready' && message.pid === child.pid) resolve();
      if (message?.type === 'oauth-wire') { const record = { ...message }; delete record.type; receipt.wire.push(record); }
    });
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = `${logs}${bytes}`.slice(-96_000); });
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('App readiness timeout'); })]);
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { action, password })).success, true);
  await api('/api/mcp/servers', { name, transport: 'streamable', serverUrl: slack ? issuer + '/mcp' : resource,
    disabled: true, oauthScopes: existingScopes,
    ...(slack ? { oauthClientId: existingSlack.oauthClientId, oauthClientSecret: existingSlack.oauthClientSecret, oauthIssuer: issuer } : {}) });
  const first = await initiate(), state = first.searchParams.get('state');
  assert.deepEqual(receipt.wire.filter(value => value.operation === 'register'), slack ? []
    : [{ operation: 'register', applicationType: 'native', tokenEndpointAuthMethod: 'client_secret_post', loopbackRedirect: true, status: 201 }]);
  receipt.clientRegistration = slack ? 'existing manually registered client; unchanged permissions' : 'live dynamic registration';
  for (const method of ['GET', 'POST']) {
    await callback(method, state, { code: 'constructed-negative-code', iss: issuer + '/' }, 'invalid_issuer');
    await callback(method, state, { error: 'access_denied', iss: 'https://other.invalid' }, 'invalid_issuer');
    await callback(method, 'x'.repeat(43), { code: 'constructed-negative-code', iss: issuer }, 'invalid_state');
  }
  await callback('GET', state, { error: 'access_denied', iss: issuer }, 'access_denied');
  await callback('GET', state, { code: 'constructed-replay', iss: issuer }, 'invalid_state');
  await initiate();
  receipt.authorizationPrepared = true;
  receipt.providerIssuerResponseRequired = (await config()).oauthStateDiscovery.authorizationServerMetadata.authorization_response_iss_parameter_supported === true;
  const browserPort = await listen(browserEntry);
  console.log(JSON.stringify({ oauthBrowserEntry: `http://127.0.0.1:${browserPort}/begin`, appPid: child.pid,
    privateProfile: root, negativeCallbacksPassed: receipt.callbacks.length, providerRegistration: receipt.wire }));
  const end = Date.now() + 10 * 60_000;
  for (;;) {
    const current = await config();
    if (current.oauthTokens) {
      assert.equal(current.oauthTokens.format, 'flujo-oauth-v1');
      assert.equal(current.oauthState, undefined); assert.equal(current.oauthCodeVerifier, undefined);
      receipt.exchangeCompleted = true;
      assert.equal((await api('/api/oauth/initiate', { serverName: name })).alreadyAuthorized, true);
      receipt.refreshCompleted = receipt.wire.some(value => value.grantType === 'refresh_token' && value.status === 200);
      assert.equal(receipt.refreshCompleted, true, 'A genuine refresh response is required');
      break;
    }
    try { await fs.access(finishFile); receipt.providerFlowIncomplete = true; break; } catch { /* Continue within bounded interactive window. */ }
    assert.ok(Date.now() < end, 'Provider browser authorization timed out');
    await delay(1000);
  }
  assert.ok(!logs.includes(password) && !logs.includes(operator.token), 'No owned credentials may enter app logs');
} catch (error) {
  failure = error;
  // Assertions can include a provider URL/credential. Emit only a fixed phase.
  console.error(JSON.stringify({ oauthFailure: error.name, stage: receipt.authorizationPrepared ? 'provider-exchange' : 'authorization-preparation',
    frames: error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3) }));
} finally {
  if (child?.connected && child.exitCode === null && child.signalCode === null) child.send('stop');
  if (closed) {
    const exit = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Owned app closure timeout; private profile retained'); })]);
    assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); receipt.appClosed = true;
  }
  browserEntry.closeAllConnections();
  if (browserEntry.listening) await new Promise(resolve => browserEntry.close(resolve));
  if (operator) {
    try { await preserveAuthorization(); }
    catch {
      // Preserve recoverable real credentials if their separate private save fails.
      await writePrivateJson(path.join(root, 'oauth-recovery.json'), { workspacePassword: password });
      throw new Error('Credential retention failed; private recovery profile retained');
    }
    await operator.restore(); receipt.privateProfileRemoved = true;
  }
}
console.log(JSON.stringify({ oauthReceipt: { ...receipt, localPreparationPassed: !failure,
  realProviderAcceptancePassed: !failure && receipt.exchangeCompleted === true && receipt.refreshCompleted === true,
  node: process.version, platform: process.platform } }));
if (failure) process.exitCode = 1;

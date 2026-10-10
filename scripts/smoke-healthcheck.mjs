// Real built HTTP server; fresh private authority/storage; no provider effects.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkHealth } from './healthcheck.mjs';

const arguments_ = process.argv.slice(2);
const directories = arguments_.filter(value => !value.startsWith('--'));
assert.ok(directories.length <= 1 && arguments_.every(value => !value.startsWith('--') || value === '--expect-previous-failure'),
  'Usage: node scripts/smoke-healthcheck.mjs [APPLICATION] [--expect-previous-failure]');
const application = path.resolve(directories[0] || fileURLToPath(new URL('../', import.meta.url)));
await fs.access(path.join(application, '.next/BUILD_ID'));
const { createSmokeOperator } = await import(pathToFileURL(path.join(application, 'scripts/smoke-bundled-operator.mjs')).href);
const operator = await createSmokeOperator();
const password = randomBytes(32).toString('base64url');
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const unusedPort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
};
let child, closed, serverLog = '', failed = false;
async function retainDiagnostics() {
  failed = true;
  try {
    await fs.writeFile(path.join(root, 'server.log'), serverLog.replaceAll(operator.token, '[redacted]').replaceAll(password, '[redacted]'), { mode: 0o600 });
    console.error(`Private smoke evidence retained at ${root}`);
  } catch { console.error(`Private smoke evidence retention unavailable at ${root}`); }
}
try {
  const port = await unusedPort(), sandboxPort = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const environment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...environment, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
        TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_EXPOSURE_MODE: 'localhost',
        FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1',
        FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject);
    child.once('message', message => {
      if (message?.type === 'journey-server-ready' && message.pid === child.pid) resolve();
      else reject(new Error('Owned server returned an invalid readiness receipt.'));
    });
    child.once('exit', () => reject(new Error('Owned server exited before readiness.')));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('Owned server startup deadline exceeded.'); })]);
  const probe = token => checkHealth({ env: { FLUJO_PORT: String(port), ...(token === undefined ? {} : { FLUJO_HEALTHCHECK_TOKEN: token }) } });
  const api = (action, extra = {}) => fetch(`${base}/api/encryption/secure`, { method: 'POST',
    headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }), signal: AbortSignal.timeout(20_000) });
  assert.equal((await api('status')).status, 200);
  assert.equal((await fetch(`${base}/api/cwd`, { headers: { authorization: `Bearer ${operator.token}` },
    signal: AbortSignal.timeout(20_000) })).status, 423);
  assert.equal(await probe(operator.token), false);
  const initialized = await api('initialize', { password });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).success, true);
  assert.equal(await probe(operator.token), false);
  const unlocked = await api('authenticate', { password });
  assert.equal(unlocked.status, 200);
  assert.equal((await unlocked.json()).success, true);
  assert.equal(await probe(), false);
  assert.equal(await probe('synthetic-wrong-owner-token'), false);
  assert.equal(await probe(operator.token), true);
  const original = await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE, 'utf8');
  for (const change of [record => { record.scopes = ['mcp:access']; }, record => { record.revokedAt = Date.now(); },
    record => { record.expiresAt = Date.now() - 1; }]) {
    const policy = JSON.parse(original); change(policy.credentials[0]);
    await fs.writeFile(operator.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify(policy));
    assert.equal(await probe(operator.token), false);
  }
  await fs.writeFile(operator.env.FLUJO_OWNER_AUTH_FILE, original);
  assert.equal(await probe(operator.token), true);
  // The previous shipped script ignores the owner token and fails after unlock.
  if (arguments_.includes('--expect-previous-failure')) {
    const previous = await import(pathToFileURL(path.join(application, 'scripts/healthcheck.mjs')).href);
    assert.equal(await previous.checkHealth({ env: { FLUJO_PORT: String(port), FLUJO_HEALTHCHECK_TOKEN: operator.token } }), false);
  }
} catch (error) {
  await retainDiagnostics();
  throw error;
} finally {
  try {
    if (child?.connected && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve()));
    }
    if (closed) {
      const result = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Owned server failed graceful shutdown; private evidence retained.'); })]);
      assert.ok(result.code === 0 || result.code === 143 || result.signal === 'SIGTERM', 'Owned server failed graceful shutdown; private evidence retained.');
    }
    if (!failed) await operator.restore();
  } catch (error) {
    await retainDiagnostics();
    throw error;
  }
}
console.log('PASS: built owner-authenticated readiness, pre-unlock refusal, missing/wrong/scope/revoked/expired credential refusal, authority restoration and graceful cleanup.');

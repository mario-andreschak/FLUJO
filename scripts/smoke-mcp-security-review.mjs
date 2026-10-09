// Actual built HTTP admission + public-source capture + pinned offline engine.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

const image = process.argv[2];
assert.match(image ?? '', /^sha256:[0-9a-f]{64}$/, 'Usage: node scripts/smoke-mcp-security-review.mjs LOCAL_IMAGE_ID');
const application = fileURLToPath(new URL('../', import.meta.url));
await fs.access(path.join(application, '.next/BUILD_ID'));
const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
assert.equal(context.status, 0);
const operator = await createSmokeOperator();
const originalPolicy = await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE);
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const password = randomBytes(32).toString('base64url');
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
let child, closed, serverLog = '', failed = false, evidence;
async function retain() {
  failed = true;
  await fs.writeFile(path.join(root, 'server.log'), serverLog.replaceAll(operator.token, '[redacted]').replaceAll(password, '[redacted]'), { mode: 0o600 });
  console.error(`Private smoke diagnostics retained at ${root}`);
}
try {
  const port = await unusedPort(), sandboxPort = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...env, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        DOCKER_HOST: context.stdout.trim(), FLUJO_SKILLSPECTOR_IMAGE: image,
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_EXPOSURE_MODE: 'localhost',
        FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject);
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid server readiness receipt')));
    child.once('exit', () => reject(new Error('Server exited before readiness')));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('Server startup timeout'); })]);
  const body = { repositoryUrl: 'https://github.com/mario-andreschak/mcp-image-recognition' };
  const post = (payload, token = operator.token, origin) => fetch(`${base}/api/mcp/security-review`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000),
  });
  assert.equal((await post(body, '')).status, 401);
  assert.equal((await post(body, 'wrong-owner')).status, 401);
  assert.equal((await post(body, operator.token, 'https://untrusted.invalid')).status, 403);
  assert.equal((await post(body)).status, 423);
  const encryption = action => fetch(`${base}/api/encryption/secure`, { method: 'POST',
    headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, password }), signal: AbortSignal.timeout(20_000) });
  for (const action of ['initialize', 'authenticate']) {
    const response = await encryption(action); assert.equal(response.status, 200); assert.equal((await response.json()).success, true);
  }
  assert.equal((await post({ repositoryUrl: 'http://127.0.0.1/private' })).status, 400);
  assert.equal((await post({ ...body, modelKey: 'not-accepted' })).status, 400);
  assert.equal((await post({ repositoryUrl: 'x'.repeat(5000) })).status, 400);
  const response = await post(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.success, true);
  assert.ok(['partial', 'reviewed'].includes(result.review.status), `Actual source review unavailable: ${result.review.status}`);
  const review = result.review;
  assert.equal(review.source.repositoryUrl, body.repositoryUrl);
  assert.match(review.source.revision, /^[a-f0-9]{40}$/);
  assert.match(review.source.digest, /^[a-f0-9]{64}$/);
  assert.ok(review.source.fileCount > 1);
  assert.equal(review.scanner.imageId, image);
  assert.equal(review.scanner.mode, 'static');
  assert.equal(review.scanner.dependencyLookup, 'offline');
  assert.ok(review.limitations.some(value => value.includes('Offline')));
  assert.equal('safe_to_install' in review, false);
  // Qualify browser-style disconnect against the actual built route after its
  // scanner reaches Running; a staging-only abort is weaker evidence.
  const controller = new AbortController();
  const cancellable = fetch(`${base}/api/mcp/security-review`, {
    method: 'POST', headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryUrl: 'https://github.com/mario-andreschak/mcp-voice' }), signal: controller.signal,
  }).then(() => ({ aborted: false }), () => ({ aborted: true }));
  let activeId;
  try {
    const deadline = Date.now() + 30_000;
    while (!activeId && Date.now() < deadline) {
      await delay(100);
      const list = spawnSync('docker', ['ps', '--filter', 'name=^/flujo-security-review-', '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(list.status, 0);
      for (const id of list.stdout.trim().split('\n').filter(Boolean)) {
        const inspected = spawnSync('docker', ['inspect', id], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        assert.equal(inspected.status, 0);
        const [record] = JSON.parse(inspected.stdout);
        if (record.Image === image && record.State.Running && record.Config.Cmd[0] === 'scan') activeId = record.Id;
      }
    }
    assert.ok(activeId, 'Observe actual route scanner before disconnect');
    const concurrent = await post(body);
    assert.equal(concurrent.status, 200);
    assert.equal((await concurrent.json()).review.status, 'unavailable');
  } finally {
    controller.abort();
    assert.equal((await cancellable).aborted, true);
  }
  const cleanupDeadline = Date.now() + 30_000;
  while (Date.now() < cleanupDeadline) {
    const listing = spawnSync('docker', ['ps', '--all', '--no-trunc', '--filter', `id=${activeId}`, '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(listing.status, 0);
    if (!listing.stdout.trim()) break;
    await delay(200);
  }
  const residual = spawnSync('docker', ['ps', '--all', '--no-trunc', '--filter', `id=${activeId}`, '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(residual.status, 0); assert.equal(residual.stdout.trim(), '');
  // Capacity remains owned until seed+volume cleanup finishes, then is reusable.
  let resumed;
  const resumeDeadline = Date.now() + 30_000;
  do {
    await delay(200);
    const resumedResponse = await post({ repositoryUrl: 'https://github.com/mario-andreschak/mcp-voice' });
    assert.equal(resumedResponse.status, 200);
    resumed = (await resumedResponse.json()).review;
  } while (resumed.status === 'unavailable' && !resumed.source && Date.now() < resumeDeadline);
  assert.ok(['partial', 'reviewed'].includes(resumed.status), 'Review capacity recovers after disconnected scanner cleanup');
  assert.equal(await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE).then(value => value.equals(originalPolicy)), true);
  await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
  evidence = { builtHttpAdmission: true, unlockedOwnerOnly: true, invalidBodiesRefused: true, livePublicSource: review.source,
    scanner: review.scanner, status: review.status, risk: review.risk, findings: review.findings.length,
    reportSha256: createHash('sha256').update(JSON.stringify(review)).digest('hex'), authorityUnchanged: true,
    actualHttpDisconnectCleanup: true, concurrentReviewRefused: true, capacityRecovered: true };
} catch (error) {
  await retain(); throw error;
} finally {
  try {
    if (child?.connected && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve()));
    if (closed) {
      const exit = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Server cleanup timeout'); })]);
      assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM');
    }
    if (!failed) await operator.restore();
  } catch (error) { await retain(); throw error; }
}
console.log(JSON.stringify({ ...evidence, gracefulCleanup: true }, null, 2));

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpFixture } from './fixture-server.mjs';

const launcher = fileURLToPath(new URL('../persona-browser-acceptance/next-process.cjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function inspectCandidateRoot(applicationRoot) {
  const root = await fs.realpath(applicationRoot);
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { await fs.access(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Candidate has a dotenv file; do not load private configuration into this disposable runner.');
  }
  const [build, manifest] = await Promise.all([
    fs.readFile(path.join(root, '.next', 'BUILD_ID')), fs.readFile(path.join(root, 'package.json')),
  ]);
  const pkg = JSON.parse(manifest);
  if (!build.toString().trim() || pkg.name !== 'flujo-ai' || typeof pkg.version !== 'string') {
    throw new Error('Expected a compiled flujo-ai candidate.');
  }
  return { applicationRoot: root, buildId: build.toString().trim(), packageVersion: pkg.version,
    packageManifestSha256: sha256(manifest), buildIdSha256: sha256(build),
    sourceCorrespondence: 'not_verified', installedAcceptance: 'not_evaluated' };
}

/** New anonymous loopback test profile; never inherits account/provider/security configuration. */
export function fixtureRuntimeEnvironment({ dataDir, baseURL, fixtureUrl, hostEnvironment = process.env }) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(hostEnvironment).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...env, FLUJO_DATA_DIR: dataDir, FLUJO_BASE_URL: baseURL,
    FLUJO_TELEMETRY_URL: `${fixtureUrl}/disabled-telemetry`, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
}

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

/** Observe exit and drained pipes before finishing the retained log. */
export function observeOwnedCandidate(child) {
  const epoch = { pid: child.pid ?? null, startedAt: new Date().toISOString(), exitedAt: null,
    closedAt: null, ioDrainedAt: null, completedAt: null, exitCode: null, signal: null, forcedStop: false, processError: null };
  child.on('error', error => { epoch.processError = error.message; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    epoch.exitedAt = new Date().toISOString(); epoch.exitCode = code; epoch.signal = signal;
    resolve();
  }));
  child.once('close', () => { epoch.closedAt = new Date().toISOString(); });
  const streams = Promise.all([child.stdout, child.stderr].filter(Boolean).map(stream => (
    stream.destroyed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve))
  ))).then(() => { epoch.ioDrainedAt = new Date().toISOString(); });
  // On Windows, explicitly disconnecting IPC can suppress ChildProcess.close
  // even after exit and both pipes close. Record those observations separately.
  const completed = Promise.all([exited, streams]).then(() => { epoch.completedAt = new Date().toISOString(); });
  return { child, epoch, completed };
}

export async function stopOwnedCandidate(record, { graceMs = 30000, forceMs = 5000 } = {}) {
  if (record.epoch.completedAt) {
    if (record.epoch.exitCode === 0 || record.epoch.exitCode === 143) return;
    throw new Error(`Disposable candidate already exited (${record.epoch.exitCode ?? record.epoch.signal}).`);
  }
  const wait = ms => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    record.completed.then(() => { clearTimeout(timer); resolve(true); });
  });
  const { child, epoch } = record;
  let sendError;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.connected) sendError = new Error('Owned IPC channel is disconnected.');
    else await new Promise(resolve => {
      child.send('stop', error => { sendError = error; resolve(); });
    });
  }
  if (!sendError && await wait(graceMs)) {
    if (epoch.exitCode === 0 || epoch.exitCode === 143) return;
    throw new Error(`Disposable candidate stop failed (${epoch.exitCode ?? epoch.signal}).`);
  }
  epoch.forcedStop = true;
  child.kill(); // Only the child created and observed by this invocation.
  const observed = await wait(forceMs);
  throw new Error(`Disposable candidate required forced shutdown; exit and pipe closure ${observed ? 'observed' : 'not observed'}.`);
}

export async function createFeatureBrowserEnvironment({ applicationRoot, port = 0 } = {}) {
  if (!applicationRoot) throw new Error('Set FEATURE_BROWSER_APP_DIR to the coordinator-selected compiled candidate.');
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('Invalid feature browser port.');
  const candidate = await inspectCandidateRoot(applicationRoot);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-feature-browser-'));
  let fixture;
  let baseURL;
  let appLog;
  let child;
  let owned;
  let closed = false;
  const snapshot = () => ({ scope: 'automated browser observations in disposable anonymous loopback profile',
    ...candidate, dataDir, baseURL, epoch: owned ? { ...owned.epoch } : null, fixture: fixture?.state.snapshot() ?? null,
    limitations: ['Artifact/source correspondence not verified by this runner.', 'Not human, real-provider, private/shared-profile or full feature-matrix acceptance.'] });
  const request = async (route, body, timeoutMs = 15000) => {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Expected a same-instance route.');
    const url = new URL(route, baseURL);
    url.searchParams.set('workspace', 'default-workspace');
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Disposable candidate request failed: ${url.pathname} (${response.status}).`);
    return response.json();
  };
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (owned) await stopOwnedCandidate(owned);
    } finally {
      try { await fixture?.close(); }
      finally {
        if (appLog) await new Promise(resolve => appLog.end(resolve));
        await fs.writeFile(path.join(dataDir, 'environment-final.json'), JSON.stringify(snapshot(), null, 2));
      }
    }
  }
  try {
    fixture = await startHttpFixture();
    const selectedPort = port || await freePort();
    baseURL = `http://127.0.0.1:${selectedPort}`;
    appLog = createWriteStream(path.join(dataDir, 'application.log'));
    child = fork(launcher, [String(selectedPort)], { cwd: candidate.applicationRoot,
      env: fixtureRuntimeEnvironment({ dataDir, baseURL, fixtureUrl: fixture.url }), silent: true, windowsHide: true });
    owned = observeOwnedCandidate(child);
    child.stdout.pipe(appLog, { end: false });
    child.stderr.pipe(appLog, { end: false });
    await new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); child.off('message', ready); child.off('error', failed); child.off('exit', exited); };
      const ready = message => { if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clean(); resolve(); } };
      const failed = error => { clean(); reject(error); };
      const exited = code => { clean(); reject(new Error(`Disposable candidate exited before ownership handshake (${code}).`)); };
      const timer = setTimeout(() => { clean(); reject(new Error('Disposable candidate ownership handshake timed out.')); }, 60000);
      child.on('message', ready); child.once('error', failed); child.once('exit', exited);
    });
    // An HTTP response from an unrelated listener cannot substitute for the private IPC handshake.
    let ready = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned candidate is no longer running.');
      try { await request('/api/workspaces', undefined, Math.max(1, Math.min(3000, deadline - Date.now()))); ready = true; break; }
      catch { await pause(250); }
    }
    if (!ready) throw new Error('Owned disposable candidate did not become API-ready.');
    const existing = await request('/api/storage?key=mcp_servers');
    const configs = Object.fromEntries(Object.entries(existing.value ?? {}).map(([name, value]) => [name, { ...value, disabled: true }]));
    for (const [name, transport, endpoint] of [['Feature HTTP fixture', 'streamable', '/mcp'], ['Feature SSE fixture', 'sse', '/sse']]) {
      configs[name] = { name, transport, serverUrl: `${fixture.url}${endpoint}`, headers: {}, env: {}, disabled: false,
        enableMcpApps: true, rootPath: '', _buildCommand: '', _installCommand: '' };
    }
    await request('/api/storage', { key: 'mcp_servers', value: configs });
    await fs.writeFile(path.join(dataDir, 'environment-start.json'), JSON.stringify(snapshot(), null, 2));
    return { ...candidate, dataDir, baseURL, fixture, request, snapshot, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw new Error(`${error.message} Retained disposable logs: ${dataDir}`, { cause: error });
  }
}

import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function journeyFlow(id, name, specialist = false) {
  const node = (type, properties, y) => ({ id: `${id}-${type}`, type, position: { x: 0, y },
    data: { type, label: type === 'finish' ? 'Finish' : name, properties } });
  const edge = (from, to) => ({ id: `${id}-${from}-${to}`, source: `${id}-${from}`, target: `${id}-${to}`,
    sourceHandle: `${from}-bottom`, targetHandle: `${to}-top`, type: 'custom', data: { edgeType: 'standard' } });
  return { id, name, description: specialist ? 'Produces a visible deterministic Behavior receipt.' : 'A model-ready Core for the disposable browser journey.',
    nodes: [node('start', {}, 0), node('process', {
      boundModel: 'journey-model', modelName: 'journey-model', inputMode: 'full-history', defaultAgentVersion: 2,
      ...(!specialist ? { personaTools: ['report_activity_outcome'] } : {}),
      promptTemplate: specialist ? 'JOURNEY_SPECIALIST_ONLY: return the deterministic Behavior receipt and finish.'
        : 'Run the requested deterministic journey task using the available Behavior and receipt App, then finish.',
    }, 160), node('finish', {}, 320)], edges: [edge('start', 'process'), edge('process', 'finish')],
    createdAt: Date.now(), updatedAt: Date.now() };
}

/** Owns only processes and fresh temporary data created by this invocation. */
export async function createJourneyEnvironment({ applicationRoot = process.cwd(), port = 4286 } = {}) {
  applicationRoot = path.resolve(applicationRoot);
  await fs.access(path.join(applicationRoot, '.next', 'BUILD_ID'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid journey port.');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-persona-journey-'));
  const fixtureLog = createWriteStream(path.join(dataDir, 'fixture-events.jsonl'), { flags: 'a' });
  const fixture = await startFixtureServer({ onEvent: event => fixtureLog.write(JSON.stringify(event) + '\n') });
  const baseURL = `http://127.0.0.1:${port}`;
  const epochs = [];
  let child;
  let appLog;
  let stopped = false;

  async function request(route, body, workspace = 'default-workspace') {
    const response = await fetch(`${baseURL}${route}${route.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  async function start() {
    const env = { ...process.env, FLUJO_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: '1',
      FLUJO_BASE_URL: baseURL, FLUJO_TELEMETRY_URL: `${fixture.url}/telemetry`, NODE_ENV: 'production' };
    for (const key of Object.keys(env)) {
      if (['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKSPACE', 'NEXT_MANUAL_SIG_HANDLE'].includes(key.toUpperCase())) delete env[key];
    }
    appLog = createWriteStream(path.join(dataDir, `application-${epochs.length + 1}.log`));
    const epochLog = appLog;
    child = fork(path.join(directory, 'next-process.cjs'), [String(port)], {
      cwd: applicationRoot, env, silent: true, windowsHide: true,
    });
    child.stdout.pipe(appLog, { end: false });
    child.stderr.pipe(appLog, { end: false });
    const epoch = { pid: child.pid, startedAt: new Date().toISOString(), exitedAt: null, exitCode: null };
    epochs.push(epoch);
    child.once('exit', code => { epoch.exitedAt = new Date().toISOString(); epoch.exitCode = code; epochLog.end(); });
    // HTTP readiness alone could accept an unrelated listener before this child
    // reports EADDRINUSE. Never make a fixture request until our child owns the
    // initialized Next server. The message travels over this fork's private IPC.
    const target = child;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        target.off('message', onMessage);
        target.off('exit', onExit);
        target.off('error', onError);
      };
      const onMessage = message => {
        if (message?.type !== 'journey-server-ready' || message.pid !== target.pid) return;
        cleanup();
        resolve();
      };
      const onExit = code => { cleanup(); reject(new Error(`Journey server exited (${code}); inspect ${dataDir}.`)); };
      const onError = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Journey server initialization timed out; inspect ${dataDir}.`)); }, 90_000);
      target.on('message', onMessage);
      target.once('exit', onExit);
      target.once('error', onError);
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Journey server exited (${child.exitCode}); inspect ${dataDir}.`);
      try { await request('/api/workspaces'); return; } catch { await delay(250); }
    }
    throw new Error(`Journey server did not become ready; inspect ${dataDir}.`);
  }

  async function stop() {
    if (!child || child.exitCode !== null) return;
    const target = child;
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // This is our own child only; preserve data/logs on failure.
        target.kill();
        reject(new Error('Graceful journey shutdown exceeded 30 seconds.'));
      }, 30_000);
      target.once('exit', code => {
        clearTimeout(timer);
        // FLUJO's runtime signal handler exits 0 after quiescing active work;
        // otherwise Next's own SIGTERM cleanup exits 143.
        if (code === 0 || code === 143) resolve();
        else reject(new Error(`Unexpected stop exit ${code}.`));
      });
    });
    target.send('stop');
    await exited;
    let reachable = false;
    try { await fetch(baseURL, { signal: AbortSignal.timeout(1_000) }); reachable = true; } catch { /* expected */ }
    if (reachable) throw new Error('Old journey server is still serving after shutdown.');
  }

  async function close() {
    if (stopped) return;
    stopped = true;
    fixture.releaseBusy();
    try { await stop(); } finally {
      await fixture.close();
      await new Promise(resolve => fixtureLog.end(resolve));
      await fs.writeFile(path.join(dataDir, 'process-epochs.json'), JSON.stringify(epochs, null, 2));
    }
  }

  try {
    await start();
    await request('/api/model', { id: 'journey-model', name: 'journey-model', displayName: 'Journey local test model',
      ApiKey: 'disposable-fixture-no-secret', baseUrl: `${fixture.url}/v1`, provider: 'openai', adapter: 'openai', supportsTools: true });
    for (const flow of [journeyFlow('journey-core', 'Journey model-ready Core'),
      journeyFlow('journey-specialist', 'Journey receipt specialist', true)]) await request('/api/flow', flow);
    const serverConfigs = await request('/api/storage?key=mcp_servers');
    const configs = Object.fromEntries(Object.entries(serverConfigs.value ?? {}).map(([name, config]) => [name, { ...config, disabled: true }]));
    for (const name of ['Journey receipt App', 'Journey alternate App', 'Journey replacement App']) {
      configs[name] = { disabled: false, transport: 'stdio', command: process.execPath,
        args: [path.join(directory, 'receipt-app.cjs'), fixture.url], cwd: path.resolve(directory, '../..'), env: {} };
    }
    await request('/api/storage', { key: 'mcp_servers', value: configs });
    await request('/api/workspaces', { name: 'journey-isolation' });
    const manifest = { dataDir, baseURL, applicationRoot, buildId: (await fs.readFile(path.join(applicationRoot, '.next', 'BUILD_ID'), 'utf8')).trim(),
      fixtureMode: 'deterministic-local-model-and-app', epochs };
    await fs.writeFile(path.join(dataDir, 'journey-environment.json'), JSON.stringify(manifest, null, 2));
    return { ...manifest, fixture, request, close,
      async restart() { await stop(); await start(); },
      async inspect() { return { epochs, fixtureEvents: fixture.events, personas: await request('/v1/personas') }; },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

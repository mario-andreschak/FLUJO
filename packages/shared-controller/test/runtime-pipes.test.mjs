import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { RuntimePipes } from '../dist/runtime-pipes.js';
import { proxy } from '../dist/proxy.js';

function fixture() {
  const runtime = { id: 'alice-runtime', actorId: 'alice', origin: 'https://alice.localhost',
    upstream: 'http://127.0.0.1:4200', credential: `flo_v1_${'a'.repeat(43)}`,
    localRuntime: { containerId: 'b'.repeat(64) } };
  const config = { sessionSeconds: 3600, runtimes: [runtime] };
  const intent = { runtimeId: runtime.id, desired: 'running' };
  const state = { available: true, current: true };
  const ledger = { intents: () => [intent], available: () => state.available, intentCurrent: () => state.current };
  return { config, runtime, state, ledger };
}

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

function get(port) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end();
  });
}

function delayedExitEngine() {
  const children = [];
  return { children, spawn() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return false; }, unref() {} });
    child.finish = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0; child.stdin.destroy(); child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    };
    children.push(child); return child;
  } };
}

test('managed proxy uses direct child stdio and drains a buffered response without a host socket', async t => {
  const { config, runtime, ledger } = fixture();
  let networkCalls = 0;
  const unused = await listen(createServer((_request, response) => { networkCalls++; response.end('wrong transport'); }), t);
  runtime.upstream = `http://127.0.0.1:${unused}`;
  const engine = { spawn(policy, args) {
    assert.equal(policy.containerId, runtime.localRuntime.containerId);
    assert.deepEqual(args, ['container', 'exec', '--interactive', '--user', '1000:1000', '--workdir', '/app',
      policy.containerId, '/usr/local/bin/node', '/app/packages/shared-controller/dist/runtime-bridge.js']);
    // Real stdio and real HTTP parser, no Docker or installed isolation claim.
    return spawn(process.execPath, ['-e', `
      let input = '';
      process.stdin.on('data', chunk => {
        input += chunk.toString();
        if (!input.includes('\\r\\n\\r\\n')) return;
        process.stdin.removeAllListeners('data');
        process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Length: 2097152\\r\\nConnection: close\\r\\n\\r\\n');
        process.stdout.end(Buffer.alloc(2097152, 120));
        process.stdin.destroy();
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } };
  const pipes = new RuntimePipes(config, ledger, engine);
  t.after(() => pipes.close());
  let finished = 0;
  const front = await listen(createServer((request, response) => proxy(request, response, {
    runtime, current: () => true, connect: () => pipes.connect(runtime), finished: () => { finished++; },
  })), t);
  const result = await get(front);
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 2 * 1024 * 1024);
  assert.equal(result.body.every(byte => byte === 120), true);
  assert.equal(finished, 1);
  assert.equal(networkCalls, 0);
});

test('missing or failed managed pipes never fall back to the configured TCP address', async t => {
  const { runtime } = fixture();
  let networkCalls = 0;
  const unused = await listen(createServer((_request, response) => { networkCalls++; response.end(); }), t);
  runtime.upstream = `http://127.0.0.1:${unused}`;
  for (const connect of [undefined, () => undefined, () => { throw new Error('secret engine diagnostics'); }]) {
    const front = await listen(createServer((request, response) => proxy(request, response, {
      runtime, connect, current: () => true, finished: () => {},
    })), t);
    const result = await get(front);
    assert.equal(result.status, 503);
    assert.equal(result.body.includes('secret'), false);
  }
  assert.equal(networkCalls, 0);
});

test('asynchronous child spawn failure returns a generic error without a network fallback', async t => {
  const { config, runtime, ledger } = fixture();
  let networkCalls = 0;
  const unused = await listen(createServer((_request, response) => { networkCalls++; response.end(); }), t);
  runtime.upstream = `http://127.0.0.1:${unused}`;
  const pipes = new RuntimePipes(config, ledger, {
    spawn: () => spawn(`${process.execPath}.nonexistent-controller-fixture`, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  });
  t.after(() => pipes.close());
  const front = await listen(createServer((request, response) => proxy(request, response, {
    runtime, connect: () => pipes.connect(runtime), current: () => true, finished: () => {},
  })), t);
  const result = await get(front);
  assert.equal(result.status, 502);
  assert.equal(result.body.includes('nonexistent'), false);
  assert.equal(networkCalls, 0);
});

test('aborting a request cannot free its process quota before owned exit is observed', async t => {
  const { config, runtime, ledger } = fixture();
  const engine = delayedExitEngine();
  const pipes = new RuntimePipes(config, ledger, engine);
  t.after(async () => { engine.children.forEach(child => child.finish()); await pipes.close(); });
  const connections = Array.from({ length: 8 }, () => pipes.connect(runtime));
  connections.forEach(connection => connection.destroy());
  await nextTurn();
  assert.ok(engine.children.every(child => child.kills === 1));
  assert.throws(() => pipes.connect(runtime), /unavailable/);
  engine.children[0].finish();
  assert.doesNotThrow(() => pipes.connect(runtime));
  assert.throws(() => pipes.connect(runtime), /unavailable/);
});

test('sandbox transport permits only its fixed helper flag and shares the owner pipe quota', async t => {
  const { config, runtime, ledger } = fixture();
  const engine = delayedExitEngine();
  const spawnChild = engine.spawn; const commands = [];
  engine.spawn = (policy, args) => { commands.push(args); return spawnChild(policy, args); };
  const pipes = new RuntimePipes(config, ledger, engine);
  t.after(async () => { engine.children.forEach(child => child.finish()); await pipes.close(); });
  assert.throws(() => pipes.connect(runtime, 'http://127.0.0.1:9999'));
  pipes.connect(runtime, 'sandbox');
  assert.deepEqual(commands[0].slice(-2), ['/app/packages/shared-controller/dist/runtime-bridge.js', '--sandbox']);
  for (let i = 0; i < 7; i++) pipes.connect(runtime);
  assert.throws(() => pipes.connect(runtime, 'sandbox'));
});

test('separate owners retain individual quotas within the global process bound', async t => {
  const { config, runtime, ledger } = fixture();
  config.runtimes = Array.from({ length: 9 }, (_, index) => ({ ...runtime, id: `owner-${index}`, actorId: `owner-${index}` }));
  ledger.intents = () => config.runtimes.map(owner => ({ runtimeId: owner.id, desired: 'running' }));
  const engine = delayedExitEngine();
  const pipes = new RuntimePipes(config, ledger, engine);
  t.after(async () => { engine.children.forEach(child => child.finish()); await pipes.close(); });
  for (const owner of config.runtimes.slice(0, 8)) {
    for (let i = 0; i < 8; i++) pipes.connect(owner);
  }
  assert.equal(engine.children.length, 64);
  assert.throws(() => pipes.connect(config.runtimes[8]), /unavailable/);
  engine.children[0].finish();
  assert.doesNotThrow(() => pipes.connect(config.runtimes[8]));
  assert.throws(() => pipes.connect(config.runtimes[8]), /unavailable/);
});

test('revoked or stale authority stops only owned pipes and prevents new transport admission', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { config, runtime, ledger, state } = fixture();
  const engine = delayedExitEngine();
  const pipes = new RuntimePipes(config, ledger, engine);
  t.after(async () => { engine.children.forEach(child => child.finish()); await pipes.close(); });
  const connection = pipes.connect(runtime);
  state.current = false; state.available = false;
  t.mock.timers.tick(1001);
  assert.equal(connection.destroyed, true);
  assert.equal(engine.children[0].kills, 1);
  assert.throws(() => pipes.connect(runtime), /unavailable/);
  engine.children[0].finish();
  await pipes.close();
  state.current = true; state.available = true;
  assert.throws(() => pipes.connect(runtime), /unavailable/);
});

test('shutdown does not report success before child exit even when kill was requested', async () => {
  const { config, runtime, ledger } = fixture();
  const engine = delayedExitEngine();
  const pipes = new RuntimePipes(config, ledger, engine);
  pipes.connect(runtime);
  let complete = false;
  const stopping = pipes.close().then(() => { complete = true; });
  await nextTurn();
  assert.equal(complete, false);
  assert.equal(engine.children[0].kills, 1);
  engine.children[0].finish();
  await stopping;
  assert.equal(complete, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LocalEngine } from '../dist/local-engine.js';
import { localRuntimePolicySchema } from '../dist/local-runtime-policy.js';
import { verifyLocalRuntime, LocalRuntimeDriver } from '../dist/local-runtime.js';
import { provisionRuntime, runtimeCreateArguments } from '../dist/provision-runtime.js';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { digest, Ledger } from '../dist/ledger.js';
import { privateFixture } from './private-fixture.mjs';
import { rotateRuntime } from '../dist/rotate-runtime.js';
import { ownerAuthority, rotatingAuthority } from '../dist/authority-record.js';
import { rotationHelperArguments, verifyRotationHelper } from '../dist/rotation-helper.js';

function fixture() {
  const generation = 'a'.repeat(32);
  const policy = localRuntimePolicySchema.parse({ kind: 'local-docker', executable: '/usr/bin/docker',
    daemon: 'unix:///var/run/docker.sock', containerId: 'b'.repeat(64), imageId: `sha256:${'c'.repeat(64)}`, generation,
    dataVolume: `flujo-owner-${generation}-data`, homeVolume: `flujo-owner-${generation}-home`,
    authorityVolume: `flujo-owner-${generation}-authority`, memoryMiB: 1024, cpus: 1, pidsLimit: 256,
    credentialExpiresAt: Date.now() + 86400_000 });
  const runtime = { id: 'alice-runtime', actorId: 'alice', origin: 'https://alice.localhost',
    upstream: 'http://127.0.0.1:4200', credential: `flo_v1_${'d'.repeat(43)}`,
    isolationId: `local-docker:${policy.containerId}`, localRuntime: policy };
  const intent = { runtimeId: runtime.id, actorId: runtime.actorId, origin: runtime.origin,
    policy, desired: 'running', phase: 'pending', generation: 1, verifiedAt: null, problem: null,
    credentialDigest: digest(runtime.credential) };
  const container = { Id: policy.containerId, Image: policy.imageId,
    Config: { User: '1000:1000', WorkingDir: '/app', Labels: { 'io.flujo.local-owner.protocol': '1',
      'io.flujo.build.worker-mode': '', 'io.flujo.build.execution-adapter': '',
      'io.flujo.local-owner.runtime': runtime.id, 'io.flujo.local-owner.actor': runtime.actorId,
      'io.flujo.local-owner.generation': generation },
      Env: ['FLUJO_EXPOSURE_MODE=public', 'FLUJO_DATA_DIR=/app/data', 'HOME=/owner-home',
        'FLUJO_OWNER_AUTH_FILE=/run/flujo-owner/owner.json', `FLUJO_OWNER_BROWSER_ORIGIN=${runtime.origin}`,
        'FLUJO_CONTAINER=1', 'NODE_ENV=production'], Entrypoint: ['/usr/bin/tini', '-s', '--'],
      Cmd: ['node', 'scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '127.0.0.1'], Healthcheck: { Test: ['NONE'] } },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', PidMode: '', UTSMode: '', UsernsMode: '',
      IpcMode: 'private', CgroupnsMode: 'private', PublishAllPorts: false, AutoRemove: false,
      Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1e9, PidsLimit: 256,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=256m,mode=1777' },
      ReadonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
      MaskedPaths: ['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/scsi', '/sys/firmware'] },
    Mounts: [{ Type: 'volume', Name: policy.dataVolume, Destination: '/app/data', RW: true },
      { Type: 'volume', Name: policy.homeVolume, Destination: '/owner-home', RW: true },
      { Type: 'volume', Name: policy.authorityVolume, Destination: '/run/flujo-owner', RW: false }],
    NetworkSettings: { Networks: { none: {} } },
    State: { Running: false, Paused: false, Restarting: false, Dead: false, Status: 'created' } };
  return { policy, runtime, intent, container };
}

function engineFixture(container, intent, { acknowledgeOnly = false, afterInfo = () => {} } = {}) {
  const calls = [];
  return { calls,
    async run(_policy, args) {
      calls.push(args);
      if (args[1] === 'ls') return container.Id;
      if (args[1] === 'start' && !acknowledgeOnly) container.State = { ...container.State, Running: true, Status: 'running' };
      if (args[1] === 'stop' && !acknowledgeOnly) container.State = { ...container.State, Running: false, Status: 'exited' };
      return container.Id;
    },
    async json(_policy, args) {
      calls.push(args);
      if (args[0] === 'info') { afterInfo(); return { OSType: 'linux', MemoryLimit: true, SwapLimit: true,
        PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'] }; }
      if (args[0] === 'volume') return args.slice(2).map(Name => ({ Name, Driver: 'local', Scope: 'local', Options: null,
        Labels: { 'io.flujo.local-owner.generation': intent.policy.generation, 'io.flujo.local-owner.actor': intent.actorId } }));
      if (args[1] === 'exec') return { actorId: intent.actorId, digest: intent.credentialDigest,
        issuedAt: Date.now() - 1000, expiresAt: intent.policy.credentialExpiresAt };
      return [structuredClone(container)];
    } };
}

test('managed runtime policy rejects remote engines and shared or mutable identities', () => {
  const { policy } = fixture();
  for (const daemon of ['tcp://127.0.0.1:2375', 'ssh://host', 'tcp://remote.example:2376']) {
    assert.equal(localRuntimePolicySchema.safeParse({ ...policy, daemon }).success, false);
  }
  assert.equal(localRuntimePolicySchema.safeParse({ ...policy, dataVolume: `flujo-owner-${'f'.repeat(32)}-data` }).success, false);
});

test('isolation inspection refuses network, host namespaces, writable authority and resource bypasses', () => {
  const { container, intent } = fixture();
  assert.equal(verifyLocalRuntime(container, intent), 'stopped');
  const attacks = [c => { c.HostConfig.NetworkMode = 'host'; }, c => { c.HostConfig.Privileged = true; },
    c => { c.HostConfig.PidMode = 'host'; }, c => { c.HostConfig.UsernsMode = 'host'; },
    c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; }, c => { c.HostConfig.Memory = 0; },
    c => { c.HostConfig.MemorySwap = -1; }, c => { c.HostConfig.RestartPolicy.Name = 'always'; },
    c => { c.HostConfig.SecurityOpt = ['seccomp=unconfined']; }, c => { c.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    c => { c.Mounts[2].RW = true; }, c => { c.Mounts.push({ Type: 'bind', Destination: '/host', RW: true }); },
    c => { c.Config.Env.push('FLUJO_WORKER_MODE=1'); }, c => { c.Config.Env.push('NODE_OPTIONS=--require=/owner-home/x.js'); },
    c => { c.Config.Labels['io.flujo.local-owner.actor'] = 'bob'; }, c => { c.Image = `sha256:${'e'.repeat(64)}`; }];
  for (const attack of attacks) { const changed = structuredClone(container); attack(changed); assert.throws(() => verifyLocalRuntime(changed, intent)); }
  const args = runtimeCreateArguments(fixture().runtime, intent.policy);
  assert.ok(args.includes('--pull=never')); assert.ok(args.includes('--network=none'));
  assert.equal(args.some(value => value.startsWith('--publish')), false);
  assert.equal(args.some(value => value.includes('flo_v1_')), false);
});

test('start/stop needs observed state, and superseded start cannot execute', async () => {
  const { container, intent } = fixture();
  const engine = engineFixture(container, intent);
  assert.equal(await new LocalRuntimeDriver(engine).converge(intent, () => true), 'running');
  // A changed isolation flag does not prevent stopping this exact owned runtime.
  container.HostConfig.NetworkMode = 'host';
  assert.equal(await new LocalRuntimeDriver(engine).converge({ ...intent, desired: 'stopped' }, () => true), 'stopped');
  assert.ok(engine.calls.some(args => args[1] === 'stop' && args.includes('SIGKILL')));
  const second = fixture();
  const ack = engineFixture(second.container, second.intent, { acknowledgeOnly: true });
  await assert.rejects(new LocalRuntimeDriver(ack).converge(second.intent, () => true), { problem: 'state-unconfirmed' });
  let current = true;
  const superseded = engineFixture(second.container, second.intent, { afterInfo: () => { current = false; } });
  await assert.rejects(new LocalRuntimeDriver(superseded).converge(second.intent, () => current), { problem: 'superseded' });
  assert.equal(superseded.calls.some(args => args[1] === 'start'), false);
});

test('an identity mismatch is never a license to stop another runtime', async () => {
  const { container, intent } = fixture(); container.Config.Labels['io.flujo.local-owner.actor'] = 'bob';
  const engine = engineFixture(container, intent);
  await assert.rejects(new LocalRuntimeDriver(engine).converge({ ...intent, desired: 'stopped' }, () => true), { problem: 'identity-mismatch' });
  assert.equal(engine.calls.some(args => args[1] === 'stop'), false);
});

test('failed engine, volume and authority checks revoke an already running owned runtime', async () => {
  for (const failure of ['capabilities', 'volume', 'authority', 'authority-unreadable']) {
    const { container, intent } = fixture();
    container.State = { ...container.State, Running: true, Status: 'running' };
    const engine = engineFixture(container, intent);
    const json = engine.json;
    engine.json = async (policy, args) => {
      const value = await json(policy, args);
      if (failure === 'capabilities' && args[0] === 'info') value.MemoryLimit = false;
      if (failure === 'volume' && args[0] === 'volume') value[0].Labels['io.flujo.local-owner.actor'] = 'bob';
      if (failure === 'authority' && args[1] === 'exec') value.digest = '0'.repeat(64);
      if (failure === 'authority-unreadable' && args[1] === 'exec') throw new Error('Authority cannot be verified');
      return value;
    };
    await assert.rejects(new LocalRuntimeDriver(engine).converge(intent, () => true));
    assert.equal(container.State.Running, false, failure);
    assert.ok(engine.calls.some(args => args[1] === 'stop'), failure);
  }
  const { container, intent } = fixture();
  container.State = { ...container.State, Running: true, Status: 'running' };
  container.HostConfig.ReadonlyRootfs = false;
  const engine = engineFixture(container, intent, { acknowledgeOnly: true });
  await assert.rejects(new LocalRuntimeDriver(engine).converge(intent, () => true), { problem: 'state-unconfirmed' });
  assert.equal(container.State.Running, true, 'Stop ACK must not be reported as exit');
});

test('unprovisioned owners can share a placeholder loopback endpoint but not browser identity', () => {
  const { runtime } = fixture();
  const owner = { ...runtime }; delete owner.localRuntime;
  const runtimes = [owner, { ...owner, id: 'bob-runtime', actorId: 'bob', origin: 'https://bob.localhost',
    credential: `flo_v1_${'e'.repeat(43)}` }].map(item => ({ ...item, isolationId: `unprovisioned:${item.id}` }));
  // Use a native absolute path because this schema check also runs on Windows.
  const config = { schemaVersion: 2, stateDirectory: homedir(), runtimes };
  assert.equal(configSchema.safeParse(config).success, true);
  runtimes[1].origin = 'https://alice.localhost:4443';
  assert.equal(configSchema.safeParse(config).success, false);
});

test('durable runtime admission expires and stale observations cannot undo revocation', t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { directory, close } = privateFixture(t);
  let ledger = new Ledger(directory);
  close.push(() => ledger.close());
  const { runtime } = fixture();
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory, runtimes: [runtime] });
  ledger.reconcile(config);
  const revision = runtimeRevision(config, runtime);
  assert.equal(ledger.available(runtime, revision), false);
  const first = ledger.intents()[0]; ledger.observeRuntime(first);
  assert.equal(ledger.available(runtime, revision), true);
  now += 30_001; assert.equal(ledger.available(runtime, revision), false);
  ledger.observeRuntime(first); ledger.setActorEnabled('alice', false);
  assert.equal(ledger.observeRuntime(first), false);
  assert.equal(ledger.available(runtime, revision), false);
  const stop = ledger.intents()[0]; assert.equal(stop.desired, 'stopped');
  ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config);
  assert.equal(ledger.intents()[0].desired, 'stopped');
  assert.equal(ledger.observeRuntime(stop), false);
  ledger.observeRuntime(ledger.intents()[0]);
  ledger.setActorEnabled('alice', true);
  assert.equal(ledger.available(runtime, revision), false);
  const changed = structuredClone(config); delete changed.runtimes[0].localRuntime;
  assert.throws(() => ledger.reconcile(changed), /cannot change its local execution boundary/);
});

test('a lost create response resumes the same journaled container without creating another owner', async t => {
  const { directory, close } = privateFixture(t);
  const ledger = new Ledger(directory);
  close.push(() => ledger.close());
  const source = fixture();
  const { localRuntime: policy, ...owner } = source.runtime;
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    localEngine: { executable: policy.executable, daemon: policy.daemon, imageId: policy.imageId,
      cpus: policy.cpus, memoryMiB: policy.memoryMiB, pidsLimit: policy.pidsLimit },
    runtimes: [{ ...owner, isolationId: `unprovisioned:${owner.id}` }] });
  assert.throws(() => ledger.reconcile(config), /Provision every new local runtime/);
  const filename = join(directory, 'config.json'); writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const plan = () => JSON.parse(ledger.db.prepare('SELECT plan FROM runtime_provisioning WHERE runtime_id=?').get(owner.id).plan);
  let created = false; let creates = 0; let initializes = 0;
  const volumes = new Set();
  const engine = {
    async run(_policy, args, input) {
      if (args[0] === 'volume') { volumes.add(args.at(-1)); return args.at(-1); }
      if (args[1] === 'run') { initializes++; assert.equal(input.includes(owner.credential), false); return 'initialized'; }
      if (args[1] === 'ls') return created ? policy.containerId : '';
      if (args[1] === 'create') { creates++; created = true; throw new Error('Response lost after creation'); }
      throw new Error('Unexpected engine mutation');
    },
    async json(_policy, args) {
      const selected = plan().policy;
      if (args[0] === 'image') return [{ Id: policy.imageId, Os: 'linux', Config: {
        Labels: { 'io.flujo.local-owner.protocol': '1', 'io.flujo.build.worker-mode': '', 'io.flujo.build.execution-adapter': '' },
        Entrypoint: ['/usr/bin/tini', '-s', '--'], Volumes: null } }];
      if (args[0] === 'volume') return [{ Name: args[2], Driver: 'local', Scope: 'local', Options: null,
        Labels: { 'io.flujo.local-owner.actor': owner.actorId, 'io.flujo.local-owner.generation': selected.generation } }];
      const container = structuredClone(source.container);
      container.Config.Labels['io.flujo.local-owner.generation'] = selected.generation;
      container.Mounts[0].Name = selected.dataVolume; container.Mounts[1].Name = selected.homeVolume;
      container.Mounts[2].Name = selected.authorityVolume;
      return [container];
    },
  };
  await assert.rejects(provisionRuntime(filename, config, ledger, owner.actorId, engine), /Response lost/);
  const generation = plan().policy.generation;
  assert.equal(configSchema.parse(JSON.parse(readFileSync(filename, 'utf8'))).runtimes[0].localRuntime, undefined);
  const result = await provisionRuntime(filename, config, ledger, owner.actorId, engine);
  assert.equal(creates, 1); assert.equal(initializes, 1); assert.equal(volumes.size, 3);
  assert.equal(result.localRuntime.generation, generation);
  const published = configSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
  assert.equal(published.runtimes[0].localRuntime.containerId, policy.containerId);
  assert.equal(ledger.db.prepare('SELECT phase FROM runtime_provisioning WHERE runtime_id=?').get(owner.id).phase, 'published');
  ledger.reconcile(published);
  assert.equal(ledger.available(published.runtimes[0], runtimeRevision(published, published.runtimes[0])), false);
});

function rotationFixture(t) {
  const { directory, close } = privateFixture(t);
  const ledger = new Ledger(directory); close.push(() => ledger.close());
  const source = fixture(); const p = source.policy;
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory, runtimes: [source.runtime],
    localEngine: { executable: p.executable, daemon: p.daemon, imageId: p.imageId, memoryMiB: p.memoryMiB,
      cpus: p.cpus, pidsLimit: p.pidsLimit, credentialSeconds: 3600 } });
  const filename = join(directory, 'config.json'); writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  ledger.reconcile(config); ledger.observeRuntime(ledger.intents()[0]);
  ledger.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('session', source.runtime.actorId,
    source.runtime.id, runtimeRevision(config, source.runtime), Date.now() + 60_000, Date.now());
  source.container.State = { ...source.container.State, Running: true, Status: 'running' };
  let authority = ownerAuthority(source.runtime.actorId, digest(source.runtime.credential), Date.now() - 1000, p.credentialExpiresAt);
  let activeHelper = null;
  const engine = engineFixture(source.container, source.intent); const originalRun = engine.run; const originalJson = engine.json;
  const hooks = { afterAuthority: () => {}, beforeHelper: () => {}, beforeStop: () => {} };
  let rotations = 0; let waits = 0;
  engine.run = async (policy, args, input) => {
    if (args[1] === 'ls' && args.some(arg => arg.includes('flujo-owner-rotate-'))) return activeHelper?.Id ?? '';
    if (args[1] === 'wait') { waits++; activeHelper = null; return '0'; }
    if (args[1] === 'stop') hooks.beforeStop();
    if (args[1] !== 'run') return originalRun(policy, args, input);
    hooks.beforeHelper(); rotations++;
    assert.equal(source.container.State.Running, false, 'Authority may only change after observed exit');
    assert.equal(input.includes(source.runtime.credential), false);
    const request = JSON.parse(input);
    if (rotatingAuthority(authority, request) === 'replace') authority = request.next;
    hooks.afterAuthority();
    return JSON.stringify({ actorId: authority.ownerId, ...authority.credentials[0] });
  };
  engine.json = async (policy, args) => {
    if (args[1] === 'inspect' && args[2] === activeHelper?.Id) return [structuredClone(activeHelper)];
    if (args[1] === 'exec') return { actorId: authority.ownerId, ...authority.credentials[0] };
    return originalJson(policy, args);
  };
  return { ...source, config, ledger, filename, engine, hooks,
    read: () => configSchema.parse(JSON.parse(readFileSync(filename, 'utf8'))),
    rotate: (resume = false) => rotateRuntime(filename, configSchema.parse(JSON.parse(readFileSync(filename, 'utf8'))), ledger, 'alice', resume, engine),
    plan: () => JSON.parse(ledger.db.prepare('SELECT plan FROM runtime_rotations ORDER BY rowid DESC LIMIT 1').get().plan),
    authority: () => authority, rotations: () => rotations, waits: () => waits,
    setHelper: helper => { activeHelper = helper; } };
}

function helperFixture(container, intent, operationId) {
  const value = structuredClone(container); value.Id = 'e'.repeat(64); value.Name = `/flujo-owner-rotate-${operationId}`;
  value.Config.Labels['io.flujo.local-owner.rotation'] = operationId;
  value.Config.Entrypoint = ['/usr/local/bin/node'];
  value.Config.Cmd = ['/app/packages/shared-controller/dist/runtime-authority.js', 'rotate'];
  value.HostConfig = { ...value.HostConfig, AutoRemove: true, Memory: 268435456, MemorySwap: 268435456, PidsLimit: 64 };
  delete value.HostConfig.Tmpfs;
  value.Mounts = [{ Type: 'volume', Name: intent.policy.authorityVolume, Destination: '/run/flujo-owner', RW: true }];
  return value;
}

test('rotation preserves identities and data, revokes sessions, and completed resume does not rotate again', async t => {
  const f = rotationFixture(t); const result = await f.rotate(); const config = f.read(); const runtime = config.runtimes[0];
  assert.equal(result.verified, true); assert.equal(result.desired, 'running'); assert.equal(f.rotations(), 1);
  assert.notEqual(runtime.credential, f.runtime.credential);
  assert.deepEqual({ ...runtime, credential: f.runtime.credential, localRuntime: f.policy }, f.runtime);
  assert.equal(f.ledger.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  assert.equal(f.ledger.available(runtime, runtimeRevision(config, runtime)), true);
  const journal = f.ledger.db.prepare('SELECT plan,phase FROM runtime_rotations').get();
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.plan.includes(runtime.credential), false); assert.equal(journal.plan.includes(f.runtime.credential), false);
  assert.equal(JSON.stringify(result).includes(runtime.credential), false);
  const resumed = await f.rotate(true);
  assert.equal(resumed.operationId, result.operationId); assert.equal(f.rotations(), 1);
  // A power loss can preserve the SQLite commit but lose a directory rename.
  writeFileSync(f.filename, JSON.stringify(f.config));
  assert.equal((await f.rotate(true)).operationId, result.operationId);
  assert.equal(f.read().runtimes[0].credential, runtime.credential); assert.equal(f.rotations(), 1);
  const drift = structuredClone(config); drift.runtimes[0].localRuntime.memoryMiB *= 2;
  assert.throws(() => f.ledger.reconcile(drift), /cannot change its local execution boundary/);
});

test('lost helper reply freezes admission and recovers the same credential and owned helper', async t => {
  const f = rotationFixture(t);
  f.hooks.afterAuthority = () => { f.hooks.afterAuthority = () => {}; throw new Error('Lost helper reply'); };
  await assert.rejects(f.rotate(), /Lost helper reply/);
  const first = f.plan(); const next = f.authority();
  assert.equal(f.ledger.available(f.runtime, runtimeRevision(f.config, f.runtime)), false);
  assert.throws(() => f.ledger.reconcile(f.config), /Resume pending/);
  assert.throws(() => f.ledger.setActorEnabled('alice', true), /Finish pending/);
  const helper = helperFixture(f.container, f.intent, first.operationId); f.setHelper(helper);
  const resumed = await f.rotate(true);
  assert.equal(resumed.operationId, first.operationId); assert.deepEqual(f.authority(), next); assert.equal(f.waits(), 1);
  assert.equal(digest(f.read().runtimes[0].credential), first.nextDigest);
});

test('config publication followed by a ledger interruption resumes without another credential', async t => {
  const f = rotationFixture(t); const transaction = f.ledger.transaction.bind(f.ledger); let interrupted = false;
  t.mock.method(f.ledger, 'transaction', callback => {
    if (!interrupted && f.read().runtimes[0].credential !== f.runtime.credential) {
      interrupted = true; throw new Error('Ledger unavailable after publication');
    }
    return transaction(callback);
  });
  await assert.rejects(f.rotate(), /Ledger unavailable/);
  assert.equal(f.ledger.db.prepare('SELECT phase FROM runtime_rotations').get().phase, 'config-published');
  const credential = f.read().runtimes[0].credential;
  assert.equal((await f.rotate(true)).verified, true);
  assert.equal(f.read().runtimes[0].credential, credential);
});

test('disable before or during rotation survives recovery and never starts the owner', async t => {
  for (const when of ['before', 'during']) {
    const f = rotationFixture(t);
    if (when === 'before') f.ledger.setActorEnabled('alice', false);
    else {
      f.hooks.afterAuthority = () => { f.hooks.afterAuthority = () => {}; f.ledger.setActorEnabled('alice', false); };
      await assert.rejects(f.rotate());
    }
    const result = await f.rotate(when === 'during');
    assert.equal(result.verified, true); assert.equal(result.desired, 'stopped');
    assert.equal(f.ledger.db.prepare('SELECT enabled FROM actors WHERE id=?').get('alice').enabled, 0);
    assert.equal(f.engine.calls.some(args => args[1] === 'start'), false);
    assert.equal(f.container.State.Running, false);
  }
});

test('an expired interrupted candidate completes stopped before fresh offline rotation', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = rotationFixture(t);
  f.hooks.afterAuthority = () => { f.hooks.afterAuthority = () => {}; now += 3_600_001; throw new Error('Interrupted until expiry'); };
  await assert.rejects(f.rotate(), /Interrupted until expiry/);
  const expired = f.plan(); const result = await f.rotate(true);
  assert.notEqual(result.operationId, expired.operationId);
  assert.ok(result.expiresAt > now); assert.equal(result.verified, true);
  const journals = f.ledger.db.prepare('SELECT phase FROM runtime_rotations').all();
  assert.deepEqual(journals.map(row => row.phase), ['complete', 'complete']);
  assert.equal(f.engine.calls.filter(args => args[1] === 'start').length, 1);
});

test('local clock correction cannot select an older completed rotation for recovery', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = rotationFixture(t); const first = await f.rotate();
  now -= 60_000;
  const second = await f.rotate(); assert.notEqual(first.operationId, second.operationId);
  const resumed = await f.rotate(true);
  assert.equal(resumed.operationId, second.operationId); assert.equal(resumed.verified, true);
  assert.equal(f.rotations(), 2);
});

test('rotation refuses a missing container, unconfirmed exit or another owner before authority writes', async t => {
  for (const failure of ['missing', 'running', 'owner']) {
    const f = rotationFixture(t); const run = f.engine.run; const json = f.engine.json;
    if (failure === 'owner') f.container.Config.Labels['io.flujo.local-owner.actor'] = 'bob';
    f.engine.run = async (policy, args, input) => {
      if (failure === 'missing' && args[1] === 'ls') return '';
      if (failure === 'running' && args[1] === 'stop') return f.policy.containerId;
      return run(policy, args, input);
    };
    f.engine.json = async (policy, args) => failure === 'missing' && args[1] === 'inspect' ? [] : json(policy, args);
    await assert.rejects(f.rotate()); assert.equal(f.rotations(), 0);
    assert.equal(f.read().runtimes[0].credential, f.runtime.credential);
    assert.equal(f.ledger.available(f.runtime, runtimeRevision(f.config, f.runtime)), false);
  }
});

test('an unknown helper and conflicting operator configuration remain pending without overwrites', async t => {
  const f = rotationFixture(t);
  f.hooks.afterAuthority = () => { f.hooks.afterAuthority = () => {}; throw new Error('Lost reply'); };
  await assert.rejects(f.rotate());
  const helper = helperFixture(f.container, f.intent, f.plan().operationId);
  helper.Config.Labels['io.flujo.local-owner.actor'] = 'bob'; f.setHelper(helper);
  await assert.rejects(f.rotate(true), { problem: 'identity-mismatch' });
  assert.equal(f.waits(), 0); assert.equal(f.rotations(), 1);
  const changed = f.read(); changed.sessionSeconds = 3600;
  writeFileSync(f.filename, JSON.stringify(changed));
  await assert.rejects(f.rotate(true), /Restore the source or target configuration/);
  assert.equal(f.read().sessionSeconds, 3600); assert.equal(f.rotations(), 1);
});

test('rotation helper has only owner authority, and retries cannot change owner or generation', () => {
  const { container, intent } = fixture(); const operationId = 'f'.repeat(32);
  const helper = helperFixture(container, intent, operationId);
  verifyRotationHelper(helper, helper.Id, intent, operationId);
  for (const mutate of [c => { c.Mounts[0].Name = intent.policy.dataVolume; }, c => { c.HostConfig.NetworkMode = 'host'; },
    c => { c.Config.Env.push('NODE_OPTIONS=--require=/run/flujo-owner/injected.js'); }, c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; },
    c => { c.Config.Labels['io.flujo.local-owner.rotation'] = '0'.repeat(32); }, c => { c.Config.User = '0:0'; }]) {
    const changed = structuredClone(helper); mutate(changed);
    assert.throws(() => verifyRotationHelper(changed, helper.Id, intent, operationId));
  }
  const args = rotationHelperArguments(intent, operationId);
  assert.equal(args.filter(arg => arg === '--mount').length, 1);
  assert.ok(args.includes('--network=none')); assert.ok(args.includes('--pull=never'));
  const current = ownerAuthority('alice', 'a'.repeat(64), 1, 10);
  const next = ownerAuthority('alice', 'b'.repeat(64), 11, 20);
  const request = { operationId, previousDigest: current.credentials[0].digest, previousExpiresAt: 10, next };
  assert.equal(rotatingAuthority(current, request), 'replace'); assert.equal(rotatingAuthority(next, request), 'current');
  assert.throws(() => rotatingAuthority(ownerAuthority('bob', 'a'.repeat(64), 1, 10), request));
  assert.throws(() => rotatingAuthority(ownerAuthority('alice', 'c'.repeat(64), 1, 10), request));
});

test('a Docker CLI that never reports exit has a bounded failure, not invented daemon completion', async t => {
  const { directory } = privateFixture(t); const { policy } = fixture();
  let kills = 0; let unrefs = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills++; return false; }, unref: () => { unrefs++; } });
  const engine = new LocalEngine(directory); t.mock.method(engine, 'spawn', () => child);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = engine.run(policy, ['container', 'wait', policy.containerId]);
  const rejected = assert.rejects(result, { problem: 'local-engine-unavailable' });
  t.mock.timers.tick(15_000); assert.equal(kills, 1); assert.equal(unrefs, 0);
  t.mock.timers.tick(5000); await rejected;
  assert.equal(unrefs, 1); assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
  child.emit('close', 0); // A late CLI reply cannot turn the rejection into success.
});

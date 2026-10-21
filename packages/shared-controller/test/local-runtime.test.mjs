import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localRuntimePolicySchema } from '../dist/local-runtime-policy.js';
import { verifyLocalRuntime, LocalRuntimeDriver } from '../dist/local-runtime.js';
import { provisionRuntime, runtimeCreateArguments } from '../dist/provision-runtime.js';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { digest, Ledger } from '../dist/ledger.js';

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

test('durable runtime admission expires and stale observations cannot undo revocation', { skip: process.platform === 'win32' }, t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const directory = mkdtempSync(join(homedir(), '.flujo-local-runtime-')); chmodSync(directory, 0o700);
  const mask = process.umask(0o077);
  let ledger = new Ledger(directory);
  t.after(() => { ledger.close(); process.umask(mask); rmSync(directory, { recursive: true, force: true }); });
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

test('a lost create response resumes the same journaled container without creating another owner', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(homedir(), '.flujo-provision-')); chmodSync(directory, 0o700);
  const mask = process.umask(0o077);
  const ledger = new Ledger(directory);
  t.after(() => { ledger.close(); process.umask(mask); rmSync(directory, { recursive: true, force: true }); });
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

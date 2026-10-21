import { z } from 'zod';
import { LocalEngine } from './local-engine.js';
import { RuntimeControlError, type RuntimeIntent, type RuntimeState } from './local-runtime-policy.js';

const object = z.record(z.string(), z.unknown());
const inspection = z.object({
  Id: z.string(), Image: z.string(),
  Config: z.object({ User: z.string(), Labels: z.record(z.string(), z.string()).nullable(),
    Env: z.array(z.string()), Entrypoint: z.array(z.string()).nullable(), Cmd: z.array(z.string()).nullable(),
    WorkingDir: z.string(), Healthcheck: z.object({ Test: z.array(z.string()) }).optional() }).passthrough(),
  HostConfig: object,
  State: z.object({ Running: z.boolean(), Paused: z.boolean(), Restarting: z.boolean(), Dead: z.boolean(), Status: z.string() }).passthrough(),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string(), RW: z.boolean() }).passthrough()),
  NetworkSettings: z.object({ Networks: object }).passthrough(),
}).passthrough();

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const empty = (value: unknown): boolean => value == null || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && Object.keys(value).length === 0);

/** Verify the real container before every lifecycle operation. Names, labels or
 * a successful start/stop command alone are not isolation/exit evidence. */
function ownedContainer(value: unknown, intent: RuntimeIntent): z.infer<typeof inspection> {
  const parsed = inspection.safeParse(value);
  if (!parsed.success) throw new RuntimeControlError('isolation-mismatch');
  const container = parsed.data;
  const policy = intent.policy;
  const labels = container.Config.Labels ?? {};
  if (container.Id !== policy.containerId || container.Image !== policy.imageId
      || labels['io.flujo.local-owner.protocol'] !== '1'
      || labels['io.flujo.build.worker-mode'] !== '' || labels['io.flujo.build.execution-adapter'] !== ''
      || labels['io.flujo.local-owner.runtime'] !== intent.runtimeId
      || labels['io.flujo.local-owner.actor'] !== intent.actorId
      || labels['io.flujo.local-owner.generation'] !== policy.generation) {
    throw new RuntimeControlError('identity-mismatch');
  }
  return container;
}

export function verifyLocalRuntime(value: unknown, intent: RuntimeIntent): RuntimeState {
  const container = ownedContainer(value, intent);
  const policy = intent.policy;
  const host = container.HostConfig;
  const env = new Map(container.Config.Env.map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
  const requiredEnv = { FLUJO_EXPOSURE_MODE: 'public', FLUJO_DATA_DIR: '/app/data', HOME: '/owner-home',
    FLUJO_OWNER_AUTH_FILE: '/run/flujo-owner/owner.json', FLUJO_OWNER_BROWSER_ORIGIN: intent.origin,
    FLUJO_CONTAINER: '1', NODE_ENV: 'production' };
  if (Object.entries(requiredEnv).some(([key, expected]) => env.get(key) !== expected)
      || [...env.keys()].some(key => ['FLUJO_WORKER_MODE', 'FLUJO_EXECUTION_ADAPTER_MODULE', 'FLUJO_OWNER_BOOTSTRAP_FILE',
        'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key))
      || container.Config.User !== '1000:1000' || container.Config.WorkingDir !== '/app'
      || !equal(container.Config.Entrypoint, ['/usr/bin/tini', '-s', '--'])
      || !equal(container.Config.Cmd, ['node', 'scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '127.0.0.1'])
      || !equal(container.Config.Healthcheck?.Test, ['NONE'])
      || host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode !== 'none'
      || host.PidMode !== '' || host.UTSMode !== '' || host.UsernsMode !== '' || host.IpcMode !== 'private'
      || host.CgroupnsMode !== 'private' || host.PublishAllPorts !== false || host.AutoRemove !== false
      || host.Memory !== policy.memoryMiB * 1024 * 1024 || host.MemorySwap !== host.Memory
      || host.NanoCpus !== Math.round(policy.cpus * 1_000_000_000) || host.PidsLimit !== policy.pidsLimit
      || host.OomKillDisable === true || !empty(host.CapAdd) || !equal(host.CapDrop, ['ALL'])
      || !Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1
      || !['no-new-privileges', 'no-new-privileges:true'].includes(String(host.SecurityOpt[0]))
      || !equal(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 })
      || ['Binds', 'VolumesFrom', 'PortBindings', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'GroupAdd', 'ExtraHosts'].some(key => !empty(host[key]))
      || !equal(Object.keys(container.NetworkSettings.Networks), ['none'])) {
    throw new RuntimeControlError('isolation-mismatch');
  }
  const expectedMounts = [
    { Type: 'volume', Name: policy.dataVolume, Destination: '/app/data', RW: true },
    { Type: 'volume', Name: policy.homeVolume, Destination: '/owner-home', RW: true },
    { Type: 'volume', Name: policy.authorityVolume, Destination: '/run/flujo-owner', RW: false },
  ];
  if (container.Mounts.length !== expectedMounts.length || expectedMounts.some(expected => !container.Mounts.some(actual =>
    Object.entries(expected).every(([key, wanted]) => actual[key] === wanted)))) {
    throw new RuntimeControlError('isolation-mismatch');
  }
  const tmpfs = host.Tmpfs as Record<string, unknown> | undefined;
  const readonlyPaths = host.ReadonlyPaths;
  const maskedPaths = host.MaskedPaths;
  if (!tmpfs || Object.keys(tmpfs).length !== 1 || tmpfs['/tmp'] !== 'rw,noexec,nosuid,nodev,size=256m,mode=1777'
      || !Array.isArray(readonlyPaths) || !['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'].every(path => readonlyPaths.includes(path))
      || !Array.isArray(maskedPaths) || !['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/scsi', '/sys/firmware'].every(path => maskedPaths.includes(path))) {
    throw new RuntimeControlError('isolation-mismatch');
  }
  if (container.State.Paused || container.State.Restarting || container.State.Dead) throw new RuntimeControlError('state-unconfirmed');
  if (container.State.Running && container.State.Status === 'running') return 'running';
  if (!container.State.Running && ['created', 'exited'].includes(container.State.Status)) return 'stopped';
  throw new RuntimeControlError('state-unconfirmed');
}

export function verifyLocalVolumes(volumes: unknown, intent: RuntimeIntent): void {
  const names = new Set([intent.policy.dataVolume, intent.policy.homeVolume, intent.policy.authorityVolume]);
  if (!Array.isArray(volumes) || volumes.length !== 3 || volumes.some(volume => !volume || typeof volume !== 'object'
      || !names.delete(volume.Name) || volume.Driver !== 'local' || !empty(volume.Options) || volume.Scope !== 'local'
      || volume.Labels?.['io.flujo.local-owner.generation'] !== intent.policy.generation
      || volume.Labels?.['io.flujo.local-owner.actor'] !== intent.actorId)) {
    throw new RuntimeControlError('isolation-mismatch');
  }
}

export class LocalRuntimeDriver {
  constructor(readonly engine: Pick<LocalEngine, 'run' | 'json'>) {}

  private async container(intent: RuntimeIntent): Promise<unknown> {
    const value = await this.engine.json(intent.policy, ['container', 'inspect', intent.policy.containerId]);
    if (!Array.isArray(value) || value.length !== 1) throw new RuntimeControlError('identity-mismatch');
    return value[0];
  }

  async inspect(intent: RuntimeIntent): Promise<RuntimeState> {
    return verifyLocalRuntime(await this.container(intent), intent);
  }

  /** Stopping an owned container must remain possible when its isolation policy
   * has drifted. Only immutable identity is required; never stop a lookalike. */
  private async stopOwned(intent: RuntimeIntent, current: () => boolean): Promise<'stopped'> {
    if (!current()) throw new RuntimeControlError('superseded');
    const ids = await this.engine.run(intent.policy, ['container', 'ls', '--all', '--no-trunc',
      '--filter', `id=${intent.policy.containerId}`, '--format', '{{.ID}}']);
    if (!current()) throw new RuntimeControlError('superseded');
    if (ids === '') return 'stopped';
    if (ids !== intent.policy.containerId) throw new RuntimeControlError('identity-mismatch');
    const before = ownedContainer(await this.container(intent), intent);
    if (!current()) throw new RuntimeControlError('superseded');
    if (before.State.Running || before.State.Paused || before.State.Restarting) {
      await this.engine.run(intent.policy, ['container', 'stop', '--signal', 'SIGKILL', '--timeout', '0', intent.policy.containerId]);
    }
    const after = ownedContainer(await this.container(intent), intent);
    if (!current()) throw new RuntimeControlError('superseded');
    if (after.State.Running || after.State.Paused || after.State.Restarting || after.State.Dead
        || !['created', 'exited'].includes(after.State.Status)) throw new RuntimeControlError('state-unconfirmed');
    return 'stopped';
  }

  async converge(intent: RuntimeIntent, current: () => boolean): Promise<RuntimeState> {
    if (!current()) throw new RuntimeControlError('superseded');
    if (intent.desired === 'stopped') return this.stopOwned(intent, current);
    try { return await this.startOwned(intent, current); }
    catch (error) {
      // Admission denial alone does not revoke already running tools. Recheck
      // immutable ownership and observe exit on every failed running check,
      // including engine capabilities, volume policy and unreadable authority.
      // A newer intent owns recovery; never stop a different container identity.
      if (!(error instanceof RuntimeControlError)
          || !['superseded', 'identity-mismatch'].includes(error.problem)) {
        await this.stopOwned(intent, current);
      }
      throw error;
    }
  }

  private async startOwned(intent: RuntimeIntent, current: () => boolean): Promise<RuntimeState> {
    const check = () => { if (!current()) throw new RuntimeControlError('superseded'); };
    check();
    if (intent.policy.credentialExpiresAt <= Date.now()) {
      throw new RuntimeControlError('credential-expired');
    }
    const info = await this.engine.json(intent.policy, ['info', '--format', '{{json .}}']) as Record<string, unknown>;
    check();
    if (info.OSType !== 'linux' || info.MemoryLimit !== true || info.SwapLimit !== true || info.PidsLimit !== true
        || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.includes('name=seccomp,profile=builtin')) {
      throw new RuntimeControlError('isolation-mismatch');
    }
    const volumes = await this.engine.json(intent.policy, ['volume', 'inspect', intent.policy.dataVolume,
      intent.policy.homeVolume, intent.policy.authorityVolume]);
    check();
    verifyLocalVolumes(volumes, intent);
    const before = await this.inspect(intent);
    check();
    if (before !== intent.desired) {
      await this.engine.run(intent.policy, ['container', 'start', intent.policy.containerId]);
      check();
    }
    const observed = await this.inspect(intent);
    check();
    if (observed !== intent.desired) throw new RuntimeControlError('state-unconfirmed');
    const authority = await this.engine.json(intent.policy, ['container', 'exec', '--user', '1000:1000',
      '--workdir', '/app', intent.policy.containerId, '/usr/local/bin/node',
      '/app/packages/shared-controller/dist/runtime-authority.js']) as Record<string, unknown>;
    check();
    if (authority.actorId !== intent.actorId || authority.digest !== intent.credentialDigest
        || authority.expiresAt !== intent.policy.credentialExpiresAt || typeof authority.issuedAt !== 'number'
        || authority.issuedAt > Date.now()) {
      throw new RuntimeControlError('isolation-mismatch');
    }
    return observed;
  }
}

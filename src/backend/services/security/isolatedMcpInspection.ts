/** Inputs are trusted launch expectations, not values recovered from Docker. */
export interface IsolatedMcpInspectionExpectation {
  readonly containerId: string;
  readonly generation: string;
  readonly name: string;
  /** Docker's resolved image configuration ID, not a registry manifest digest. */
  readonly imageId: string;
  readonly ownershipKey?: string;
  readonly policy: {
    readonly memoryMiB: number;
    readonly cpus: number;
    readonly pidsLimit: number;
    readonly command: readonly string[];
  };
  readonly mounts: readonly { readonly source: string; readonly target: string }[];
}

export class IsolatedMcpInspectionError extends Error {
  constructor() {
    // Never include daemon output, paths, environment, or failed values here.
    super('MCP isolation configuration could not be verified.');
    this.name = 'IsolatedMcpInspectionError';
  }
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new IsolatedMcpInspectionError();
}

function record(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function emptyList(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function emptyRecord(value: unknown): boolean {
  return value === undefined || value === null
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => typeof item === 'string' && item === expected[index]);
}

/**
 * These flags are the daemon's advertised support, not a measurement of kernel
 * enforcement. Missing or unsupported limits cannot qualify an isolated launch.
 */
export function assertIsolatedMcpDaemonInfo(value: unknown): void {
  const info = record(value);
  requireCondition(info.OSType === 'linux');
  // Rootless daemon/user-namespace behavior has a separate support contract.
  // Do not silently qualify it from a Linux OS string and limit flags alone.
  requireCondition(Array.isArray(info.SecurityOptions)
    && info.SecurityOptions.every(option => typeof option === 'string' && !/(?:^|,)name=rootless(?:,|$)|^rootless$/.test(option)));
  for (const capability of ['MemoryLimit', 'SwapLimit', 'CpuCfsPeriod', 'CpuCfsQuota', 'PidsLimit']) {
    requireCondition(info[capability] === true);
  }
}

function checkMounts(container: Record<string, unknown>, host: Record<string, unknown>,
  expected: IsolatedMcpInspectionExpectation): void {
  requireCondition(emptyList(host.Binds) && emptyList(host.VolumesFrom));
  const configured = host.Mounts === undefined && expected.mounts.length === 0 ? [] : host.Mounts;
  requireCondition(Array.isArray(configured) && configured.length === expected.mounts.length);
  requireCondition(Array.isArray(container.Mounts) && container.Mounts.length === expected.mounts.length);
  const targets = new Set(expected.mounts.map(mount => mount.target));
  requireCondition(targets.size === expected.mounts.length);
  const configuredTargets = new Set<string>();
  for (const item of configured) {
    const mount = record(item);
    const grant = expected.mounts.find(approved => approved.target === mount.Target);
    requireCondition(grant && typeof grant.source === 'string' && grant.source.length > 0);
    requireCondition(mount.Type === 'bind' && mount.Source === grant.source && mount.ReadOnly === true);
    requireCondition(!configuredTargets.has(grant.target));
    configuredTargets.add(grant.target);
    const options = record(mount.BindOptions);
    // Disabling recursive binds excludes writable submounts and nested host
    // filesystems from an otherwise read-only directory grant.
    requireCondition(options.NonRecursive === true);
    requireCondition(options.Propagation === undefined || options.Propagation === '' || options.Propagation === 'rprivate');
    requireCondition(options.CreateMountpoint !== true);
    for (const key of ['VolumeOptions', 'TmpfsOptions', 'ClusterOptions', 'ImageOptions']) {
      requireCondition(emptyRecord(mount[key]));
    }
  }
  const observedTargets = new Set<string>();
  for (const item of container.Mounts) {
    const mount = record(item);
    requireCondition(typeof mount.Destination === 'string' && targets.has(mount.Destination));
    requireCondition(!observedTargets.has(mount.Destination));
    observedTargets.add(mount.Destination);
    requireCondition(mount.Type === 'bind' && mount.RW === false);
    requireCondition(typeof mount.Source === 'string' && mount.Source.length > 0);
    requireCondition(mount.Propagation === 'rprivate');
    // Docker Desktop translates host paths here. The exact approved source is
    // checked above in HostConfig; do not invent a host-to-VM path mapping.
  }
  const tmpfs = record(host.Tmpfs);
  requireCondition(Object.keys(tmpfs).length === 1 && typeof tmpfs['/tmp'] === 'string');
  const options = tmpfs['/tmp'].split(',');
  const approved = ['rw', 'noexec', 'nosuid', 'nodev', 'size=16m', 'mode=1777'];
  requireCondition(options.length === approved.length && new Set(options).size === approved.length
    && approved.every(option => options.includes(option)));
  requireCondition(host.ShmSize === 1024 * 1024);
}

/**
 * Verify a fresh, stopped container before returning an ID-based start command.
 * Accept one inspect object or the CLI's one-element JSON array. This validates
 * the trusted daemon's recorded configuration; it is not kernel attestation and
 * cannot prevent a separate Docker administrator from changing it afterward.
 * This helper performs no Docker calls and never mutates its inputs.
 */
export function assertIsolatedMcpContainerInspection(value: unknown,
  expected: IsolatedMcpInspectionExpectation): void {
  requireCondition(/^[a-f0-9]{64}$/.test(expected.containerId));
  requireCondition(/^sha256:[a-f0-9]{64}$/.test(expected.imageId));
  requireCondition(expected.generation.length > 0 && expected.name.length > 0);
  if (Array.isArray(value)) requireCondition(value.length === 1);
  const container = record(Array.isArray(value) ? value[0] : value);
  requireCondition(container.Id === expected.containerId && container.Name === `/${expected.name}`);
  requireCondition(container.Image === expected.imageId && container.RestartCount === 0);
  const state = record(container.State);
  requireCondition(state.Status === 'created' && state.Running === false && state.Pid === 0
    && state.Paused === false && state.Restarting === false && state.Dead === false);
  requireCondition(state.StartedAt === '0001-01-01T00:00:00Z'
    && state.FinishedAt === '0001-01-01T00:00:00Z');
  const config = record(container.Config);
  requireCondition(config.Image === expected.imageId && config.User === '65534:65534');
  requireCondition(sameStrings(config.Cmd, expected.policy.command));
  const labels = record(config.Labels);
  requireCondition(labels['co.flujo.mcp-generation'] === expected.generation);
  requireCondition(labels['co.flujo.mcp-ownership'] === expected.ownershipKey);
  requireCondition(emptyRecord(config.Volumes));
  requireCondition(sameStrings(record(config.Healthcheck).Test, ['NONE']));
  const host = record(container.HostConfig);
  requireCondition(host.ReadonlyRootfs === true && host.Privileged === false && host.Init === true);
  requireCondition(host.NetworkMode === 'none' && host.PublishAllPorts === false && emptyRecord(host.PortBindings));
  const networking = record(container.NetworkSettings);
  const networks = record(networking.Networks);
  requireCondition(Object.keys(networks).every(network => network === 'none'));
  const ports = networking.Ports === null ? {} : record(networking.Ports);
  requireCondition(Object.values(ports).every(binding => binding === null));
  requireCondition(emptyList(host.CapAdd));
  requireCondition(sameStrings(host.CapDrop, ['ALL']) || sameStrings(host.CapDrop, ['CAP_ALL']));
  requireCondition(sameStrings(host.SecurityOpt, ['no-new-privileges:true'])
    || sameStrings(host.SecurityOpt, ['no-new-privileges']));
  requireCondition(host.Memory === expected.policy.memoryMiB * 1024 * 1024
    && host.MemorySwap === expected.policy.memoryMiB * 1024 * 1024);
  requireCondition(host.NanoCpus === Math.round(expected.policy.cpus * 1_000_000_000)
    && host.PidsLimit === expected.policy.pidsLimit);
  requireCondition(host.OomKillDisable === false || host.OomKillDisable === null);
  requireCondition(host.CpuPeriod === 0 && host.CpuQuota === 0
    && host.CpuRealtimePeriod === 0 && host.CpuRealtimeRuntime === 0);
  for (const namespace of ['PidMode', 'UTSMode', 'UsernsMode']) {
    requireCondition(host[namespace] === '' || host[namespace] === 'private');
  }
  requireCondition(host.IpcMode === 'private' && host.CgroupnsMode === 'private');
  requireCondition(host.CgroupParent === '' && host.Runtime === 'runc');
  for (const extra of ['Devices', 'DeviceCgroupRules', 'DeviceRequests', 'GroupAdd', 'Links', 'ExtraHosts']) {
    requireCondition(emptyList(host[extra]));
  }
  requireCondition(emptyRecord(host.Sysctls) && emptyRecord(host.Annotations));
  requireCondition(record(host.LogConfig).Type === 'none');
  const restart = record(host.RestartPolicy);
  requireCondition(restart.Name === 'no' && restart.MaximumRetryCount === 0 && host.AutoRemove === false);
  checkMounts(container, host, expected);
}

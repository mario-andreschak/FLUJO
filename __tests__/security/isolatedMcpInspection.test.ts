import {
  assertIsolatedMcpContainerInspection, assertIsolatedMcpDaemonInfo,
  IsolatedMcpInspectionError, type IsolatedMcpInspectionExpectation,
} from '@/backend/services/security/isolatedMcpInspection';

const expected: IsolatedMcpInspectionExpectation = {
  containerId: 'c'.repeat(64), generation: 'generation-fixture', name: 'flujo-mcp-fixture',
  imageId: `sha256:${'a'.repeat(64)}`, ownershipKey: 'd'.repeat(64),
  policy: { memoryMiB: 128, cpus: 0.5, pidsLimit: 32, command: ['node', 'server.js'] },
  mounts: [{ source: 'C:\\workspace\\storage\\mcp-grants\\public', target: '/grants/public' }],
};

function inspection(): Record<string, unknown> {
  return {
    Id: expected.containerId, Name: `/${expected.name}`, Image: expected.imageId, RestartCount: 0,
    State: {
      Status: 'created', Running: false, Pid: 0, Paused: false, Restarting: false, Dead: false,
      StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z',
    },
    Config: {
      Image: expected.imageId, User: '65534:65534', Cmd: ['node', 'server.js'],
      Labels: { 'co.flujo.mcp-generation': expected.generation, 'co.flujo.mcp-ownership': expected.ownershipKey },
      Volumes: null, Healthcheck: { Test: ['NONE'] },
    },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, Init: true,
      NetworkMode: 'none', PublishAllPorts: false, PortBindings: {},
      CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      Memory: 134217728, MemorySwap: 134217728, NanoCpus: 500000000, PidsLimit: 32,
      OomKillDisable: false, CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0,
      PidMode: '', UTSMode: '', UsernsMode: '', IpcMode: 'private', CgroupnsMode: 'private',
      CgroupParent: '', Runtime: 'runc',
      Devices: [], DeviceCgroupRules: null, DeviceRequests: null, GroupAdd: null, Links: null, ExtraHosts: null,
      Binds: null, VolumesFrom: null, Sysctls: null, Annotations: null,
      Mounts: [{
        Type: 'bind', Source: expected.mounts[0].source, Target: '/grants/public', ReadOnly: true,
        BindOptions: { NonRecursive: true },
      }],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777' }, ShmSize: 1048576,
      LogConfig: { Type: 'none', Config: {} }, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
    },
    Mounts: [{
      Type: 'bind', Source: '/run/desktop/mnt/host/c/workspace/storage/mcp-grants/public',
      Destination: '/grants/public', RW: false, Propagation: 'rprivate',
    }],
    NetworkSettings: { Networks: { none: {} }, Ports: {} },
  };
}

function setField(value: Record<string, unknown>, field: string, replacement: unknown): void {
  const keys = field.split('.');
  let current = value;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys[keys.length - 1]] = replacement;
}

test('accepts the exact fresh container and the CLI singleton array without mutating evidence', () => {
  const value = inspection();
  const before = JSON.stringify({ value, expected });
  assertIsolatedMcpContainerInspection(value, expected);
  assertIsolatedMcpContainerInspection([value], expected);
  expect(JSON.stringify({ value, expected })).toBe(before);
});

test('allows Docker Desktop source translation only after validating the exact configured source', () => {
  const value = inspection();
  setField(value, 'Mounts.0.Source', '/daemon/translated/approved/source');
  assertIsolatedMcpContainerInspection(value, expected);
  setField(value, 'HostConfig.Mounts.0.Source', 'C:\\private');
  expect(() => assertIsolatedMcpContainerInspection(value, expected)).toThrow(IsolatedMcpInspectionError);
});

test('supports no optional ownership key and no grants without allowing an unexpected ownership label', () => {
  const value = inspection();
  setField(value, 'Config.Labels', { 'co.flujo.mcp-generation': expected.generation });
  setField(value, 'HostConfig.Mounts', undefined);
  setField(value, 'Mounts', []);
  const withoutGrants = { ...expected, ownershipKey: undefined, mounts: [] };
  assertIsolatedMcpContainerInspection(value, withoutGrants);
  setField(value, 'Config.Labels', { 'co.flujo.mcp-generation': expected.generation, 'co.flujo.mcp-ownership': 'unexpected' });
  expect(() => assertIsolatedMcpContainerInspection(value, withoutGrants)).toThrow(IsolatedMcpInspectionError);
});

test('allows image exposed ports with no published binding and semantically identical tmpfs options', () => {
  const value = inspection();
  setField(value, 'NetworkSettings.Ports', { '80/tcp': null });
  setField(value, 'HostConfig.PortBindings', null);
  setField(value, 'HostConfig.Tmpfs', { '/tmp': 'nodev,size=16m,rw,mode=1777,nosuid,noexec' });
  setField(value, 'HostConfig.CapDrop', ['CAP_ALL']);
  setField(value, 'HostConfig.SecurityOpt', ['no-new-privileges']);
  assertIsolatedMcpContainerInspection(value, expected);
});

test.each([
  ['different container ID', 'Id', 'e'.repeat(64)],
  ['truncated container ID', 'Id', expected.containerId.slice(0, 12)],
  ['different owner name', 'Name', '/another-container'],
  ['different generation', 'Config.Labels', { 'co.flujo.mcp-generation': 'old-generation', 'co.flujo.mcp-ownership': expected.ownershipKey }],
  ['different ownership key', 'Config.Labels', { 'co.flujo.mcp-generation': expected.generation, 'co.flujo.mcp-ownership': 'unrelated' }],
  ['different resolved image', 'Image', `sha256:${'b'.repeat(64)}`],
  ['mutable configured image', 'Config.Image', 'node:latest'],
  ['changed command', 'Config.Cmd', ['node', 'other.js']],
  ['already running', 'State.Running', true],
  ['already executed', 'State.Status', 'exited'],
  ['already started timestamp', 'State.StartedAt', '2026-10-25T01:00:00Z'],
  ['already finished timestamp', 'State.FinishedAt', '2026-10-25T01:00:00Z'],
  ['live PID', 'State.Pid', 123],
  ['paused process', 'State.Paused', true],
  ['restarting process', 'State.Restarting', true],
  ['dead container', 'State.Dead', true],
  ['previous restart', 'RestartCount', 1],
  ['root user', 'Config.User', '0:0'],
  ['writable root', 'HostConfig.ReadonlyRootfs', false],
  ['privileged runtime', 'HostConfig.Privileged', true],
  ['missing init', 'HostConfig.Init', false],
  ['bridge network', 'HostConfig.NetworkMode', 'bridge'],
  ['publish all ports', 'HostConfig.PublishAllPorts', true],
  ['configured published port', 'HostConfig.PortBindings', { '80/tcp': [{ HostPort: '8080' }] }],
  ['observed published port', 'NetworkSettings.Ports', { '80/tcp': [{ HostPort: '8080' }] }],
  ['extra network attachment', 'NetworkSettings.Networks', { none: {}, bridge: {} }],
  ['capability addition', 'HostConfig.CapAdd', ['SYS_ADMIN']],
  ['missing full capability drop', 'HostConfig.CapDrop', ['NET_RAW']],
  ['no privilege barrier', 'HostConfig.SecurityOpt', []],
  ['additional unconfined security option', 'HostConfig.SecurityOpt', ['no-new-privileges:true', 'seccomp=unconfined']],
  ['unbounded memory', 'HostConfig.Memory', 0],
  ['different memory limit', 'HostConfig.Memory', 268435456],
  ['unlimited swap', 'HostConfig.MemorySwap', -1],
  ['changed CPU limit', 'HostConfig.NanoCpus', 1000000000],
  ['unlimited PIDs', 'HostConfig.PidsLimit', -1],
  ['OOM killer disabled', 'HostConfig.OomKillDisable', true],
  ['unapproved CPU quota', 'HostConfig.CpuQuota', 100000],
  ['host PID namespace', 'HostConfig.PidMode', 'host'],
  ['shared container PID namespace', 'HostConfig.PidMode', 'container:other'],
  ['host UTS namespace', 'HostConfig.UTSMode', 'host'],
  ['host user namespace override', 'HostConfig.UsernsMode', 'host'],
  ['host IPC namespace', 'HostConfig.IpcMode', 'host'],
  ['host cgroup namespace', 'HostConfig.CgroupnsMode', 'host'],
  ['custom cgroup parent', 'HostConfig.CgroupParent', '/host'],
  ['custom runtime', 'HostConfig.Runtime', 'unverified-runtime'],
  ['host device', 'HostConfig.Devices', [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda' }]],
  ['all-device cgroup rule', 'HostConfig.DeviceCgroupRules', ['a *:* rwm']],
  ['GPU device request', 'HostConfig.DeviceRequests', [{ Driver: 'nvidia', Count: -1 }]],
  ['additional group', 'HostConfig.GroupAdd', ['0']],
  ['legacy link', 'HostConfig.Links', ['other']],
  ['extra host alias', 'HostConfig.ExtraHosts', ['host.docker.internal:host-gateway']],
  ['sysctl override', 'HostConfig.Sysctls', { 'net.ipv4.ip_forward': '1' }],
  ['runtime annotation', 'HostConfig.Annotations', { 'runtime.option': 'unapproved' }],
  ['unexpected log driver', 'HostConfig.LogConfig.Type', 'json-file'],
  ['automatic restart', 'HostConfig.RestartPolicy.Name', 'always'],
  ['automatic deletion', 'HostConfig.AutoRemove', true],
  ['image-declared volume', 'Config.Volumes', { '/private': {} }],
  ['image healthcheck', 'Config.Healthcheck.Test', ['CMD', 'node', 'probe.js']],
  ['legacy bind', 'HostConfig.Binds', ['/:/host:rw']],
  ['volumes from another container', 'HostConfig.VolumesFrom', ['other:rw']],
  ['writable configured grant', 'HostConfig.Mounts.0.ReadOnly', false],
  ['recursive host submounts', 'HostConfig.Mounts.0.BindOptions.NonRecursive', false],
  ['shared configured propagation', 'HostConfig.Mounts.0.BindOptions.Propagation', 'rshared'],
  ['implicit host directory creation', 'HostConfig.Mounts.0.BindOptions.CreateMountpoint', true],
  ['unapproved configured target', 'HostConfig.Mounts.0.Target', '/host'],
  ['writable effective grant', 'Mounts.0.RW', true],
  ['shared effective propagation', 'Mounts.0.Propagation', 'rshared'],
  ['unapproved effective target', 'Mounts.0.Destination', '/host'],
  ['implicit effective volume', 'Mounts.0.Type', 'volume'],
  ['missing effective source', 'Mounts.0.Source', ''],
  ['extra effective mount', 'Mounts', [{ Type: 'bind', Destination: '/grants/public', RW: false }, { Type: 'volume', Destination: '/private', RW: true }]],
  ['extra tmpfs', 'HostConfig.Tmpfs', { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777', '/extra': 'rw' }],
  ['executable tmpfs', 'HostConfig.Tmpfs', { '/tmp': 'rw,exec,nosuid,nodev,size=16m,mode=1777' }],
  ['oversized tmpfs', 'HostConfig.Tmpfs', { '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777' }],
  ['contradictory tmpfs flags', 'HostConfig.Tmpfs', { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777,exec' }],
  ['oversized shared memory', 'HostConfig.ShmSize', 67108864],
] as const)('rejects %s', (_description, field, replacement) => {
  const value = inspection();
  setField(value, field, replacement);
  expect(() => assertIsolatedMcpContainerInspection(value, expected)).toThrow(IsolatedMcpInspectionError);
});

test.each([
  'Id', 'Image', 'State.Running', 'State.Status', 'Config.User', 'Config.Labels', 'Config.Healthcheck',
  'HostConfig.Init', 'HostConfig.Privileged', 'HostConfig.Memory', 'HostConfig.NanoCpus', 'HostConfig.PidsLimit',
  'HostConfig.CapDrop', 'HostConfig.SecurityOpt', 'HostConfig.NetworkMode', 'HostConfig.ReadonlyRootfs',
  'HostConfig.Tmpfs', 'HostConfig.Mounts.0.BindOptions', 'Mounts', 'NetworkSettings',
])('fails closed when required evidence %s is missing', field => {
  const value = inspection();
  setField(value, field, undefined);
  expect(() => assertIsolatedMcpContainerInspection(value, expected)).toThrow(IsolatedMcpInspectionError);
});

test.each([undefined, null, true, 'secret-daemon-output', [], [inspection(), inspection()], { Id: expected.containerId }])(
  'rejects malformed or ambiguous inspect output without leaking it', value => {
    let failure: unknown;
    try { assertIsolatedMcpContainerInspection(value, expected); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(IsolatedMcpInspectionError);
    expect(String(failure)).not.toContain('secret-daemon-output');
    expect(String(failure)).not.toContain(expected.mounts[0].source);
  },
);

test('rejects duplicate mounts even when their count matches the approved grants', () => {
  const value = inspection();
  const approved = { ...expected, mounts: [...expected.mounts, { source: '/approved/other', target: '/grants/other' }] };
  const host = value.HostConfig as Record<string, unknown>;
  host.Mounts = [...host.Mounts as unknown[], ...host.Mounts as unknown[]];
  value.Mounts = [...value.Mounts as unknown[], ...value.Mounts as unknown[]];
  expect(() => assertIsolatedMcpContainerInspection(value, approved)).toThrow(IsolatedMcpInspectionError);
});

const daemonInfo = {
  OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true,
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
};

test('requires the Linux daemon to advertise support for every enforced resource limit', () => {
  assertIsolatedMcpDaemonInfo(daemonInfo);
  for (const capability of ['MemoryLimit', 'SwapLimit', 'CpuCfsPeriod', 'CpuCfsQuota', 'PidsLimit']) {
    for (const unsupported of [false, undefined, 'true']) {
      expect(() => assertIsolatedMcpDaemonInfo({ ...daemonInfo, [capability]: unsupported }))
        .toThrow(IsolatedMcpInspectionError);
    }
  }
  expect(() => assertIsolatedMcpDaemonInfo({ ...daemonInfo, OSType: 'windows' })).toThrow(IsolatedMcpInspectionError);
  expect(() => assertIsolatedMcpDaemonInfo({ OSType: 'linux' })).toThrow(IsolatedMcpInspectionError);
  expect(() => assertIsolatedMcpDaemonInfo({ ...daemonInfo, SecurityOptions: ['name=rootless'] })).toThrow(IsolatedMcpInspectionError);
  expect(() => assertIsolatedMcpDaemonInfo({ ...daemonInfo, SecurityOptions: undefined })).toThrow(IsolatedMcpInspectionError);
});

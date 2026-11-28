import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsPrivateAuthorityStampAsync } from '@/backend/services/security/windowsPrivateAuthority';
import { assertIsolatedMcpContainerInspection } from '@/backend/services/security/isolatedMcpInspection';
import {
  createIsolatedMcpLaunch, isDockerCliPath, isolatedMcpPolicyDigest, McpIsolationError,
  type IsolatedMcpPolicy,
} from '@/backend/services/security/isolatedMcp';

const mockExecute = jest.fn<string, [string, string[], { env?: Record<string, string> }]>();
// Docker answers on a later turn of the event loop, like the real CLI.
jest.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], options: { env?: Record<string, string> }, callback: (error: Error | null, stdout: string) => void) => {
    let stdout = '';
    let failure: Error | null = null;
    try { stdout = mockExecute(command, args, options); } catch (error) { failure = error as Error; }
    setImmediate(() => callback(failure, stdout));
    return {};
  },
}));
jest.mock('@/backend/services/security/windowsPrivateAuthority', () => ({ windowsPrivateAuthorityStampAsync: jest.fn() }));
jest.mock('@/backend/services/security/isolatedMcpInspection', () => ({
  ...jest.requireActual('@/backend/services/security/isolatedMcpInspection'), assertIsolatedMcpContainerInspection: jest.fn(),
}));
const daemonInfo = { OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: [] };
const execute = mockExecute;
const id = 'c'.repeat(64);
const controls = new Set<string>();
let workspace: string;
let policy: IsolatedMcpPolicy;
let generation: string;
let exists: boolean;
let refuseRemoval: boolean;
let wrongOwner: boolean;
let grantsFilename: string | undefined;
let grantsContent: string | undefined;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-mcp-policy-test-'));
  fs.mkdirSync(path.join(workspace, 'storage/mcp-grants/public'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'storage/mcp-grants/public/example.txt'), 'public fixture');
  policy = {
    schemaVersion: 1, kind: 'docker-deny-egress', image: `sha256:${'a'.repeat(64)}`,
    dockerExecutable: path.join(workspace, 'docker'),
    daemon: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
    command: ['node', 'server.js'], environmentNames: ['TEST_GRANTED_TOKEN'],
    mounts: [{ name: 'public', source: 'storage/mcp-grants/public' }],
    memoryMiB: 128, cpus: 0.5, pidsLimit: 32,
  };
  generation = '';
  exists = false;
  refuseRemoval = false;
  wrongOwner = false;
  grantsFilename = undefined;
  grantsContent = undefined;
  jest.mocked(windowsPrivateAuthorityStampAsync).mockReset().mockResolvedValue('private-file');
  jest.mocked(assertIsolatedMcpContainerInspection).mockReset();
  execute.mockReset();
  execute.mockImplementation((_command, arguments_) => {
    const args = [...(arguments_ ?? [])] as string[];
    controls.add(args[args.indexOf('--config') + 1]);
    const operation = args.slice(4);
    if (operation[0] === 'info') return JSON.stringify(daemonInfo);
    if (operation[0] === 'image') return JSON.stringify({ Id: policy.image, Config: { Volumes: null } });
    if (operation[1] === 'inspect') return JSON.stringify({ Id: id });
    if (operation[1] === 'create') {
      const envIndex = args.indexOf('--env-file');
      if (envIndex !== -1) {
        grantsFilename = args[envIndex + 1];
        grantsContent = fs.readFileSync(grantsFilename, 'utf8');
      }
      generation = args[args.indexOf('--label') + 1].split('=')[1];
      exists = true;
      return `${id}\n`;
    }
    if (operation[1] === 'ls') return exists ? `${id} ${wrongOwner ? 'unrelated' : generation}\n` : '';
    if (operation[1] === 'rm') {
      if (!refuseRemoval) exists = false;
      return `${id}\n`;
    }
    throw new Error('Unexpected mock Docker operation');
  });
});

afterEach(() => {
  for (const directory of [...controls, workspace]) {
    const temp = path.resolve(directory === workspace ? os.tmpdir() : process.platform === 'win32' ? process.env.LOCALAPPDATA! : os.tmpdir());
    const relative = path.relative(temp, directory);
    if (!/^flujo-mcp-(?:isolation|policy-test)-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe test cleanup target');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  controls.clear();
});

const launch = () => createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
  { TEST_GRANTED_TOKEN: 'approved secret', HOST_SECRET: 'must not escape' });

test('creates a stopped container with OS restrictions, then attaches by its exact immutable ID', async () => {
  const result = await launch();
  const createCall = execute.mock.calls.find(([, args]) => args?.includes('create'))!;
  const args = createCall[1] as string[];
  expect(args).toEqual(expect.arrayContaining([
    '--init', '--pull=never', '--read-only', '--network=none', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--user=65534:65534', '--no-healthcheck',
    '--log-driver=none',
    '--memory', '128m', '--memory-swap', '--cpus', '0.5', '--pids-limit', '32',
  ]));
  expect(args.some(arg => arg.includes('target=/grants/public,readonly'))).toBe(true);
  expect(args).not.toContain('approved secret');
  expect(grantsContent).toBe('TEST_GRANTED_TOKEN=approved secret\n');
  expect(grantsFilename).toBeDefined();
  expect(fs.existsSync(grantsFilename!)).toBe(false);
  expect(createCall[2]?.env).not.toHaveProperty('TEST_GRANTED_TOKEN');
  expect(createCall[2]?.env).not.toHaveProperty('HOST_SECRET');
  expect(result.env).not.toHaveProperty('TEST_GRANTED_TOKEN');
  expect(result.env).not.toHaveProperty('HOST_SECRET');
  expect(result.env.NODE_ENV).toBe('production');
  expect(result.args.slice(4)).toEqual(['container', 'start', '--attach', '--interactive', id]);
  expect(result.containerId).toBe(id);
  expect(assertIsolatedMcpContainerInspection).toHaveBeenCalledWith({ Id: id }, expect.objectContaining({
    containerId: id, generation: result.generation, imageId: policy.image,
    mounts: [{ source: fs.realpathSync(path.join(workspace, 'storage/mcp-grants/public')), target: '/grants/public' }],
  }));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.args)).toBe(true);
  expect((await result.close()).outcome).toBe('removed');
  expect(fs.existsSync(result.cwd)).toBe(false);
  const calls = execute.mock.calls.length;
  expect((await result.close()).outcome).toBe('removed');
  expect(execute).toHaveBeenCalledTimes(calls);
});

test('callers that close while a removal runs share it instead of racing a second removal', async () => {
  const result = await launch();
  const [first, second] = await Promise.all([result.close(), result.close()]);
  expect(first).toEqual({ outcome: 'removed' });
  expect(second).toBe(first);
  expect(execute.mock.calls.filter(([, args]) => args?.includes('rm'))).toHaveLength(1);
  expect(fs.existsSync(result.cwd)).toBe(false);
});

test('changes to capabilities require renewed approval before contacting Docker', async () => {
  const approved = isolatedMcpPolicyDigest(policy);
  policy.memoryMiB = 256;
  await expect(createIsolatedMcpLaunch(policy, approved, workspace)).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_RECONSENT_REQUIRED' }));
  expect(execute).not.toHaveBeenCalled();
});

test('a trusted ownership key binds the atomic container name across random generations', async () => {
  const key = 'd'.repeat(64);
  const result = await createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
    { TEST_GRANTED_TOKEN: 'fixture' }, { key });
  const args = execute.mock.calls.find(([, args]) => args?.includes('create'))![1]!;
  expect(args).toContain(`flujo-mcp-${key}`);
  expect(args).toContain(`co.flujo.mcp-ownership=${key}`);
  expect(result.ownershipKey).toBe(key);
  expect(args).toContain(`co.flujo.mcp-control=${path.basename(result.cwd)}`);
  await result.close();
});

describe('a start after FLUJO crashed', () => {
  const key = 'd'.repeat(64);
  const stale = 'e'.repeat(64);
  let leftoverFolder: string;
  let leftover: boolean;
  const stopped = (args: string[]) => args.includes('ls') && args.includes('status=exited')
    && args.includes(`name=^/flujo-mcp-${key}$`) && args.includes(`label=co.flujo.mcp-ownership=${key}`);
  beforeEach(() => {
    const temp = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA! : os.tmpdir());
    leftoverFolder = fs.mkdtempSync(path.join(temp, 'flujo-mcp-isolation-'));
    controls.add(leftoverFolder);
    leftover = true;
  });
  const launchOwned = () => createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace, { TEST_GRANTED_TOKEN: 'fixture' }, { key });

  test('removes the stopped sandbox the crashed process left under the same name, and its control folder', async () => {
    const normal = execute.getMockImplementation()!;
    execute.mockImplementation((command, args, options) => {
      if (stopped(args)) return leftover ? `${stale} ${path.basename(leftoverFolder)}\n` : '';
      if (args.includes('ls') && args.includes(`id=${stale}`)) return leftover ? `${stale} crashed-generation\n` : '';
      if (args.includes('rm') && args.includes(stale)) { leftover = false; return `${stale}\n`; }
      return normal(command, args, options);
    });
    const result = await launchOwned();
    expect(leftover).toBe(false);
    expect(fs.existsSync(leftoverFolder)).toBe(false);
    // Without --force, Docker refuses a container that is running again by then.
    expect(execute.mock.calls.find(([, args]) => args.includes('rm') && args.includes(stale))![1]).not.toContain('--force');
    const order = execute.mock.calls.map(([, args]) => args.includes('create') ? 'create' : args.includes(stale) && args.includes('rm') ? 'rm' : '').filter(Boolean);
    expect(order).toEqual(['rm', 'create']);
    expect(result.containerId).toBe(id);
    await result.close();
  });

  test('a sandbox still running under the same name is never removed, and the start reports it unavailable', async () => {
    const normal = execute.getMockImplementation()!;
    execute.mockImplementation((command, args, options) => {
      // It stopped while listed but runs again: Docker refuses a plain removal.
      if (stopped(args)) return `${stale} ${path.basename(leftoverFolder)}\n`;
      if (args.includes('rm') && args.includes(stale)) throw new Error('cannot remove a running container');
      if (args.includes('create')) throw new Error('Conflict. The container name is already in use');
      if (args.includes('ls') && args.includes(`name=^/flujo-mcp-${key}$`)) return `${stale} live-generation\n`;
      return normal(command, args, options);
    });
    await expect(launchOwned()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
    expect(fs.existsSync(leftoverFolder)).toBe(true);
    expect(execute.mock.calls.filter(([, args]) => args.includes('rm') && args.includes('--force'))).toHaveLength(0);
    // The other container holds the name, so this start made none: its own control folder goes.
    const created = execute.mock.calls.find(([, args]) => args.includes('create'))![1];
    expect(fs.existsSync(created[created.indexOf('--config') + 1])).toBe(false);
  });
});

test('the digest is independent of set ordering and binds command, image, mounts and daemon', () => {
  policy.environmentNames.push('SECOND_TOKEN');
  policy.mounts.push({ name: 'other', source: 'storage/mcp-grants/other' });
  const digest = isolatedMcpPolicyDigest(policy);
  expect(isolatedMcpPolicyDigest({ ...policy, environmentNames: [...policy.environmentNames].reverse(), mounts: [...policy.mounts].reverse() })).toBe(digest);
  for (const change of [{ command: ['other'] }, { image: `sha256:${'b'.repeat(64)}` }, { mounts: [] },
    { daemon: 'unix:///different.sock' }, { dockerExecutable: path.join(workspace, 'other', 'docker') }]) {
    expect(isolatedMcpPolicyDigest({ ...policy, ...change })).not.toBe(digest);
  }
});

test.each([
  ['mutable image', { image: 'node:latest' }],
  ['remote daemon', { daemon: 'tcp://example.com:2375' }],
  ['relative Docker executable', { dockerExecutable: 'docker' }],
  ['shell instead of Docker', { dockerExecutable: path.resolve('/bin/sh') }],
  ['Windows command shell instead of Docker', { dockerExecutable: path.resolve('/Windows/System32/cmd.exe') }],
  ['look-alike Docker name', { dockerExecutable: path.resolve('/opt/docker-helper') }],
  ['Docker name with a hidden suffix', { dockerExecutable: path.resolve('/opt/docker.exe.cmd') }],
  ['host traversal grant', { mounts: [{ name: 'bad', source: 'storage/mcp-grants/../../secret' }] }],
  ['absolute host grant', { mounts: [{ name: 'bad', source: 'C:/private' }] }],
  ['Docker control environment', { environmentNames: ['DOCKER_HOST'] }],
  ['FLUJO control environment', { environmentNames: ['FLUJO_OWNER_AUTH_FILE'] }],
  ['duplicate environment grant', { environmentNames: ['TOKEN', 'TOKEN'] }],
  ['duplicate mount name', { mounts: [{ name: 'public', source: 'storage/mcp-grants/a' }, { name: 'public', source: 'storage/mcp-grants/b' }] }],
  ['unbounded processes', { pidsLimit: 0 }],
  ['unbounded memory', { memoryMiB: 0 }],
  ['extra Docker flags', { extraArgs: ['--privileged'] }],
  ['empty command', { command: [] }],
  ['NUL command', { command: ['node', '\0'] }],
])('rejects %s before Docker launch', (_description, change) => {
  expect(() => isolatedMcpPolicyDigest({ ...policy, ...change })).toThrow(McpIsolationError);
  expect(execute).not.toHaveBeenCalled();
});

test('accepts only the Docker program itself as the host executable', async () => {
  expect(isDockerCliPath(path.join(workspace, 'docker'))).toBe(true);
  expect(isDockerCliPath(path.join(workspace, 'Docker.EXE'))).toBe(true);
  expect(isDockerCliPath(path.join(workspace, 'docker.cmd'))).toBe(false);
  expect(isDockerCliPath(path.join(workspace, 'podman'))).toBe(false);
  expect(isDockerCliPath(`${path.join(workspace, 'docker')}\0`)).toBe(false);
  const result = await launch();
  expect(new Set(execute.mock.calls.map(([command]) => command))).toEqual(new Set([policy.dockerExecutable]));
  expect(result.command).toBe(policy.dockerExecutable);
  await result.close();
});

test.each([undefined, 'a\0b', 'a\rB=bad', 'a\nB=bad', 'a'.repeat(16 * 1024 + 1)])('rejects missing or invalid environment grant values', async value => {
  await expect(createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
    { TEST_GRANTED_TOKEN: value as string })).rejects.toThrow(McpIsolationError);
  expect(execute).not.toHaveBeenCalled();
});

test('container loader and CLI controls cannot influence any host Docker process', async () => {
  policy.environmentNames = ['LD_PRELOAD', 'GODEBUG', 'SSLKEYLOGFILE', 'PATH', 'SYSTEMROOT'];
  const values = Object.fromEntries(policy.environmentNames.map(name => [name, `container-only-${name}`]));
  const result = await createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace, values);
  expect(grantsContent).toBe(policy.environmentNames.map(name => `${name}=${values[name]}\n`).join(''));
  await result.close();
  for (const [, args, options] of execute.mock.calls) {
    for (const [name, value] of Object.entries(values)) {
      expect(args).not.toContain(value);
      expect(options?.env?.[name]).not.toBe(value);
    }
  }
});

test('environment files preserve literal equals signs, quotes, spaces and empty values', async () => {
  policy.environmentNames = ['TOKEN', 'EMPTY'];
  const result = await createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
    { TOKEN: 'a=b # literal "value" ', EMPTY: '' });
  expect(grantsContent).toBe('TOKEN=a=b # literal "value" \nEMPTY=\n');
  await result.close();
});

test('private grants refuse outsider-readable files before writing secret bytes', async () => {
  const open = fs.promises.open.bind(fs.promises);
  let restore = () => {};
  if (process.platform === 'win32') {
    jest.mocked(windowsPrivateAuthorityStampAsync).mockImplementation(async filename => {
      expect(fs.readFileSync(filename as string)).toHaveLength(0);
      throw new Error('nonprivate fixture');
    });
  } else {
    const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (filename, flags, mode) => {
      const handle = await open(filename, flags, mode);
      if (typeof filename === 'string' && filename.endsWith(`${path.sep}container.env`)) {
        expect((await handle.stat()).size).toBe(0);
        await handle.chmod(0o644);
      }
      return handle;
    });
    restore = () => spy.mockRestore();
  }
  try {
    await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
    expect(execute.mock.calls.some(([, args]) => args?.includes('create'))).toBe(false);
  } finally { restore(); }
});

test('NODE_ENV cannot override the deliberately controlled CLI production environment', async () => {
  policy.environmentNames = ['NODE_ENV'];
  await expect(createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
    { NODE_ENV: 'development' })).rejects.toThrow(McpIsolationError);
  expect(execute).not.toHaveBeenCalled();
  const result = await createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace, { NODE_ENV: 'production' });
  expect(result.env.NODE_ENV).toBe('production');
  await result.close();
});

test('rejects a junction or symlink in a host grant', async () => {
  const outside = path.join(workspace, 'private');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, 'storage/mcp-grants/link'), process.platform === 'win32' ? 'junction' : 'dir');
  policy.mounts = [{ name: 'link', source: 'storage/mcp-grants/link' }];
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_POLICY_INVALID' }));
  expect(execute.mock.calls.some(([, args]) => args?.includes('create'))).toBe(false);
});

test('rejects image-declared volumes rather than granting implicit writable mounts', async () => {
  execute.mockImplementationOnce(() => JSON.stringify(daemonInfo))
    .mockImplementationOnce(() => JSON.stringify({ Id: policy.image, Config: { Volumes: { '/data': {} } } }));
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_POLICY_INVALID' }));
  expect(execute).toHaveBeenCalledTimes(2);
});

test('rejects a non-Linux daemon without creating or executing a host fallback', async () => {
  execute.mockImplementationOnce(() => JSON.stringify({ ...daemonInfo, OSType: 'windows' }));
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each(['MemoryLimit', 'SwapLimit', 'CpuCfsPeriod', 'CpuCfsQuota', 'PidsLimit'])('refuses a daemon without %s support before container creation', async capability => {
  execute.mockImplementationOnce(() => JSON.stringify({ ...daemonInfo, [capability]: false }));
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(execute).toHaveBeenCalledTimes(1);
});

test('an unverified created container is removed without returning a start command', async () => {
  jest.mocked(assertIsolatedMcpContainerInspection).mockImplementation(() => { throw new Error('unsafe daemon record'); });
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(exists).toBe(false);
  expect(execute.mock.calls.some(([, args]) => args?.includes('start') || args?.includes('run'))).toBe(false);
});

test('reconciles a timed out create only by the matching owned generation', async () => {
  const normal = execute.getMockImplementation()!;
  execute.mockImplementation((command, args, options) => {
    const output = normal(command, args, options);
    if (args?.includes('create')) throw new Error('synthetic create timeout with private token');
    return output;
  });
  await expect(launch()).rejects.toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(exists).toBe(false);
  expect(execute.mock.calls.some(([, args]) => args?.includes('start') || args?.includes('run'))).toBe(false);
  expect(execute.mock.calls.find(([, args]) => args?.includes('rm'))?.[1]).toContain(id);
  expect(grantsFilename).toBeDefined();
  expect(fs.existsSync(grantsFilename!)).toBe(false);
});

test('redacts daemon failures and provides no host fallback', async () => {
  execute.mockImplementationOnce(() => { throw new Error('private daemon token=secret'); });
  let failure: unknown;
  try { await launch(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
  expect(String(failure)).not.toContain('secret');
  expect(execute).toHaveBeenCalledTimes(1);
});

test('Docker removal acknowledgement alone cannot establish cleanup', async () => {
  const result = await launch();
  refuseRemoval = true;
  expect(await result.close()).toEqual({ outcome: 'unknown' });
  expect(fs.existsSync(result.cwd)).toBe(true);
  refuseRemoval = false;
  expect(await result.close()).toEqual({ outcome: 'removed' });
});

test('cleanup refuses a container with an unexpected generation', async () => {
  const result = await launch();
  wrongOwner = true;
  expect(await result.close()).toEqual({ outcome: 'unknown' });
  expect(execute.mock.calls.some(([, args]) => args?.includes('rm'))).toBe(false);
});

test('cleanup observes already absent exact container without arbitrary removal', async () => {
  const result = await launch();
  exists = false;
  expect(await result.close()).toEqual({ outcome: 'absent' });
  expect(execute.mock.calls.some(([, args]) => args?.includes('rm'))).toBe(false);
});

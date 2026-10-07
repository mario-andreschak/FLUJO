import fs, { type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeDirectoryAdmission } from '@/backend/services/mcp/runtimeDirectoryAdmission';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { ensureWorkspaceDirs, getWorkspaceDataDir } from '@/utils/workspace';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';
import { trustedHostMcpPolicySchema } from '@/backend/services/security/trustedHostMcp';

const denied = { name: 'RuntimeDirectoryAdmissionError', code: 'UNSAFE_MCP_RUNTIME_DIRECTORY',
  message: 'Isolated MCP runtime directory is unavailable or unsafe.' };
const legacyServerKey = 'af968e26b3d5d8edb6420d34'; // Existing SHA256(server name) directory identity.

describe('isolated MCP runtime directory admission', () => {
  let root: string;
  let userdata: string;
  let container: string;
  let anchor: string;
  let home: string;
  let approved: ReturnType<typeof installTrustedHostProfile> | undefined;
  const processDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const oldEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-runtime-admission-'));
    userdata = path.join(root, 'userdata');
    container = path.join(userdata, 'mcp-runtime');
    anchor = path.join(container, legacyServerKey);
    home = path.join(anchor, 'home');
    for (const key of ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR']) {
      oldEnvironment.set(key, process.env[key]);
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
    approved?.restore();
    approved = undefined;
    for (const [field, descriptor] of processDescriptors) {
      if (descriptor) Object.defineProperty(process, field, descriptor);
      else Reflect.deleteProperty(process, field);
    }
    processDescriptors.clear();
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    oldEnvironment.clear();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-runtime-admission-')) {
      throw new Error('Unexpected runtime fixture cleanup target.');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedDirectories(): void {
    fs.mkdirSync(userdata, { mode: 0o755 });
    fs.mkdirSync(container, { mode: 0o755 });
    fs.mkdirSync(anchor, { mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o755 });
  }
  function admitThroughContainer(): RuntimeDirectoryAdmission {
    const admission = new RuntimeDirectoryAdmission(root);
    admission.admit(userdata);
    admission.admit(container);
    return admission;
  }
  function admitTree(): RuntimeDirectoryAdmission {
    const admission = admitThroughContainer();
    admission.admit(anchor, true);
    admission.admit(home);
    return admission;
  }
  function clone(stat: BigIntStats, patch: Partial<BigIntStats>): BigIntStats {
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, patch);
  }
  function processModel(field: string, value: unknown): void {
    if (!processDescriptors.has(field)) processDescriptors.set(field, Object.getOwnPropertyDescriptor(process, field));
    Object.defineProperty(process, field, { configurable: true, value });
  }
  // Model policy metadata on every host. These are not native POSIX permission
  // or Windows DACL proofs; actual filesystem/type/path operations stay real.
  function modelMetadata(patches = new Map<string, Partial<BigIntStats>>(), platform = 'linux'): void {
    processModel('platform', platform);
    processModel('geteuid', () => 1234);
    processModel('getuid', () => 5678);
    const lstat = fs.lstatSync.bind(fs);
    jest.spyOn(fs, 'lstatSync').mockImplementation((candidate, options) => {
      expect(options).toEqual({ bigint: true });
      const name = String(candidate);
      const actual = lstat(candidate, { bigint: true });
      return clone(actual, { uid: BigInt(1234),
        mode: (actual.mode & ~BigInt(0o777)) | BigInt(name === anchor ? 0o700 : 0o755),
        ...patches.get(name) });
    });
  }

  it('retains existing paths, marker bytes and admitted identities across repeated visits', () => {
    seedDirectories();
    const markerDirectory = path.join(container, 'clone-preparation');
    fs.mkdirSync(markerDirectory);
    const marker = path.join(markerDirectory, 'recipe.json');
    fs.writeFileSync(marker, 'existing-marker');
    const before = fs.lstatSync(anchor, { bigint: true });
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const chmod = jest.spyOn(fs, 'chmodSync');
    const admission = admitTree();
    admission.admit(home);
    admission.admit(anchor);
    admission.verify();
    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(marker, 'utf8')).toBe('existing-marker');
    expect(fs.lstatSync(anchor, { bigint: true }).ino).toBe(before.ino);
  });

  it('creates direct descendants exclusively with mode0700 and admits the published directories', () => {
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const admission = admitTree();
    admission.verify();
    expect(mkdir.mock.calls.map(args => args[0])).toEqual([userdata, container, anchor, home]);
    for (const args of mkdir.mock.calls) expect(args[1]).toEqual({ mode: 0o700 });
    for (const directory of [userdata, container, anchor, home]) expect(fs.lstatSync(directory).isDirectory()).toBe(true);
  });

  it.each(['missing', 'file'] as const)('does not recreate a %s workspace', kind => {
    const workspace = path.join(root, 'workspace');
    if (kind === 'file') fs.writeFileSync(workspace, 'occupied');
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    expect(() => new RuntimeDirectoryAdmission(workspace)).toThrow(expect.objectContaining(denied));
    expect(mkdir).not.toHaveBeenCalled();
    if (kind === 'file') expect(fs.readFileSync(workspace, 'utf8')).toBe('occupied');
    else expect(fs.existsSync(workspace)).toBe(false);
  });

  it.each(['root', 'outside', 'unchecked-parent'] as const)('refuses %s as a child admission without creating anything', kind => {
    const admission = new RuntimeDirectoryAdmission(root);
    const candidate = kind === 'root' ? root : kind === 'outside' ? path.join(root, '..', 'unowned-child')
      : path.join(root, 'unchecked-parent', 'child');
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    expect(() => admission.admit(candidate)).toThrow(expect.objectContaining(denied));
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'anchor'] as const)('refuses an actual directory link at the %s', kind => {
    fs.mkdirSync(userdata);
    fs.mkdirSync(container);
    const target = path.join(root, 'link-target');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = kind === 'workspace' ? path.join(root, 'workspace-link') : anchor;
    // Directory junctions do not require Windows symlink privilege. On POSIX
    // Node treats this as a directory symlink. This tests type admission only.
    fs.symlinkSync(target, link, 'junction');
    if (kind === 'workspace') expect(() => new RuntimeDirectoryAdmission(link)).toThrow(expect.objectContaining(denied));
    else expect(() => admitThroughContainer().admit(anchor, true)).toThrow(expect.objectContaining(denied));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(['valid-directory', 'file', 'unsafe-private-mode'] as const)('admits only a safe EEXIST creation winner: %s', winner => {
    fs.mkdirSync(userdata);
    fs.mkdirSync(container);
    if (winner === 'unsafe-private-mode') modelMetadata(new Map([[anchor, { mode: BigInt(0o40777) }]]));
    const admission = admitThroughContainer();
    const mkdir = fs.mkdirSync.bind(fs);
    const spy = jest.spyOn(fs, 'mkdirSync').mockImplementation((...args) => {
      if (String(args[0]) === anchor) {
        if (winner === 'file') fs.writeFileSync(anchor, 'winner-bytes');
        else mkdir(anchor, { mode: winner === 'unsafe-private-mode' ? 0o777 : 0o700 });
        throw Object.assign(new Error('Synthetic exclusive creation race'), { code: 'EEXIST' });
      }
      return mkdir(...args);
    });
    if (winner === 'valid-directory') expect(() => admission.admit(anchor, true)).not.toThrow();
    else expect(() => admission.admit(anchor, true)).toThrow(expect.objectContaining(denied));
    expect(spy).toHaveBeenCalledTimes(1);
    if (winner === 'file') expect(fs.readFileSync(anchor, 'utf8')).toBe('winner-bytes');
  });

  it('denies an invalid just-created publication without repair or deletion', () => {
    fs.mkdirSync(userdata);
    fs.mkdirSync(container);
    const admission = admitThroughContainer();
    const mkdir = fs.mkdirSync.bind(fs);
    jest.spyOn(fs, 'mkdirSync').mockImplementation((...args) => {
      const result = mkdir(...args);
      fs.rmdirSync(anchor);
      fs.writeFileSync(anchor, 'replacement');
      return result;
    });
    expect(() => admission.admit(anchor, true)).toThrow(expect.objectContaining(denied));
    expect(fs.readFileSync(anchor, 'utf8')).toBe('replacement');
  });

  it.each([
    ['workspace', 'owner', 5678], ['userdata', 'owner', 5678], ['container', 'owner', 5678],
    ['anchor', 'owner', 5678], ['home', 'owner', 5678], ['workspace', 'mode', 0o40770],
    ['container', 'mode', 0o40777], ['anchor', 'mode', 0o40755], ['anchor', 'mode', 0o40710],
    ['anchor', 'mode', 0o40705], ['anchor', 'mode', 0o40500], ['home', 'mode', 0o40777],
  ] as const)('denies modeled POSIX %s %s=%i without chmod or recreation', (role, field, value) => {
    seedDirectories();
    const candidate = { workspace: root, userdata, container, anchor, home }[role];
    modelMetadata(new Map([[candidate, field === 'owner' ? { uid: BigInt(value) } : { mode: BigInt(value) }]]));
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const chmod = jest.spyOn(fs, 'chmodSync');
    expect(() => admitTree()).toThrow(expect.objectContaining(denied));
    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
  });

  it('accepts modeled0755 shared containers and protected descendants behind a0700 anchor', () => {
    seedDirectories();
    modelMetadata();
    expect(() => admitTree().verify()).not.toThrow();
  });

  it('uses modeled effective uid, with real uid only as a fallback', () => {
    seedDirectories();
    modelMetadata();
    expect(() => admitTree()).not.toThrow();
    processModel('geteuid', undefined);
    processModel('getuid', () => 1234);
    expect(() => admitTree()).not.toThrow();
  });

  it('denies non-Windows admission when no process uid can be established', () => {
    seedDirectories();
    modelMetadata();
    processModel('geteuid', undefined);
    processModel('getuid', undefined);
    expect(() => admitTree()).toThrow(expect.objectContaining(denied));
  });

  it('does not treat modeled Windows uid/mode fields as owner or DACL privacy proof', () => {
    seedDirectories();
    modelMetadata(new Map([[anchor, { uid: BigInt(9999), mode: BigInt(0o40777) }]]), 'win32');
    expect(() => admitTree().verify()).not.toThrow();
  });

  it.each(['dev', 'ino', 'mode', 'uid', 'gid'] as const)('denies post-admission %s drift', field => {
    seedDirectories();
    const admission = admitTree();
    const lstat = fs.lstatSync.bind(fs);
    jest.spyOn(fs, 'lstatSync').mockImplementation(candidate => {
      const actual = lstat(candidate, { bigint: true });
      return String(candidate) === anchor ? clone(actual, { [field]: actual[field] + BigInt(1) }) : actual;
    });
    expect(() => admission.verify()).toThrow(expect.objectContaining(denied));
  });

  it.each(['dev', 'ino'] as const)('retains BigInt precision for %s collisions above Number precision', field => {
    seedDirectories();
    const collision = BigInt('9007199254740992');
    let changed = false;
    const lstat = fs.lstatSync.bind(fs);
    jest.spyOn(fs, 'lstatSync').mockImplementation(candidate => {
      const actual = lstat(candidate, { bigint: true });
      return String(candidate) === anchor ? clone(actual, { [field]: collision + BigInt(changed ? 1 : 0) }) : actual;
    });
    const admission = admitTree();
    expect(Number(collision)).toBe(Number(collision + BigInt(1)));
    changed = true;
    expect(() => admission.verify()).toThrow(expect.objectContaining(denied));
  });

  it('denies canonical target drift after admission', () => {
    seedDirectories();
    const admission = admitTree();
    const realpath = fs.realpathSync.bind(fs);
    jest.spyOn(fs, 'realpathSync').mockImplementation(candidate => String(candidate) === anchor ? path.join(container, 'different-target') : realpath(candidate));
    expect(() => admission.verify()).toThrow(expect.objectContaining(denied));
  });

  it('refuses a replaced admitted parent before creating its child', () => {
    fs.mkdirSync(userdata);
    fs.mkdirSync(container);
    const admission = admitThroughContainer();
    fs.renameSync(container, path.join(userdata, 'original-container'));
    fs.mkdirSync(container);
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    expect(() => admission.admit(anchor, true)).toThrow(expect.objectContaining(denied));
    expect(mkdir).not.toHaveBeenCalled();
    expect(fs.existsSync(anchor)).toBe(false);
  });

  it('denies parent replacement during creation at the publication recheck', () => {
    fs.mkdirSync(userdata);
    fs.mkdirSync(container);
    const admission = admitThroughContainer();
    const mkdir = fs.mkdirSync.bind(fs);
    jest.spyOn(fs, 'mkdirSync').mockImplementation((...args) => {
      const result = mkdir(...args);
      fs.renameSync(container, path.join(userdata, 'original-container'));
      mkdir(container);
      mkdir(anchor, { mode: 0o700 });
      return result;
    });
    expect(() => admission.admit(anchor, true)).toThrow(expect.objectContaining(denied));
    expect(fs.existsSync(path.join(userdata, 'original-container', legacyServerKey))).toBe(true);
  });

  it('allows actual child creation to change directory timestamps, size and link count', () => {
    seedDirectories();
    const admission = admitTree();
    fs.mkdirSync(path.join(home, 'child'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'child', 'cache'), 'new-cache');
    expect(() => admission.verify()).not.toThrow();
  });

  it('redacts native paths, ownership values and error material', () => {
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    jest.spyOn(fs, 'lstatSync').mockImplementation(() => { throw new Error(`${root} uid=1234 TOKEN_CANARY`); });
    expect(() => new RuntimeDirectoryAdmission(root)).toThrow(expect.objectContaining(denied));
    expect(() => new RuntimeDirectoryAdmission(root)).not.toThrow(/TOKEN_CANARY|uid=|flujo-runtime-admission/);
    expect(mkdir).not.toHaveBeenCalled();
  });

  const config = (): MCPStdioConfig => approved!.config;
  async function workspaceFixture(runtimeHome: 'host' | 'isolated' = 'isolated'): Promise<string> {
    approved = installTrustedHostProfile({ name: 'same/user-controlled-server', runtimeHome,
      args: ['-y', '@example/fixture'], environment: { HOME: '/old-host-home', XDG_CONFIG_HOME: '/old-host-config' } });
    process.env.FLUJO_PARENT_DATA_DIR = process.env.FLUJO_DATA_DIR;
    await ensureWorkspaceDirs();
    // The privileged profile explicitly grants its workspace context values;
    // they are not inherited implicitly from the parent account.
    approved.config.env.FLUJO_DATA_DIR = getWorkspaceDataDir();
    approved.config.env.FLUJO_PARENT_DATA_DIR = process.env.FLUJO_PARENT_DATA_DIR!;
    const policy = trustedHostMcpPolicySchema.parse(approved.config.trustedHost);
    approved.config.trustedHost = { ...policy, environmentNames: [...policy.environmentNames, 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR'] };
    approved.approve();
    return getWorkspaceDataDir();
  }

  it('preserves legacy launch directory/env identities and sibling clone markers without spawning', async () => {
    const workspace = await workspaceFixture();
    const runtimeContainer = path.join(workspace, 'userdata', 'mcp-runtime');
    const markers = path.join(runtimeContainer, 'clone-preparation');
    fs.mkdirSync(markers, { recursive: true, mode: 0o755 });
    const marker = path.join(markers, 'recipe.json');
    fs.writeFileSync(marker, 'marker-identity');
    const launch = resolveStdioLaunch(config(), { isolateRuntimeHome: true });
    const legacyRoot = path.join(runtimeContainer, legacyServerKey);
    // Fixed approved entries keep their consented source cwd; the home identity
    // and sibling clone markers remain the existing server-name identity.
    expect(launch.cwd).toBe(config().cwd);
    expect(launch.env.HOME).toBe(path.join(legacyRoot, 'home'));
    expect(launch.env.USERPROFILE).toBe(launch.env.HOME);
    expect(launch.env.XDG_CONFIG_HOME).toBe(path.join(launch.env.HOME, '.config'));
    expect(launch.env.NPM_CONFIG_CACHE).toBe(path.join(launch.env.HOME, '.npm'));
    expect(launch.env.TMP).toBe(path.join(launch.env.HOME, 'tmp'));
    expect(launch.env.FLUJO_DATA_DIR).toBe(workspace);
    expect(launch.env.FLUJO_PARENT_DATA_DIR).toBe(process.env.FLUJO_PARENT_DATA_DIR);
    expect(launch.command).toBeTruthy();
    expect(launch.args).toEqual(config().args);
    const again = resolveStdioLaunch(config(), { isolateRuntimeHome: true });
    expect(again).toEqual(launch);
    expect(fs.readFileSync(marker, 'utf8')).toBe('marker-identity');
  });

  it('denies an unsafe launch anchor without host fallback or replacing occupied content', async () => {
    const workspace = await workspaceFixture();
    const runtimeContainer = path.join(workspace, 'userdata', 'mcp-runtime');
    fs.mkdirSync(runtimeContainer);
    const occupied = path.join(runtimeContainer, legacyServerKey);
    fs.writeFileSync(occupied, 'occupied-anchor');
    expect(() => resolveStdioLaunch(config(), { isolateRuntimeHome: true })).toThrow(expect.objectContaining(denied));
    expect(fs.readFileSync(occupied, 'utf8')).toBe('occupied-anchor');
  });

  it('keeps an opted-out launch independent of a denied isolated-runtime anchor', async () => {
    const workspace = await workspaceFixture('host');
    const runtimeContainer = path.join(workspace, 'userdata', 'mcp-runtime');
    fs.mkdirSync(runtimeContainer);
    const occupied = path.join(runtimeContainer, legacyServerKey);
    fs.writeFileSync(occupied, 'occupied-anchor');
    const launch = resolveStdioLaunch(config(), { isolateRuntimeHome: false });
    expect(launch.env.HOME).toBe(config().env.HOME);
    expect(fs.readFileSync(occupied, 'utf8')).toBe('occupied-anchor');
  });

  it('refuses a legacy dynamic package runner without a private execution grant', async () => {
    await workspaceFixture();
    expect(() => resolveStdioLaunch({ ...config(), command: 'npx', args: ['-y', '@example/fixture'], trustedHost: undefined },
      { isolateRuntimeHome: true })).toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { resolveTrustedHostLaunch } from '@/backend/services/mcp/trustedHost';
import { getCurrentWorkspace, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import {
  assertTrustedHostMcpAllowed, fingerprintTrustedHostExecutable, readPrivateApprovalSet, readPrivateApprovalSetAsync,
  fingerprintTrustedHostSource, trustedHostMcpPolicyDigest, trustedHostMcpPolicySchema, verifyTrustedHostMcp,
} from '@/backend/services/security/trustedHostMcp';

let root: string;
let fixtureParent: string;
let config: MCPStdioConfig;
let saved: Record<string, string | undefined>;
let approval: { schemaVersion: number; ownerId: string; approvals: Array<{ workspace: string; serverName: string; policyDigest: string; expiresAt: number }> };

function persist() {
  fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify(approval), { mode: 0o600 });
}

beforeEach(() => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE'].map(name => [name, process.env[name]]));
  // Windows authority is checked against the native DACL, including parents.
  // Use the existing private user tree; chmod does not make a public temp tree private.
  const privateParent = process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir();
  if (!privateParent || !path.isAbsolute(privateParent)) throw new Error('Private fixture parent unavailable');
  fixtureParent = path.resolve(privateParent);
  root = fs.mkdtempSync(path.join(fixtureParent, 'flujo-host-consent-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(root, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(root, 'consent.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [] }), { mode: 0o600 });
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'fixed-package');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const executable = path.join(sourceRoot, 'synthetic-executable');
  fs.writeFileSync(executable, 'fingerprinted fixture; never executed');
  fs.writeFileSync(path.join(sourceRoot, 'server.js'), 'synthetic package source');
  config = { name: 'synthetic-host', transport: 'stdio', command: executable, args: [], cwd: sourceRoot,
    disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '',
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native', entryPoint: executable, sourceRoot,
      sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(executable), environmentNames: [] } };
  approval = { schemaVersion: 1, ownerId: 'synthetic-owner', approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name,
    policyDigest: trustedHostMcpPolicyDigest(config), expiresAt: Date.now() + 60_000 }] };
  persist();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const relative = path.relative(fixtureParent, root);
  if (!/^flujo-host-consent-[A-Za-z0-9]+$/.test(relative) || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe owned fixture cleanup');
  fs.rmSync(root, { recursive: true, force: true });
});

it('requires a separate grant and accepts the matching explicit package revision', () => {
  expect(assertTrustedHostMcpAllowed(config).kind).toBe('trusted-host');
  delete process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
  expect(() => assertTrustedHostMcpAllowed({ ...config, trustedHost: undefined })).toThrow('explicit owner consent');
});

it('overlaps eight actual sibling reads while preserving the synchronous ordered package digest', async () => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  for (let index = 0; index < 24; index++) {
    fs.writeFileSync(path.join(policy.sourceRoot, `a-${String(index).padStart(2, '0')}.js`), `source member ${index}`);
  }
  const nested = path.join(policy.sourceRoot, 'm-nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'child.js'), 'nested member');
  config.trustedHost = { ...policy, sourceDigest: fingerprintTrustedHostSource(policy.sourceRoot) };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(config);
  persist();
  const open = fs.promises.open.bind(fs.promises);
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  let readers = 0, closed = 0;
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (/^a-0[0-7]\.js$/.test(path.basename(String(args[0])))) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      let first = true;
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        if (first) { first = false; if (++readers === 8) entered(); await finish; }
        return read(...readArgs);
      }) as typeof handle.read;
      handle.close = async () => { await close(); closed++; };
    }
    return handle;
  });
  const verification = verifyTrustedHostMcp(config);
  const outcome = verification.then(value => ({ value }), error => ({ error }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([checking, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Sibling reads remained serial.')), 30_000);
    })]);
    expect(readers).toBe(8);
    release();
    expect(await outcome).toHaveProperty('value');
    expect(closed).toBe(8);
  } finally { clearTimeout(timer); release(); await outcome; spy.mockRestore(); }
}, 120_000);

it.each(['sync', 'async'] as const)('fresh %s private sets reject mutation of another member during a genuine held read', async mode => {
  const first = path.join(root, 'set-first.json'), second = path.join(root, 'set-second.json');
  fs.writeFileSync(first, '{"value":"first"}', { mode: 0o600 });
  fs.writeFileSync(second, '{"value":"second"}', { mode: 0o600 });
  const members = [process.env.FLUJO_OWNER_AUTH_FILE!, process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, first, second];
  expect(mode === 'sync' ? readPrivateApprovalSet(members) : await readPrivateApprovalSetAsync(members)).toHaveLength(4);
  const expected = fs.lstatSync(first, { bigint: true });
  const actual = fs.readSync;
  let changed = false;
  const read = jest.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(actual, fs, args) as number;
    if (!changed) {
      const current = fs.fstatSync(args[0], { bigint: true });
      if (current.dev === expected.dev && current.ino === expected.ino) {
        changed = true; fs.writeFileSync(second, '{"value":"changed-during-other-held-read"}');
      }
    }
    return count;
  });
  try {
    if (mode === 'sync') expect(() => readPrivateApprovalSet(members)).toThrow();
    else await expect(readPrivateApprovalSetAsync(members)).rejects.toThrow();
    expect(changed).toBe(true);
  } finally { read.mockRestore(); }
});

it('bounded private sets refuse duplicate, relative and pre-aborted inputs', async () => {
  const file = process.env.FLUJO_OWNER_AUTH_FILE!;
  const abort = new AbortController(); abort.abort();
  for (const members of [[], [file, file], ['relative.json'], [file, file, file, file, file]]) {
    expect(() => readPrivateApprovalSet(members)).toThrow();
    await expect(readPrivateApprovalSetAsync(members)).rejects.toThrow();
  }
  expect(() => readPrivateApprovalSet([file], abort.signal)).toThrow();
  await expect(readPrivateApprovalSetAsync([file], abort.signal)).rejects.toThrow();
});

it.each(['inherited', 'field-accessor', 'map-accessor'])('refuses %s environment values without invoking getters', kind => {
  const getter = jest.fn(() => 'secret');
  const raw = kind === 'inherited' ? Object.create({ get value() { return getter(); } })
    : Object.defineProperty({}, 'value', { get: getter, enumerable: true });
  const env = kind === 'map-accessor' ? Object.defineProperty({}, 'SAFE', { get: getter, enumerable: true }) : { SAFE: raw };
  config.env = env;
  config.trustedHost = { ...trustedHostMcpPolicySchema.parse(config.trustedHost), environmentNames: ['SAFE'] };
  expect(() => trustedHostMcpPolicyDigest(config)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('preserves an explicitly approved own prototype-named environment value', () => {
  config.env = Object.fromEntries([['__proto__', 'literal'], ...(process.platform === 'win32' ? [['SystemRoot', process.env.SystemRoot!]] : [])]);
  config.trustedHost = { ...trustedHostMcpPolicySchema.parse(config.trustedHost), environmentNames: Object.keys(config.env) };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(config);
  persist();
  const environment = resolveTrustedHostLaunch(config).env;
  expect(Object.getPrototypeOf(environment)).toBeNull();
  expect(Object.getOwnPropertyDescriptor(environment, '__proto__')?.value).toBe('literal');
});

it.each(['owner', 'server', 'workspace', 'expiry', 'revocation'])('refuses a %s mismatch', mismatch => {
  if (mismatch === 'owner') approval.ownerId = 'different-owner';
  if (mismatch === 'server') approval.approvals[0].serverName = 'different-server';
  if (mismatch === 'workspace') approval.approvals[0].workspace = 'different-workspace';
  if (mismatch === 'expiry') approval.approvals[0].expiresAt = Date.now() - 1;
  if (mismatch === 'revocation') approval.approvals = [];
  persist();
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
});

it('requires re-consent for changed package bytes, including a nested dependency', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  fs.mkdirSync(path.join(policy.sourceRoot, 'dependencies'));
  fs.writeFileSync(path.join(policy.sourceRoot, 'dependencies', 'changed.js'), 'new dependency revision');
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('package revision changed');
});

it('refuses executable replacement even when the remaining package is unchanged', () => {
  fs.writeFileSync(config.command, 'different executable revision');
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('package revision changed');
});

it.each([
  { args: ['different-argument'] }, { enableMcpApps: true }, { enableMcpSkills: true },
  { sampling: { enabled: true } }, { roots: ['different-root'] },
])('binds actual requested launch and broker capabilities (%j)', change => {
  expect(() => assertTrustedHostMcpAllowed({ ...config, ...change })).toThrow('explicit owner consent');
});

it('an imported approval flag cannot convey authority', () => {
  const forged = { ...(config.trustedHost as object), approved: true };
  expect(() => assertTrustedHostMcpAllowed({ ...config, trustedHost: forged })).toThrow();
});

it('refuses a source hard link without reading unrelated file contents', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'synthetic outside canary');
  fs.linkSync(outside, path.join(policy.sourceRoot, 'linked.txt'));
  expect(() => fingerprintTrustedHostSource(policy.sourceRoot)).toThrow('package revision changed');
});

it('refuses a junction or symbolic link in the package tree', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(policy.sourceRoot, 'linked-directory'), 'junction');
  expect(() => fingerprintTrustedHostSource(policy.sourceRoot)).toThrow('package revision changed');
});

it('refuses approval stored alongside workspace data', () => {
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(getWorkspaceDataDir(), 'consent.json');
  persist();
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
});

it('does not grant a different workspace the same server/package consent', async () => {
  await runWithWorkspace('foreign-workspace', async () => {
    expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
  });
});

it('refuses unresolved executable paths and leaves caller values out of errors', () => {
  expect(() => assertTrustedHostMcpAllowed({ ...config, command: 'npx' })).toThrow('policy is invalid');
  fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, 'synthetic-private-malformed-canary');
  let message = '';
  try { assertTrustedHostMcpAllowed(config); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('explicit owner consent');
  expect(message).not.toContain('synthetic-private-malformed-canary');
});


it('binds configured environment values and refuses loader injection', () => {
  const configured = { ...config, env: { STATIC_VALUE: 'approved' }, trustedHost: { ...(config.trustedHost as object), environmentNames: ['STATIC_VALUE'] } };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(configured);
  persist();
  expect(assertTrustedHostMcpAllowed(configured).kind).toBe('trusted-host');
  expect(() => assertTrustedHostMcpAllowed({ ...configured, env: { STATIC_VALUE: 'changed' } })).toThrow('explicit owner consent');
  expect(() => trustedHostMcpPolicyDigest({ ...config, trustedHost: { ...(config.trustedHost as object), environmentNames: ['NODE_OPTIONS'] }, env: { NODE_OPTIONS: '--require=/outside.js' } })).toThrow('policy is invalid');
});

it('refuses a node entry point outside the fingerprinted package and dynamic runner executables', () => {
  const nodePolicy = { ...(config.trustedHost as object), runtime: 'node', entryPoint: path.join(root, 'outside.js') };
  expect(() => trustedHostMcpPolicyDigest({ ...config, command: process.execPath, args: [nodePolicy.entryPoint], trustedHost: nodePolicy })).toThrow('policy is invalid');
  expect(() => trustedHostMcpPolicyDigest({ ...config, command: path.join(path.dirname(config.command), 'npx'), trustedHost: { ...(config.trustedHost as object), entryPoint: path.join(path.dirname(config.command), 'npx') } })).toThrow('policy is invalid');
});

it('fresh large-file verification accepts exact bytes and refuses mutation after an actual held read', async () => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  fs.writeFileSync(config.command, Buffer.alloc(2 * 1024 * 1024 + 17, 0x61));
  config.trustedHost = { ...policy, sourceDigest: fingerprintTrustedHostSource(policy.sourceRoot),
    executableDigest: fingerprintTrustedHostExecutable(config.command) };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(config); persist();
  await expect(verifyTrustedHostMcp(config)).resolves.toMatchObject({ ownerId: approval.ownerId });
  const open = fs.promises.open.bind(fs.promises);
  let mutated = false, opened = 0, closed = 0;
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === config.command) {
      opened++;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        if (result.bytesRead && !mutated) {
          mutated = true;
          fs.writeFileSync(config.command, Buffer.alloc(2 * 1024 * 1024 + 17, 0x62));
        }
        return result;
      }) as typeof handle.read;
      handle.close = async () => { await close(); closed++; };
    }
    return handle;
  });
  try {
    await expect(verifyTrustedHostMcp(config)).rejects.toThrow('package revision changed');
    expect(mutated).toBe(true); expect(opened).toBeGreaterThan(0); expect(closed).toBe(opened);
  } finally { spy.mockRestore(); }
  fs.writeFileSync(config.command, Buffer.alloc(2 * 1024 * 1024 + 17, 0x61));
  const cancellation = new AbortController();
  let aborted = false;
  opened = 0; closed = 0;
  const abortSpy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === config.command) {
      opened++;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        if (result.bytesRead && !aborted) { aborted = true; cancellation.abort(new Error('Actual large-file read cancellation.')); }
        return result;
      }) as typeof handle.read;
      handle.close = async () => { await close(); closed++; };
    }
    return handle;
  });
  try {
    await expect(verifyTrustedHostMcp(config, cancellation.signal)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
    expect(aborted).toBe(true); expect(opened).toBeGreaterThan(0); expect(closed).toBe(opened);
  } finally { abortSpy.mockRestore(); }
});

it('async verification yields and refuses an approval revoked while filesystem verification is pending', async () => {
  const open = fs.promises.open.bind(fs.promises);
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === config.command) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => { entered(); await finish; return read(...readArgs); }) as typeof handle.read;
    }
    return handle;
  });
  const verification = verifyTrustedHostMcp(config);
  const rejected = expect(verification).rejects.toThrow('explicit owner consent');
  await checking;
  approval.approvals = [];
  persist();
  release();
  await rejected;
  spy.mockRestore();
});

it('an executable read refusal drains the pending actual source descriptor before returning', async () => {
  const open = fs.promises.open.bind(fs.promises);
  const sourceFile = path.join(trustedHostMcpPolicySchema.parse(config.trustedHost).sourceRoot, 'server.js');
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  let sourceClosed = false;
  let executableReadAttempted = false;
  let executableClosed = false;
  let closedExecutable!: () => void;
  const executableFinished = new Promise<void>(resolve => { closedExecutable = resolve; });
  let settled = false;
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const filename = String(args[0]);
    if (filename === config.command) {
      const close = handle.close.bind(handle);
      handle.read = (async () => {
        executableReadAttempted = true;
        throw new Error('actual executable read refused');
      }) as typeof handle.read;
      handle.close = async () => { await close(); executableClosed = true; closedExecutable(); };
    } else if (filename === sourceFile) {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        entered(); await finish; return read(...readArgs);
      }) as typeof handle.read;
      handle.close = async () => { await close(); sourceClosed = true; };
    }
    return handle;
  });
  const verification = verifyTrustedHostMcp(config);
  const outcome = verification.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await checking;
    await executableFinished;
    // Let the executable rejection propagate after its real descriptor closes,
    // while the separately opened source descriptor remains deliberately held.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(executableReadAttempted).toBe(true);
    expect(executableClosed).toBe(true);
    expect(settled).toBe(false);
    expect(sourceClosed).toBe(false);
    release();
    expect((await outcome).message).toContain('package revision changed');
    expect(sourceClosed).toBe(true);
    expect(executableClosed).toBe(true);
  } finally {
    release();
    await outcome;
    spy.mockRestore();
  }
});

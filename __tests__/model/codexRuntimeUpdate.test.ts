import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const mockRun = jest.fn();
let mockWorkspace: string;
let mockBundled: string;
jest.mock('node:child_process', () => ({ execFile: Object.assign(jest.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => mockRun(...args),
}) }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockWorkspace }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('@/backend/services/model/adapters/codexRestrictedProfile', () => ({
  bundledCodexExecutable: (root?: string) => root ? require('node:path').join(root, 'codex') : mockBundled,
}));
jest.mock('node:module', () => ({ ...jest.requireActual('node:module'),
  findPackageJSON: () => require('node:path').join(mockWorkspace, 'sdk-package.json'),
}));
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess'),
  startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn(),
}));
import { resolveOrdinaryCodexExecutable, acquireOrdinaryCodexExecutable, qualifyCodexUpdate, readCodexRuntimeCompatibility } from '@/backend/services/model/adapters/codexRuntimeUpdate';
import { startOwnedCodexAppServer, CodexAppServerRpcError } from '@/backend/services/model/adapters/codexAppServerProcess';
import { CODEX_APP_SERVER_CONTRACT } from '@/backend/services/model/adapters/codexProtocol';

let request: jest.Mock, stop: jest.Mock, fetchMock: jest.SpyInstance;
beforeEach(async () => {
  jest.clearAllMocks();
  mockWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-update-test-'));
  mockBundled = path.join(mockWorkspace, 'bundled');
  await fs.writeFile(mockBundled, 'old-cli');
  await sdkVersion('0.162.1');
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ version: '0.163.0' }) } as Response);
  mockRun.mockImplementation(async (file, args, options) => {
    if (args[0] === '--version') return { stdout: `codex-cli ${file === mockBundled ? '0.162.1' : '0.163.0'}\n` };
    if (args[0] === 'exec') return { stdout: 'Usage: codex exec [OPTIONS] [COMMAND]\n' };
    await fs.writeFile(path.join(options.cwd, 'codex'), 'new-cli');
    return { stdout: '', stderr: '' };
  });
  request = jest.fn(async (method, params) => {
    if (method === 'model/list' && typeof params.limit === 'string') throw new CodexAppServerRpcError(-32600);
    return method === 'model/list' ? { data: [{ model: 'future-model' }], nextCursor: null } : {};
  });
  stop = jest.fn(async () => {});
  jest.mocked(startOwnedCodexAppServer).mockResolvedValue({ request, notify: jest.fn(), stop } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>);
});

async function sdkVersion(version: string) {
  await fs.writeFile(path.join(mockWorkspace, 'sdk-package.json'), JSON.stringify({ name: '@openai/codex-sdk', version }));
}

async function existingReceipt(compatibility?: Record<string, string>) {
  const root = path.join(mockWorkspace, 'db/codex-cli');
  const directory = 'release-0.163.0-existing';
  await fs.mkdir(path.join(root, directory), { recursive: true, mode: 0o700 });
  const executable = path.join(root, directory, 'codex');
  await fs.writeFile(executable, 'new-cli');
  const receipt = { version: '0.163.0', directory, sha256: createHash('sha256').update('new-cli').digest('hex'),
    ...(compatibility ? { compatibility } : {}) };
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(receipt), { mode: 0o600 });
  return { root, directory, executable, receipt };
}
afterEach(async () => {
  fetchMock.mockRestore();
  if (path.dirname(mockWorkspace) !== os.tmpdir() || !path.basename(mockWorkspace).startsWith('flujo-update-test-')) throw new Error('Unsafe cleanup');
  await fs.rm(mockWorkspace, { recursive: true, force: true });
});

it('keeps calls on the working binary while one background install qualifies, then activates only future calls', async () => {
  const old = await acquireOrdinaryCodexExecutable();
  expect(old.executable).toBe(mockBundled);
  const updated = await resolveOrdinaryCodexExecutable({ waitForUpdate: true });
  expect(updated).not.toBe(mockBundled);
  expect(old.executable).toBe(mockBundled);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const installs = mockRun.mock.calls.filter(([, args]) => args.includes('install'));
  expect(installs).toHaveLength(1);
  expect(installs[0][1]).toEqual(expect.arrayContaining(['@openai/codex@0.163.0', '--ignore-scripts', '--registry=https://registry.npmjs.org']));
  const configArgs = installs[0][1].filter((arg: string) => /^--(?:user|global)config=/.test(arg));
  expect(configArgs).toHaveLength(2);
  expect(configArgs[0].split('=')[1]).not.toBe(configArgs[1].split('=')[1]);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await fs.readFile(path.join(mockWorkspace, 'db/codex-cli/current.json'), 'utf8'))).toMatchObject({ version: '0.163.0',
    compatibility: { cliVersion: '0.163.0', sdkVersion: '0.162.1', protocolContract: CODEX_APP_SERVER_CONTRACT,
      qualificationContract: 'flujo-codex-runtime-qualification-v2' } });
  await old.release();
});

it('retains the working binary and creates no activation receipt after protocol failure', async () => {
  request.mockRejectedValue(new Error('broken protocol'));
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(mockBundled);
  await expect(fs.stat(path.join(mockWorkspace, 'db/codex-cli/current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(stop).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(path.join(mockWorkspace, 'db/codex-cli'))).filter(name => name.startsWith('release-'))).toEqual([]);
});

it('retains the bundled binary without install or replay on registry failure and rejects unstable releases', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(mockBundled);
  expect(mockRun).not.toHaveBeenCalled();
  expect(startOwnedCodexAppServer).not.toHaveBeenCalled();
});

it('refuses to activate a candidate binary linked to another file', async () => {
  const outside = path.join(mockWorkspace, 'outside-binary');
  await fs.writeFile(outside, 'linked-cli');
  const ordinaryRun = mockRun.getMockImplementation()!;
  mockRun.mockImplementation(async (file, args, options) => {
    if (args.includes('install')) {
      await fs.link(outside, path.join(options.cwd, 'codex'));
      return { stdout: '', stderr: '' };
    }
    return ordinaryRun(file, args, options);
  });
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(mockBundled);
  await expect(fs.stat(path.join(mockWorkspace, 'db/codex-cli/current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(outside, 'utf8')).toBe('linked-cli');
  expect(stop).toHaveBeenCalledTimes(1);
});

it('uses the installed SDK and selected CLI identities for session compatibility', async () => {
  expect(await readCodexRuntimeCompatibility(mockBundled)).toEqual({ cliVersion: '0.162.1', sdkVersion: '0.162.1',
    protocolContract: CODEX_APP_SERVER_CONTRACT });
});

it('qualifies every catalogue page and parses actual SDK start and resume options without a turn', async () => {
  const ordinaryRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method !== 'model/list' || typeof params.limit === 'string') return ordinaryRequest(method, params);
    return params.cursor ? { data: [{ model: 'second-page-model' }], nextCursor: null }
      : { data: [{ model: 'first-page-model' }], nextCursor: 'second' };
  });
  await qualifyCodexUpdate(mockBundled, mockWorkspace);
  expect(request.mock.calls.filter(([method, params]) => method === 'model/list' && typeof params.limit === 'number'))
    .toEqual([['model/list', { limit: 100, includeHidden: false }, 10000], ['model/list', { limit: 100, includeHidden: false, cursor: 'second' }, 10000]]);
  expect(request.mock.calls.every(([method]) => ['initialize', 'model/list'].includes(method))).toBe(true);
  const probes = mockRun.mock.calls.filter(([, args]) => args[0] === 'exec');
  expect(probes).toHaveLength(2);
  for (const [, args, options] of probes) {
    expect(args).toEqual(expect.arrayContaining(['--experimental-json', '--sandbox', '--cd', '--add-dir', '--image',
      '--output-schema', '--cyber-access-program', '--config', '--skip-git-repo-check', '--help']));
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_HOME).toBe(mockWorkspace);
  }
  expect(probes[0][1]).toContain('--thread-source');
  expect(probes[1][1]).toContain('resume');
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each(['cycle', 'oversize-page', 'oversize-total', 'empty-pages', 'malformed-cursor', 'malformed-row'])
  ('rejects %s catalogue qualification and drains its owned child', async mode => {
    let pages = 0;
    const ordinaryRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method !== 'model/list' || typeof params.limit === 'string') return ordinaryRequest(method, params);
      const nextCursor = mode === 'cycle' ? 'same-cursor' : mode === 'malformed-cursor' ? '' : `page-${++pages}`;
      return { data: mode === 'empty-pages' ? [] : mode === 'oversize-page' ? Array(101).fill({ model: 'm' })
        : mode === 'oversize-total' ? Array(100).fill({ model: 'm' }) : mode === 'malformed-row' ? [{ model: '' }] : [{ model: 'm' }], nextCursor };
    });
    await expect(qualifyCodexUpdate(mockBundled, mockWorkspace)).rejects.toThrow(/Codex model/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([method]) => method === 'model/list').length).toBeLessThanOrEqual(32);
  });

it.each([undefined, new Error('malformed error framing'), new CodexAppServerRpcError(-32001)])
  ('requires a typed invalid-parameter rejection, not timeout, success or another error', async error => {
    const ordinaryRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === 'model/list' && typeof params.limit === 'string') {
        if (error) throw error;
        return {};
      }
      return ordinaryRequest(method, params);
    });
    await expect(qualifyCodexUpdate(mockBundled, mockWorkspace)).rejects.toThrow('JSON-RPC error protocol changed');
    expect(stop).toHaveBeenCalledTimes(1);
  });

it('rejects a CLI whose SDK resume argument parsing fails without activating or replaying a turn', async () => {
  const ordinaryRun = mockRun.getMockImplementation()!;
  mockRun.mockImplementation(async (file, args, options) => {
    if (args.includes('resume')) throw new Error('unsupported SDK flag');
    return ordinaryRun(file, args, options);
  });
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(mockBundled);
  await expect(fs.stat(path.join(mockWorkspace, 'db/codex-cli/current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(request.mock.calls.every(([method]) => ['initialize', 'model/list'].includes(method))).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});

it('requalifies a legacy receipt before admission, preserving its binary digest and version without reinstalling', async () => {
  const { root, executable, receipt } = await existingReceipt();
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(executable);
  const admitted = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
  expect(admitted).toMatchObject({ ...receipt, compatibility: { sdkVersion: '0.162.1', cliVersion: receipt.version,
    protocolContract: CODEX_APP_SERVER_CONTRACT, qualificationContract: 'flujo-codex-runtime-qualification-v2' } });
  expect(mockRun.mock.calls.filter(([, args]) => args.includes('install'))).toHaveLength(0);
  expect(stop).toHaveBeenCalledTimes(1);
  await resolveOrdinaryCodexExecutable();
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each(['sdk', 'protocol', 'qualification'])('requalifies receipt admission after a %s contract changes', async kind => {
  const { root, executable } = await existingReceipt({ cliVersion: '0.163.0', sdkVersion: '0.162.1',
    protocolContract: CODEX_APP_SERVER_CONTRACT, qualificationContract: 'flujo-codex-runtime-qualification-v2' });
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(executable);
  expect(stop).not.toHaveBeenCalled();
  if (kind === 'sdk') await sdkVersion('0.164.0');
  else {
    const receipt = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    receipt.compatibility[kind === 'protocol' ? 'protocolContract' : 'qualificationContract'] = 'old-contract';
    await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(receipt));
  }
  expect(await resolveOrdinaryCodexExecutable()).toBe(executable);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mockRun.mock.calls.filter(([, args]) => args.includes('install'))).toHaveLength(0);
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
  expect(receipt.compatibility.sdkVersion).toBe(kind === 'sdk' ? '0.164.0' : '0.162.1');
});

it('falls back after failed SDK requalification, retains active leases, and backs off without installation or replay', async () => {
  const { root, executable } = await existingReceipt({ cliVersion: '0.163.0', sdkVersion: '0.162.1',
    protocolContract: CODEX_APP_SERVER_CONTRACT, qualificationContract: 'flujo-codex-runtime-qualification-v2' });
  const active = await acquireOrdinaryCodexExecutable();
  await resolveOrdinaryCodexExecutable({ waitForUpdate: true });
  expect(active.executable).toBe(executable);
  await sdkVersion('0.164.0');
  request.mockRejectedValue(new Error('incompatible protocol'));
  expect(await resolveOrdinaryCodexExecutable()).toBe(mockBundled);
  expect(await resolveOrdinaryCodexExecutable()).toBe(mockBundled);
  expect(active.executable).toBe(executable);
  expect(stop).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(root)).filter(name => name.startsWith('lease-'))).toHaveLength(1);
  expect(mockRun.mock.calls.filter(([, args]) => args.includes('install'))).toHaveLength(0);
  await active.release();
  expect((await fs.readdir(root)).filter(name => name.startsWith('lease-'))).toHaveLength(0);
});

it.each([false, true])('does not reinstall a rejected receipt but still discovers a newer compatible CLI: newer=%s', async newer => {
  const { executable } = await existingReceipt({ cliVersion: '0.163.0', sdkVersion: '0.161.9',
    protocolContract: CODEX_APP_SERVER_CONTRACT, qualificationContract: 'flujo-codex-runtime-qualification-v2' });
  request.mockRejectedValueOnce(new Error('stale receipt is incompatible'));
  const ordinaryRun = mockRun.getMockImplementation()!;
  mockRun.mockImplementation(async (file, args, options) => {
    if (args[0] === '--version' && file.includes('release-0.164.0-')) return { stdout: 'codex-cli 0.164.0\n' };
    return ordinaryRun(file, args, options);
  });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: newer ? '0.164.0' : '0.163.0' }) } as Response);
  const result = await resolveOrdinaryCodexExecutable({ waitForUpdate: true });
  expect(result).not.toBe(executable);
  const installs = mockRun.mock.calls.filter(([, args]) => args.includes('install'));
  if (newer) {
    expect(result).toContain('release-0.164.0-');
    expect(installs).toHaveLength(1);
    expect(installs[0][1]).toContain('@openai/codex@0.164.0');
  } else {
    expect(result).toBe(mockBundled);
    expect(installs).toHaveLength(0);
  }
});

it('refuses a changed digest even when a receipt was previously admitted in this process', async () => {
  const { root, executable } = await existingReceipt({ cliVersion: '0.163.0', sdkVersion: '0.162.1',
    protocolContract: CODEX_APP_SERVER_CONTRACT, qualificationContract: 'flujo-codex-runtime-qualification-v2' });
  expect(await resolveOrdinaryCodexExecutable({ waitForUpdate: true })).toBe(executable);
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
  receipt.sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(receipt));
  expect(await resolveOrdinaryCodexExecutable()).toBe(mockBundled);
});

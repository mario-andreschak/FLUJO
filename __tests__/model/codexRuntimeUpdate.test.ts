import { promises as fs } from 'node:fs';
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
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({ startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn() }));
import { resolveOrdinaryCodexExecutable, acquireOrdinaryCodexExecutable } from '@/backend/services/model/adapters/codexRuntimeUpdate';
import { startOwnedCodexAppServer } from '@/backend/services/model/adapters/codexAppServerProcess';

let request: jest.Mock, stop: jest.Mock, fetchMock: jest.SpyInstance;
beforeEach(async () => {
  jest.clearAllMocks();
  mockWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-update-test-'));
  mockBundled = path.join(mockWorkspace, 'bundled');
  await fs.writeFile(mockBundled, 'old-cli');
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ version: '0.163.0' }) } as Response);
  mockRun.mockImplementation(async (file, args, options) => {
    if (args[0] === '--version') return { stdout: `codex-cli ${file === mockBundled ? '0.162.1' : '0.163.0'}\n` };
    if (args[0] === 'exec') return { stdout: '--json --model --skip-git-repo-check --config' };
    await fs.writeFile(path.join(options.cwd, 'codex'), 'new-cli');
    return { stdout: '', stderr: '' };
  });
  request = jest.fn(async method => method === 'model/list' ? { data: [{ model: 'future-model' }] } : {});
  stop = jest.fn(async () => {});
  jest.mocked(startOwnedCodexAppServer).mockResolvedValue({ request, notify: jest.fn(), stop } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>);
});
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
  expect(JSON.parse(await fs.readFile(path.join(mockWorkspace, 'db/codex-cli/current.json'), 'utf8'))).toMatchObject({ version: '0.163.0' });
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

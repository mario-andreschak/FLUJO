import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { PrivateApprovalReadError, readPrivateApprovalSetAsync, type PrivateApprovalFileRole } from '@/backend/services/security/trustedHostMcp';
import { windowsPrivateAuthorityStampAsync } from '@/backend/services/security/windowsPrivateAuthority';

jest.mock('@/backend/services/security/windowsPrivateAuthority', () => ({
  windowsPrivateAuthorityStamp: jest.fn(),
  windowsPrivateAuthorityStampAsync: jest.fn(),
}));
jest.mock('@/utils/paths', () => ({ getDataDir: () => path.resolve('synthetic-data') }));

const secret = 'private-path-token-and-content-canary';
const members = ['record', 'marker', 'owner', 'ledger'].map(role => path.resolve('synthetic-private', secret, `${role}.json`));
const roles: PrivateApprovalFileRole[] = ['record', 'marker', 'owner', 'ledger'];
const contents = Buffer.from(JSON.stringify({ token: secret }));
const identity = {
  dev: BigInt(1), ino: BigInt(2), size: BigInt(contents.length), mtimeNs: BigInt(3), ctimeNs: BigInt(4),
  mode: BigInt(0o600), uid: BigInt(0), gid: BigInt(0), nlink: BigInt(1),
  isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false,
} as BigIntStats;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let savedTrace: string | undefined;
let savedSystemRoot: string | undefined;
let log: jest.SpyInstance;

beforeEach(() => {
  savedTrace = process.env.FLUJO_MCP_WORKLOAD_TRACE;
  savedSystemRoot = process.env.SystemRoot;
  process.env.FLUJO_MCP_WORKLOAD_TRACE = '1';
  process.env.SystemRoot = path.resolve('synthetic-system', secret);
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  jest.mocked(windowsPrivateAuthorityStampAsync).mockReset().mockResolvedValue('synthetic-authority');
  log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(process, 'platform', originalPlatform);
  if (savedTrace === undefined) delete process.env.FLUJO_MCP_WORKLOAD_TRACE;
  else process.env.FLUJO_MCP_WORKLOAD_TRACE = savedTrace;
  if (savedSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = savedSystemRoot;
});

function mockStableContents() {
  let read = false;
  // These readers always request bigint stats; the mocks intentionally cover that overload only.
  jest.spyOn(fs, 'lstatSync').mockImplementation((() => identity) as unknown as typeof fs.lstatSync);
  jest.spyOn(fs, 'fstatSync').mockImplementation((() => identity) as unknown as typeof fs.fstatSync);
  jest.spyOn(fs, 'realpathSync').mockImplementation((filename => String(filename)) as typeof fs.realpathSync);
  jest.spyOn(fs, 'openSync').mockImplementation(() => { read = false; return 42; });
  jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
  jest.spyOn(fs, 'readSync').mockImplementation(((_fd: number, buffer: Buffer) => {
    if (read) return 0;
    read = true; contents.copy(buffer); return contents.length;
  }) as typeof fs.readSync);
}

function expectSafeTrace(expected: Record<string, unknown>) {
  expect(log).toHaveBeenCalledWith('[private-approval-set-reader]', 'refused', expect.objectContaining({
    ...expected, elapsedMs: expect.any(Number),
  }));
  const serialized = JSON.stringify(log.mock.calls);
  expect(serialized).not.toContain(secret);
  for (const member of members) expect(serialized).not.toContain(member);
}

function expectPlainRefusal(error: unknown) {
  expect(error).toBeInstanceOf(PrivateApprovalReadError);
  const message = (error as Error).message;
  expect(message).not.toContain(secret);
  for (const member of members) expect(message).not.toContain(member);
  return error as PrivateApprovalReadError;
}

it('identifies a missing member without logging the file, contents or original error message', async () => {
  const failure = Object.assign(new Error(secret), { code: 'ENOENT', errno: -4058, path: members[1] });
  jest.spyOn(fs, 'lstatSync').mockImplementation(((filename: fs.PathLike) => {
    if (filename === members[1]) throw failure;
    return identity;
  }) as unknown as typeof fs.lstatSync);
  const refused = expectPlainRefusal(await readPrivateApprovalSetAsync(members, undefined, roles).catch(error => error));
  // A missing file is a fixed answer (for example a revoked token), so it is not retried.
  expect(refused.refusal).toMatchObject({ phase: 'identity-before', role: 'marker', errorKind: 'ENOENT', errno: -4058, attempts: 1 });
  expect(refused.message).toContain('looking up the file for the private marker file: ENOENT (errno -4058)');
  expect(windowsPrivateAuthorityStampAsync).not.toHaveBeenCalled();
  expectSafeTrace({ phase: 'identity-before', role: 'marker', errorKind: 'ENOENT', errno: -4058, cancelled: false });
});

it('keeps an identity change fail closed after both native witnesses, on every attempt', async () => {
  mockStableContents();
  let witnesses = 0;
  jest.mocked(windowsPrivateAuthorityStampAsync).mockImplementation(async () => { witnesses += 1; return 'synthetic-authority'; });
  // The owner file is replaced again right after every second native witness.
  jest.mocked(fs.lstatSync).mockImplementation(((filename: fs.PathLike) =>
    witnesses % 2 === 0 && filename === members[2] ? { ...identity, ino: BigInt(100 + witnesses) } : identity) as unknown as typeof fs.lstatSync);
  const refused = expectPlainRefusal(await readPrivateApprovalSetAsync(members, undefined, roles).catch(error => error));
  expect(refused).toMatchObject({ code: 'HOST_CONSENT_REQUIRED', refusal: { phase: 'identity-after', role: 'owner', attempts: 4 } });
  expect(windowsPrivateAuthorityStampAsync).toHaveBeenCalledTimes(8);
  expect(fs.closeSync).toHaveBeenCalledTimes(16);
  expectSafeTrace({ phase: 'identity-after', role: 'owner', errorKind: 'HOST_CONSENT_REQUIRED', cancelled: false, attempts: 4 });
});

it('reports cancellation at entry before reading a file or starting native inspection', async () => {
  const controller = new AbortController(); controller.abort(new Error(secret));
  const stat = jest.spyOn(fs, 'lstatSync');
  await expect(readPrivateApprovalSetAsync(members, controller.signal, roles)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  expect(stat).not.toHaveBeenCalled();
  expect(windowsPrivateAuthorityStampAsync).not.toHaveBeenCalled();
  expectSafeTrace({ phase: 'input', role: 'set', cancelled: true });
});

it('successful diagnostic reads return the original private values without logging them', async () => {
  mockStableContents();
  await expect(readPrivateApprovalSetAsync(members, undefined, roles)).resolves.toEqual(members.map(() => ({ token: secret })));
  expect(log).not.toHaveBeenCalled();
});

it.each(['disabled', 'throwing-logger'] as const)('refuses the same way with %s diagnostics', async mode => {
  const failure = Object.assign(new Error(secret), { code: 'ENOENT' });
  jest.spyOn(fs, 'lstatSync').mockImplementation(() => { throw failure; });
  if (mode === 'disabled') delete process.env.FLUJO_MCP_WORKLOAD_TRACE;
  else log.mockImplementation(() => { throw new Error('logger failed'); });
  const refused = expectPlainRefusal(await readPrivateApprovalSetAsync(members, undefined, roles).catch(error => error));
  expect(refused).toMatchObject({ code: 'HOST_CONSENT_REQUIRED', refusal: { phase: 'identity-before', role: 'record', errorKind: 'ENOENT', attempts: 1 } });
  expect(log).toHaveBeenCalledTimes(mode === 'disabled' ? 0 : 1);
});

it('bounds caller roles and unknown error codes, without invoking diagnostic accessors', async () => {
  const getter = jest.fn(() => secret);
  const failure = Object.defineProperty(Object.assign(new Error(secret), { code: secret, errno: secret }), 'extra', { get: getter });
  const suppliedRoles = Object.defineProperty([], '0', { get: getter }) as PrivateApprovalFileRole[];
  jest.spyOn(fs, 'lstatSync').mockImplementation(() => { throw failure; });
  const refused = expectPlainRefusal(await readPrivateApprovalSetAsync(members, undefined, suppliedRoles).catch(error => error));
  expect(refused.refusal).toMatchObject({ role: 'member', errorKind: 'unknown', attempts: 1 });
  expect(refused.refusal).not.toHaveProperty('errno');
  expect(getter).not.toHaveBeenCalled();
  expectSafeTrace({ phase: 'identity-before', role: 'member', errorKind: 'unknown', cancelled: false });
  expect(log.mock.calls[0][2]).not.toHaveProperty('errno');
});

it.each(['entry', 'executable-metadata'] as const)('traces native cancellation during %s without spawning a child', async phase => {
  const native = jest.requireActual<typeof import('@/backend/services/security/windowsPrivateAuthority')>(
    '@/backend/services/security/windowsPrivateAuthority');
  const controller = new AbortController();
  const spawn = jest.spyOn(childProcess, 'spawn');
  const stat = jest.spyOn(fs.promises, 'stat').mockImplementation(async () => {
    controller.abort(new Error(secret));
    return { isFile: () => true } as fs.Stats;
  });
  if (phase === 'entry') controller.abort(new Error(secret));
  await expect(native.windowsPrivateAuthorityStampAsync(members, controller.signal)).rejects.toThrow(
    phase === 'entry' ? 'inspection unavailable' : 'inspection cancelled');
  expect(spawn).not.toHaveBeenCalled();
  expect(stat).toHaveBeenCalledTimes(phase === 'entry' ? 0 : 1);
  expect(log).toHaveBeenCalledWith('[private-authority-native]', 'refused', 'abort-before-spawn');
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});

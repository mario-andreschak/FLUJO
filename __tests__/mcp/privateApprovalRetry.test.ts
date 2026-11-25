import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fingerprintTrustedHostExecutableAsync, PrivateApprovalReadError, privateApprovalSetMayClearUp, readPrivateApprovalAsync, readPrivateApprovalPairAsync,
  readPrivateApprovalSetAsync, TrustedHostMcpError, type PrivateApprovalFileRole,
} from '@/backend/services/security/trustedHostMcp';
import { WindowsAuthorityInspectionError, windowsPrivateAuthorityStampAsync } from '@/backend/services/security/windowsPrivateAuthority';

// Issue #1050: a Windows installed run once refused the first MCP resource list
// at the private approval read and never again. These tests inject the
// short-lived Windows conditions that can cause that and require a recovery,
// while a lasting failure still ends in a short, plain refusal.
jest.mock('@/backend/services/security/windowsPrivateAuthority', () => ({
  ...jest.requireActual('@/backend/services/security/windowsPrivateAuthority'),
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
const errno = (code: string, number: number) => Object.assign(new Error(`${code}: ${members[3]}`), { code, errno: number, path: members[3] });

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let savedTrace: string | undefined;
let info: jest.SpyInstance;
let warn: jest.SpyInstance;

beforeEach(() => {
  savedTrace = process.env.FLUJO_MCP_WORKLOAD_TRACE;
  process.env.FLUJO_MCP_WORKLOAD_TRACE = '1';
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  jest.mocked(windowsPrivateAuthorityStampAsync).mockReset().mockResolvedValue('synthetic-authority');
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  let read = false;
  // These readers always request bigint stats; the mocks cover that overload only.
  jest.spyOn(fs, 'lstatSync').mockImplementation((() => identity) as unknown as typeof fs.lstatSync);
  jest.spyOn(fs, 'fstatSync').mockImplementation((() => identity) as unknown as typeof fs.fstatSync);
  jest.spyOn(fs, 'realpathSync').mockImplementation((filename => String(filename)) as typeof fs.realpathSync);
  jest.spyOn(fs, 'openSync').mockImplementation(() => { read = false; return 42; });
  jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
  jest.spyOn(fs, 'readSync').mockImplementation(((_fd: number, buffer: Buffer) => {
    if (read) return 0;
    read = true; contents.copy(buffer); return contents.length;
  }) as typeof fs.readSync);
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(process, 'platform', originalPlatform);
  if (savedTrace === undefined) delete process.env.FLUJO_MCP_WORKLOAD_TRACE;
  else process.env.FLUJO_MCP_WORKLOAD_TRACE = savedTrace;
});

function failOpenOf(filename: string, failures: Array<() => never>) {
  const open = jest.mocked(fs.openSync).getMockImplementation()!;
  jest.mocked(fs.openSync).mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (target === filename && failures.length) failures.shift()!();
    return (open as (...args: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
}

function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value) + (value instanceof Error ? value.message : '');
  expect(serialized).not.toContain(secret);
}

const values = members.map(() => ({ token: secret }));

it.each([['EBUSY', -4082], ['EPERM', -4048], ['EACCES', -4092]] as const)(
  'reads the whole set again after one %s while opening a member', async (code, number) => {
    failOpenOf(members[3], [() => { throw errno(code, number); }]);
    await expect(readPrivateApprovalSetAsync(members, undefined, roles)).resolves.toEqual(values);
    expect(fs.openSync).toHaveBeenCalledTimes(8);
    expect(windowsPrivateAuthorityStampAsync).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledWith('[private-approval-set-reader]', 'retry', expect.objectContaining({
      phase: 'contents', role: 'ledger', errorKind: code, errno: number, attempts: 1, delayMs: expect.any(Number) }));
    expect(warn).toHaveBeenCalledWith('[private-approval-set-reader]', expect.stringContaining('passed after 2 tries'));
    expectNoSecrets([info.mock.calls, warn.mock.calls]);
  });

it('recovers when a lookup is briefly refused while a member is replaced', async () => {
  let failures = 1;
  const lookup = jest.mocked(fs.lstatSync).getMockImplementation()!;
  jest.mocked(fs.lstatSync).mockImplementation(((filename: fs.PathLike, options?: unknown) => {
    if (filename === members[1] && failures-- > 0) throw errno('EPERM', -4048);
    return (lookup as (...args: unknown[]) => BigIntStats)(filename, options);
  }) as unknown as typeof fs.lstatSync);
  await expect(readPrivateApprovalSetAsync(members, undefined, roles)).resolves.toEqual(values);
});

it('recovers from a short read during an atomic replace', async () => {
  let shortReads = 1, read = false;
  jest.mocked(fs.openSync).mockImplementation(() => { read = false; return 42; });
  jest.mocked(fs.readSync).mockImplementation(((_fd: number, buffer: Buffer) => {
    if (read) return 0;
    read = true;
    if (shortReads > 0) { shortReads -= 1; contents.copy(buffer, 0, 0, 5); return 5; }
    contents.copy(buffer); return contents.length;
  }) as typeof fs.readSync);
  await expect(readPrivateApprovalSetAsync(members, undefined, roles)).resolves.toEqual(values);
  expect(info).toHaveBeenCalledWith('[private-approval-set-reader]', 'retry', expect.objectContaining({
    phase: 'contents', role: 'record', errorKind: 'HOST_SOURCE_CHANGED' }));
});

it.each(['spawn', 'stdin', 'exit', 'evidence'] as const)('runs the Windows permission helper again after a %s failure', async failure => {
  jest.mocked(windowsPrivateAuthorityStampAsync)
    .mockRejectedValueOnce(new WindowsAuthorityInspectionError('Windows authority inspection refused', failure));
  await expect(readPrivateApprovalSetAsync(members, undefined, roles)).resolves.toEqual(values);
  expect(windowsPrivateAuthorityStampAsync).toHaveBeenCalledTimes(3);
  expect(info).toHaveBeenCalledWith('[private-approval-set-reader]', 'retry', expect.objectContaining({ phase: 'native-before', nativeFailure: failure }));
});

it.each(['refused', 'deadline', 'bounds', 'cancelled', 'unavailable'] as const)('does not repeat a Windows %s answer', async failure => {
  jest.mocked(windowsPrivateAuthorityStampAsync)
    .mockRejectedValue(new WindowsAuthorityInspectionError('Windows authority inspection refused', failure));
  const refused = await readPrivateApprovalSetAsync(members, undefined, roles).catch(error => error);
  expect(refused).toBeInstanceOf(PrivateApprovalReadError);
  expect(refused.refusal).toMatchObject({ phase: 'native-before', role: 'set', nativeFailure: failure, attempts: 1 });
  expect(windowsPrivateAuthorityStampAsync).toHaveBeenCalledTimes(1);
  if (failure === 'refused') expect(refused.message).toContain('not private to this account');
});

it('a lasting lock still ends in a short, plain refusal that names the step, file and error', async () => {
  failOpenOf(members[3], Array.from({ length: 10 }, () => () => { throw errno('EBUSY', -4082); }));
  const started = Date.now();
  const refused = await readPrivateApprovalSetAsync(members, undefined, roles).catch(error => error);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(refused).toBeInstanceOf(PrivateApprovalReadError);
  expect(refused).toBeInstanceOf(TrustedHostMcpError);
  expect(refused).toMatchObject({ code: 'HOST_CONSENT_REQUIRED', refusal: {
    phase: 'contents', role: 'ledger', errorKind: 'EBUSY', errno: -4082, attempts: 4, cancelled: false } });
  expect(refused.message).toMatch(/^FLUJO refused a private approval check while reading the file for the private ledger file: EBUSY \(errno -4082\)\. It stopped after 4 tries in \d+ ms\. This is usually another program, such as antivirus or file indexing, holding the file\.$/);
  expect(refused).not.toHaveProperty('cause');
  expect(warn).toHaveBeenCalledWith('[private-approval-set-reader]', refused.message);
  expect(info.mock.calls.filter(call => call[1] === 'retry')).toHaveLength(3);
  expect(info).toHaveBeenCalledWith('[private-approval-set-reader]', 'refused', expect.objectContaining({ attempts: 4 }));
  expectNoSecrets([refused, info.mock.calls, warn.mock.calls]);
});

it('cancellation ends the wait at once and is never retried', async () => {
  const controller = new AbortController();
  failOpenOf(members[0], Array.from({ length: 10 }, () => () => {
    setTimeout(() => controller.abort(new Error(secret)), 5);
    throw errno('EBUSY', -4082);
  }));
  const refused = await readPrivateApprovalSetAsync(members, controller.signal, roles).catch(error => error);
  expect(refused).toBeInstanceOf(PrivateApprovalReadError);
  expect(refused.refusal).toMatchObject({ phase: 'contents', role: 'record', cancelled: true, attempts: 1 });
  expect(refused.message).toContain('the request was cancelled');
  expect(fs.openSync).toHaveBeenCalledTimes(1);
  expectNoSecrets(refused);
});

it('the single and pair readers use the same bounded retry', async () => {
  failOpenOf(members[2], [() => { throw errno('EBUSY', -4082); }, () => { throw errno('EBUSY', -4082); }]);
  await expect(readPrivateApprovalAsync(members[2])).resolves.toEqual({ token: secret });
  await expect(readPrivateApprovalPairAsync(members[2], members[3])).resolves.toEqual([{ token: secret }, { token: secret }]);
  expect(info).toHaveBeenCalledWith('[private-approval-reader]', 'retry', expect.objectContaining({ phase: 'contents', errorKind: 'EBUSY' }));
  await expect(readPrivateApprovalAsync(undefined)).rejects.toMatchObject({ refusal: { phase: 'input', attempts: 1 } });
  await expect(readPrivateApprovalPairAsync(members[2], undefined)).rejects.toBeInstanceOf(PrivateApprovalReadError);
});

it('the final synchronous set may be read again after anything but cancellation', () => {
  const cancelled = new AbortController(); cancelled.abort();
  expect(privateApprovalSetMayClearUp(errno('EBUSY', -4082))).toBe(true);
  expect(privateApprovalSetMayClearUp(new TrustedHostMcpError('HOST_CONSENT_REQUIRED'))).toBe(true);
  expect(privateApprovalSetMayClearUp(new WindowsAuthorityInspectionError('x', 'spawn'))).toBe(true);
  expect(privateApprovalSetMayClearUp(new WindowsAuthorityInspectionError('x', 'refused'))).toBe(false);
  expect(privateApprovalSetMayClearUp(errno('ENOENT', -4058))).toBe(false);
  expect(privateApprovalSetMayClearUp(errno('EBUSY', -4082), cancelled.signal)).toBe(false);
});

describe('Windows permission helper failures say whether a fresh attempt may pass', () => {
  const native = () => jest.requireActual<typeof import('@/backend/services/security/windowsPrivateAuthority')>(
    '@/backend/services/security/windowsPrivateAuthority');
  let savedSystemRoot: string | undefined;
  beforeEach(() => {
    savedSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = path.resolve('synthetic-system');
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats);
  });
  afterEach(() => {
    if (savedSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = savedSystemRoot;
  });

  function fakeChild(finish: (child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }) => void) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(),
      stdin: Object.assign(new EventEmitter(), { end: () => { setImmediate(() => finish(child)); } }),
    });
    return child as unknown as childProcess.ChildProcessWithoutNullStreams;
  }

  it('a process that cannot be created at all is reported, traced and transient', async () => {
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => { throw Object.assign(new Error(`spawn EPERM ${secret}`), { code: 'EPERM' }); });
    const failure = await native().windowsPrivateAuthorityStampAsync(members).catch(error => error);
    expect(failure).toBeInstanceOf(WindowsAuthorityInspectionError);
    expect(failure).toMatchObject({ nativeFailure: 'spawn', transient: true, code: 'EPERM' });
    expect(failure.message).not.toContain(secret);
    expect(info).toHaveBeenCalledWith('[private-authority-native]', 'refused', 'spawn');
  });

  it.each([
    ['owner-dacl', 1, 'refused', false], ['outsider-access', 1, 'refused', false], ['evidence-bounds', 1, 'refused', false],
    ['native-acl', 1, 'exit', true], ['', 3221225794, 'exit', true], ['', 0, 'evidence', true],
  ] as const)('native phase "%s" with exit %s is %s', async (phase, code, nativeFailure, transient) => {
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => fakeChild(child => {
      if (phase) child.stderr.emit('data', Buffer.from(`FLUJO_AUTHORITY_REFUSED:${phase}\n`));
      else child.stdout.emit('data', Buffer.from('not json'));
      child.emit('close', code, null);
    }));
    await expect(native().windowsPrivateAuthorityStampAsync(members)).rejects.toMatchObject({ nativeFailure, transient });
  });
});

it('package byte checks open a briefly locked file again, and a lasting lock stays a refusal', async () => {
  const directory = await fs.promises.mkdtemp(path.join(path.resolve(os.tmpdir()), 'flujo-transient-open-'));
  try {
    const executable = path.join(directory, 'synthetic-executable');
    await fs.promises.writeFile(executable, 'fingerprinted fixture; never executed');
    const expected = createHash('sha256').update('fingerprinted fixture; never executed').digest('hex');
    const open = fs.promises.open.bind(fs.promises);
    let locked = 1;
    const opens = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (locked > 0) { locked -= 1; throw errno('EBUSY', -4082); }
      return open(...args);
    });
    await expect(fingerprintTrustedHostExecutableAsync(executable)).resolves.toBe(expected);
    expect(opens).toHaveBeenCalledTimes(2);
    locked = 10;
    await expect(fingerprintTrustedHostExecutableAsync(executable)).rejects.toMatchObject({ code: 'HOST_SOURCE_CHANGED' });
    expect(opens).toHaveBeenCalledTimes(2 + 4);
  } finally {
    jest.restoreAllMocks();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

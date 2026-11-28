import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fileErrorCode, isTransientFileError, replaceFileWithRetry, retryTransientFileOperation,
  REPLACE_FILE_RETRY_DELAYS_MS, TRANSIENT_FILE_RETRY_DELAYS_MS,
} from '@/utils/transientFileRetry';

const errno = (code: string) => Object.assign(new Error(`${code}: synthetic`), { code });
const fast = [1, 1, 1];
const label = 'test-retry';

afterEach(() => { jest.restoreAllMocks(); });

it.each(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])('passes after one %s', async code => {
  const operation = jest.fn().mockRejectedValueOnce(errno(code)).mockResolvedValue('read');
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast })).resolves.toBe('read');
  expect(operation.mock.calls.map(call => call[0])).toEqual([1, 2]);
});

it('stops after the last wait and throws the final failure unchanged', async () => {
  const failures = [errno('EBUSY'), errno('EBUSY'), errno('EBUSY'), errno('EBUSY')];
  const operation = jest.fn(async (attempt: number) => { throw failures[attempt - 1]; });
  const retries = jest.fn();
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast, onRetry: retries })).rejects.toBe(failures[3]);
  expect(operation).toHaveBeenCalledTimes(4);
  expect(retries.mock.calls.map(([error, failed]) => [error, failed])).toEqual([[failures[0], 1], [failures[1], 2], [failures[2], 3]]);
});

it('keeps the default bounds short', () => {
  expect(TRANSIENT_FILE_RETRY_DELAYS_MS.length).toBe(3);
  expect(TRANSIENT_FILE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(1000);
  expect(REPLACE_FILE_RETRY_DELAYS_MS.length).toBe(14);
  expect(REPLACE_FILE_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(5);
  expect(REPLACE_FILE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(1500);
});

it.each(['ENOENT', 'EEXIST', 'EISDIR', undefined])('never retries %s', async code => {
  const failure = code ? errno(code) : new Error('plain');
  const operation = jest.fn().mockRejectedValue(failure);
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast })).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('ends the wait at once when the caller cancels, without another attempt', async () => {
  const controller = new AbortController();
  const failure = errno('EBUSY');
  const operation = jest.fn().mockRejectedValue(failure);
  const started = Date.now();
  const outcome = retryTransientFileOperation(operation, { label, signal: controller.signal, delaysMs: [60_000] });
  setTimeout(() => controller.abort(), 10);
  await expect(outcome).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(Date.now() - started).toBeLessThan(10_000);
});

it('continues from a failure the caller already met, waiting before the next attempt', async () => {
  const operation = jest.fn().mockResolvedValue('second');
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast, afterFailure: errno('EPERM') })).resolves.toBe('second');
  expect(operation).toHaveBeenCalledWith(2);
  const fixed = errno('ENOENT');
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast, afterFailure: fixed })).rejects.toBe(fixed);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('a throwing observer never changes the outcome', async () => {
  const operation = jest.fn().mockRejectedValueOnce(errno('EBUSY')).mockResolvedValue('read');
  await expect(retryTransientFileOperation(operation, { label, delaysMs: fast, onRetry: () => { throw new Error('observer'); } })).resolves.toBe('read');
});

it('asks a delay function after every failure and stops when it returns nothing', async () => {
  const asked: number[] = [];
  const failure = errno('EBUSY');
  const operation = jest.fn().mockRejectedValue(failure);
  await expect(retryTransientFileOperation(operation, { label, delaysMs: failed => { asked.push(failed); return failed < 3 ? 1 : undefined; } }))
    .rejects.toBe(failure);
  expect(asked).toEqual([1, 2, 3]);
  expect(operation).toHaveBeenCalledTimes(3);
});

it('waits on the caller clock when one is given, and still honours cancellation', async () => {
  const sleep = jest.fn(async () => {});
  const operation = jest.fn().mockRejectedValueOnce(errno('EPERM')).mockResolvedValue('done');
  await expect(retryTransientFileOperation(operation, { label, delaysMs: [25], sleep })).resolves.toBe('done');
  expect(sleep).toHaveBeenCalledWith(25);

  const controller = new AbortController();
  const failure = errno('EPERM');
  const cancelled = jest.fn().mockRejectedValue(failure);
  await expect(retryTransientFileOperation(cancelled, { label, delaysMs: [25, 25], signal: controller.signal,
    sleep: async () => { controller.abort(); } })).rejects.toBe(failure);
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it('adds bounded jitter to every wait', async () => {
  const waits: number[] = [];
  const operation = jest.fn().mockRejectedValueOnce(errno('EBUSY')).mockRejectedValueOnce(errno('EBUSY')).mockResolvedValue('ok');
  await retryTransientFileOperation(operation, { label, delaysMs: [5, 5], jitterMs: 10, sleep: async delay => { waits.push(delay); } });
  expect(waits).toHaveLength(2);
  for (const wait of waits) { expect(wait).toBeGreaterThanOrEqual(5); expect(wait).toBeLessThan(15); }
});

it('traces each retry by label and code only, and only while the diagnostics switch is on', async () => {
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const previous = process.env.FLUJO_MCP_WORKLOAD_TRACE;
  const secretPath = path.join(os.tmpdir(), 'private-owner-policy.json');
  const failure = Object.assign(new Error(`EBUSY: resource busy or locked, open '${secretPath}'`), { code: 'EBUSY', path: secretPath });
  try {
    delete process.env.FLUJO_MCP_WORKLOAD_TRACE;
    await retryTransientFileOperation(jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(1), { label: 'owner-policy', delaysMs: [1] });
    expect(info).not.toHaveBeenCalled();

    process.env.FLUJO_MCP_WORKLOAD_TRACE = '1';
    await retryTransientFileOperation(jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(1), { label: 'owner-policy', delaysMs: [1] });
    await retryTransientFileOperation(jest.fn().mockRejectedValueOnce({ error: errno('EPERM') }).mockResolvedValue(1),
      { label: 'private-approval', delaysMs: [1], isTransient: () => true });
    expect(info.mock.calls).toEqual([
      ['[transient-file-retry] owner-policy EBUSY after try 1, waiting 1 ms'],
      ['[transient-file-retry] private-approval EPERM after try 1, waiting 1 ms'],
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('private-owner-policy');
  } finally {
    if (previous === undefined) delete process.env.FLUJO_MCP_WORKLOAD_TRACE; else process.env.FLUJO_MCP_WORKLOAD_TRACE = previous;
  }
});

it('reads only an own data code and never runs a getter', () => {
  const getter = jest.fn(() => 'EBUSY');
  expect(fileErrorCode(Object.defineProperty(new Error('x'), 'code', { get: getter }))).toBeUndefined();
  expect(fileErrorCode(Object.create({ code: 'EBUSY' }))).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  expect(isTransientFileError(errno('EBUSY'))).toBe(true);
  expect(isTransientFileError('EBUSY')).toBe(false);
});

describe('replaceFileWithRetry', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-replace-retry-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('renames over a file once a reader that holds it open lets go', async () => {
    const target = path.join(root, 'ledger.json');
    const incoming = path.join(root, 'ledger.json.next');
    await fs.writeFile(target, 'previous');
    await fs.writeFile(incoming, 'next');
    // Windows refuses to rename over a file another handle has open (EPERM);
    // other systems allow it, so this checks the real behaviour where it exists.
    const reader = await fs.open(target, 'r');
    const released = new Promise<void>(resolve => setTimeout(() => { void reader.close().then(resolve); }, 40));
    await replaceFileWithRetry(incoming, target, { label });
    await released;
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('next');
    await expect(fs.readdir(root)).resolves.toEqual(['ledger.json']);
  });

  it('checks again before every attempt and stops at a refusal that is not short-lived', async () => {
    const realRename = fs.rename.bind(fs);
    let conflicts = 0;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (conflicts++ < 2) throw errno('EPERM');
      return realRename(from, to);
    });
    const target = path.join(root, 'state.json');
    await fs.writeFile(path.join(root, 'next'), 'new');
    const checks = jest.fn(async () => {});
    await replaceFileWithRetry(path.join(root, 'next'), target, { label, beforeAttempt: checks });
    expect(checks).toHaveBeenCalledTimes(3);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new');

    await fs.writeFile(path.join(root, 'again'), 'newer');
    conflicts = 0;
    const revoked = new Error('authority retired');
    let checked = 0;
    await expect(replaceFileWithRetry(path.join(root, 'again'), target, { label,
      beforeAttempt: async () => { if (checked++ > 0) throw revoked; } })).rejects.toBe(revoked);
    expect(checked).toBe(2);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new');
  });

  it('never deletes the target to make room and gives up after its bound', async () => {
    const failure = errno('EPERM');
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(failure);
    const target = path.join(root, 'kept.json');
    await fs.writeFile(target, 'kept');
    await expect(replaceFileWithRetry(path.join(root, 'missing'), target, { label })).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledTimes(REPLACE_FILE_RETRY_DELAYS_MS.length + 1);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('kept');
  });
});

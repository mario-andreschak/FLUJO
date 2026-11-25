import { fileErrorCode, isTransientFileError, retryTransientFileOperation, TRANSIENT_FILE_RETRY_DELAYS_MS } from '@/utils/transientFileRetry';

const errno = (code: string) => Object.assign(new Error(`${code}: synthetic`), { code });
const fast = [1, 1, 1];

it.each(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])('passes after one %s', async code => {
  const operation = jest.fn().mockRejectedValueOnce(errno(code)).mockResolvedValue('read');
  await expect(retryTransientFileOperation(operation, { delaysMs: fast })).resolves.toBe('read');
  expect(operation.mock.calls.map(call => call[0])).toEqual([1, 2]);
});

it('stops after the last wait and throws the final failure unchanged', async () => {
  const failures = [errno('EBUSY'), errno('EBUSY'), errno('EBUSY'), errno('EBUSY')];
  const operation = jest.fn(async (attempt: number) => { throw failures[attempt - 1]; });
  const retries = jest.fn();
  await expect(retryTransientFileOperation(operation, { delaysMs: fast, onRetry: retries })).rejects.toBe(failures[3]);
  expect(operation).toHaveBeenCalledTimes(4);
  expect(retries.mock.calls.map(([error, failed]) => [error, failed])).toEqual([[failures[0], 1], [failures[1], 2], [failures[2], 3]]);
});

it('keeps the default bound short', () => {
  expect(TRANSIENT_FILE_RETRY_DELAYS_MS.length).toBe(3);
  expect(TRANSIENT_FILE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(1000);
});

it.each(['ENOENT', 'EEXIST', 'EISDIR', undefined])('never retries %s', async code => {
  const failure = code ? errno(code) : new Error('plain');
  const operation = jest.fn().mockRejectedValue(failure);
  await expect(retryTransientFileOperation(operation, { delaysMs: fast })).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('ends the wait at once when the caller cancels, without another attempt', async () => {
  const controller = new AbortController();
  const failure = errno('EBUSY');
  const operation = jest.fn().mockRejectedValue(failure);
  const started = Date.now();
  const outcome = retryTransientFileOperation(operation, { signal: controller.signal, delaysMs: [60_000] });
  setTimeout(() => controller.abort(), 10);
  await expect(outcome).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(Date.now() - started).toBeLessThan(10_000);
});

it('continues from a failure the caller already met, waiting before the next attempt', async () => {
  const operation = jest.fn().mockResolvedValue('second');
  await expect(retryTransientFileOperation(operation, { delaysMs: fast, afterFailure: errno('EPERM') })).resolves.toBe('second');
  expect(operation).toHaveBeenCalledWith(2);
  const fixed = errno('ENOENT');
  await expect(retryTransientFileOperation(operation, { delaysMs: fast, afterFailure: fixed })).rejects.toBe(fixed);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('a throwing observer never changes the outcome', async () => {
  const operation = jest.fn().mockRejectedValueOnce(errno('EBUSY')).mockResolvedValue('read');
  await expect(retryTransientFileOperation(operation, { delaysMs: fast, onRetry: () => { throw new Error('observer'); } })).resolves.toBe('read');
});

it('reads only an own data code and never runs a getter', () => {
  const getter = jest.fn(() => 'EBUSY');
  expect(fileErrorCode(Object.defineProperty(new Error('x'), 'code', { get: getter }))).toBeUndefined();
  expect(fileErrorCode(Object.create({ code: 'EBUSY' }))).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  expect(isTransientFileError(errno('EBUSY'))).toBe(true);
  expect(isTransientFileError('EBUSY')).toBe(false);
});

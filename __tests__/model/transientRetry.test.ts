/**
 * Unit tests for src/backend/utils/transientRetry.ts
 *
 * Uses jest.useFakeTimers() so back-off delays do not slow down the test suite.
 * All tests are fully self-contained with no network calls.
 */

// Suppress logger output during tests.
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { isTransientTransportError, withTransientRetry } from '@/backend/utils/transientRetry';

// ---------------------------------------------------------------------------
// isTransientTransportError
// ---------------------------------------------------------------------------

describe('isTransientTransportError', () => {
  describe('returns true for known transient transport error messages', () => {
    it.each([
      ['ECONNRESET', 'read ECONNRESET'],
      [
        'Invalid response body',
        'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: read ECONNRESET',
      ],
      ['socket hang up', 'socket hang up'],
      ['premature close', 'premature close'],
      ['ETIMEDOUT (upper-case)', 'connect ETIMEDOUT 1.2.3.4:443'],
      ['etimedout (lower-case)', 'etimedout'],
    ])('%s', (_label, message) => {
      expect(isTransientTransportError(new Error(message))).toBe(true);
    });
  });

  describe('returns false for non-transient errors', () => {
    it('returns false for AbortError (error.name === "AbortError")', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      expect(isTransientTransportError(err)).toBe(false);
    });

    it('returns false for AuthenticationError messages', () => {
      expect(
        isTransientTransportError(new Error('401 Unauthorized: Invalid API key.'))
      ).toBe(false);
    });

    it('returns false for plain TypeError with a non-transient message', () => {
      expect(
        isTransientTransportError(
          new TypeError('Cannot read properties of undefined (reading "choices")')
        )
      ).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isTransientTransportError('econnreset')).toBe(false);
      expect(isTransientTransportError(null)).toBe(false);
      expect(isTransientTransportError(undefined)).toBe(false);
      expect(isTransientTransportError(42)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// withTransientRetry
// ---------------------------------------------------------------------------

describe('withTransientRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately when fn succeeds on the first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const result = await withTransientRetry(fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds when fn fails once with a transient error', async () => {
    const transientErr = new Error('read ECONNRESET');
    const fn = jest.fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce('ok');

    const resultPromise = withTransientRetry(fn, { baseDelayMs: 500 });
    // Advance fake timers so the back-off delay resolves and fn is retried.
    await jest.runAllTimersAsync();

    expect(await resultPromise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-throws the last error after all attempts are exhausted', async () => {
    const transientErr = new Error('socket hang up');
    const fn = jest.fn().mockRejectedValue(transientErr);

    const resultPromise = withTransientRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow('socket hang up');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry when the error is non-transient', async () => {
    const nonTransientErr = new Error('401 Unauthorized: Invalid API key.');
    const fn = jest.fn().mockRejectedValue(nonTransientErr);

    await expect(withTransientRetry(fn)).rejects.toThrow('401 Unauthorized');
    // fn must have been called exactly once — no retry.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the AbortSignal is already aborted before any attempt', async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = jest.fn().mockResolvedValue('ok');
    await expect(
      withTransientRetry(fn, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    // fn must not have been called at all.
    expect(fn).not.toHaveBeenCalled();
  });
});

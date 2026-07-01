import { isAuthRequiredError, isTransientStreamError } from '@/utils/mcp/utils';

describe('isTransientStreamError', () => {
  it('matches the SDK SSE-disconnect signatures (self-healing, non-fatal)', () => {
    const transient = [
      new Error('SSE stream disconnected: TypeError: terminated'),
      new Error('Failed to reconnect SSE stream: something'),
      new Error('Maximum reconnection attempts (2) exceeded.'),
      new Error('TypeError: terminated'),
    ];
    for (const err of transient) {
      expect(isTransientStreamError(err)).toBe(true);
    }
  });

  it('does not match genuine connection failures', () => {
    const fatal = [
      new Error('fetch failed'),
      new Error('ECONNREFUSED 127.0.0.1:3000'),
      new Error('self-signed certificate in chain'),
      new Error('HTTP 500 Internal Server Error'),
      new Error('unable to verify the first certificate'),
    ];
    for (const err of fatal) {
      expect(isTransientStreamError(err)).toBe(false);
    }
  });

  it('handles non-Error values without throwing', () => {
    expect(isTransientStreamError('SSE stream disconnected: terminated')).toBe(true);
    expect(isTransientStreamError(undefined)).toBe(false);
    expect(isTransientStreamError(null)).toBe(false);
  });

  it('does not misclassify a transient stream error as an auth error (and vice versa)', () => {
    const sse = new Error('SSE stream disconnected: TypeError: terminated');
    expect(isAuthRequiredError(sse)).toBe(false);

    const unauthorized = new Error('HTTP 401 Unauthorized');
    expect(isTransientStreamError(unauthorized)).toBe(false);
  });
});
